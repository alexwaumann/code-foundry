// Package proxyfetch makes the HTTP requests a page asks for with the bridge's cf.fetch
// (docs/notes/bridge-fetch.md). A page's own fetch to an API that does not allow the pages
// origin is refused by the browser's CORS check, whatever token it carries; the daemon is
// not a browser, so the page asks it instead. This is the one HTTP client for that:
// ThreadService.ProxyFetch (internal/api) only maps its errors.
//
// What it sends: the page's method, headers and body, plus a User-Agent of
// code-foundry/<version> unless the page set one. Never a cookie (no jar, and a Cookie
// header is refused), an Origin, or a Code Foundry token. No proxy from the environment:
// the destination check below must see the address actually dialed.
//
// Destinations: any http or https host except an address that reaches this Mac's own
// services: loopback (127.0.0.0/8, ::1), unspecified (0.0.0.0/8, ::), link-local
// (169.254.0.0/16, fe80::/10, which holds cloud metadata endpoints), and any address of
// this machine on the daemon's own API or pages port. Other private ranges (10/8,
// 172.16/12, 192.168/16, fc00::/7) stay allowed on purpose: a company's internal APIs live
// there, and they are what a page is for. The host is resolved by the client's own dialer,
// every address checked before any is dialed, and only those addresses dialed (so a
// DNS answer that changes between a check and the connection cannot reach loopback); the
// dialer's Control checks the dialed address once more.
package proxyfetch

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	// MaxRequestBody is the largest body a page may send.
	MaxRequestBody = 1 << 20
	// MaxResponseBody is the largest body a page gets back; past it the call fails.
	MaxResponseBody = 8 << 20
	// DefaultTimeout is a request's timeout when the page gives none.
	DefaultTimeout = 30 * time.Second
	// MaxTimeout is the longest timeout a page may ask for; longer ones are cut to it.
	MaxTimeout = 120 * time.Second
	// MaxRedirects is how many redirects a request follows.
	MaxRedirects = 5
	// PerThread is how many requests a thread's pages have in flight at once; more wait.
	PerThread = 8
)

// Kind is what went wrong, as the bridge reports it.
type Kind int

const (
	// Invalid: the page's request (URL, scheme, header, body size, destination).
	Invalid Kind = iota + 1
	// Failed: the request was made and did not get an answer (network, TLS, redirects).
	Failed
	// Timeout: no whole answer within the request's timeout.
	Timeout
	// TooLarge: the response body is past MaxResponseBody.
	TooLarge
)

// Error is a request the client refused or could not complete. Its message names the
// host, never the URL's path or query (they may hold a token).
type Error struct {
	Kind Kind
	Msg  string
	Err  error
}

func (e *Error) Error() string { return e.Msg }
func (e *Error) Unwrap() error { return e.Err }

func errorf(k Kind, err error, format string, args ...any) *Error {
	return &Error{Kind: k, Msg: fmt.Sprintf(format, args...), Err: err}
}

// Request is one request a page asks for.
type Request struct {
	// Thread is the page's thread: the PerThread cap counts by it.
	Thread string
	URL    string
	// Method is GET when empty.
	Method string
	Header map[string]string
	Body   []byte
	// Timeout is DefaultTimeout when zero, MaxTimeout at most. It covers the wait for a
	// place under PerThread too.
	Timeout time.Duration
}

// Response is the answer, whatever its status.
type Response struct {
	Status     int
	StatusText string
	// Header is lower-case name → value, several values joined with ", ". No Set-Cookie.
	Header map[string]string
	Body   []byte
	// URL is the URL that answered, after redirects.
	URL string
}

// Options configure a Client.
type Options struct {
	// UserAgent is sent unless the page sets one.
	UserAgent string
	// OwnPorts are the daemon's own listeners' ports, refused on any address of this machine.
	OwnPorts []int
	// Allow are addresses let through despite the rules (tests: an httptest server on loopback).
	Allow []netip.AddrPort
	// Lookup resolves a host; nil is the system resolver. An IP literal must resolve to itself.
	Lookup func(ctx context.Context, host string) ([]netip.Addr, error)
	// Local lists this machine's addresses; nil reads the interfaces.
	Local func() ([]netip.Addr, error)
	Log   *slog.Logger
}

// Client makes pages' requests. Safe for concurrent use.
type Client struct {
	o      Options
	dialer *net.Dialer
	http   *http.Client

	mu    sync.Mutex
	slots map[string]*slot
}

type slot struct {
	ch    chan struct{}
	users int
}

// New returns a Client.
func New(o Options) *Client {
	if o.Lookup == nil {
		o.Lookup = func(ctx context.Context, host string) ([]netip.Addr, error) {
			return net.DefaultResolver.LookupNetIP(ctx, "ip", host)
		}
	}
	if o.Local == nil {
		o.Local = interfaceAddrs
	}
	if o.Log == nil {
		o.Log = slog.New(slog.DiscardHandler)
	}
	c := &Client{o: o, slots: map[string]*slot{}}
	c.dialer = &net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second, Control: c.control}
	c.http = &http.Client{
		Transport: &http.Transport{
			Proxy:                 nil,
			DialContext:           c.dial,
			ForceAttemptHTTP2:     true,
			TLSHandshakeTimeout:   15 * time.Second,
			MaxIdleConnsPerHost:   4,
			IdleConnTimeout:       90 * time.Second,
			ExpectContinueTimeout: time.Second,
		},
		CheckRedirect: checkRedirect,
	}
	return c
}

// Close drops idle connections.
func (c *Client) Close() { c.http.CloseIdleConnections() }

// refusedHeaders are headers a page may not set: the daemon sends no cookie and no Origin,
// and the transport owns the rest. Accept-Encoding is dropped instead (the transport asks
// for gzip and decodes it).
var refusedHeaders = []string{"cookie", "cookie2", "origin", "host", "content-length", "connection", "transfer-encoding",
	"te", "trailer", "upgrade", "keep-alive", "expect"}

func checkRedirect(req *http.Request, via []*http.Request) error {
	if len(via) > MaxRedirects {
		return errorf(Failed, nil, "%s redirected more than %d times; not followed", via[0].URL.Host, MaxRedirects)
	}
	if req.URL.Scheme != via[0].URL.Scheme {
		return errorf(Failed, nil, "%s redirected from %s to %s (%s); only same-scheme redirects are followed",
			via[0].URL.Host, via[0].URL.Scheme, req.URL.Scheme, req.URL.Host)
	}
	return nil
}

// Do makes the request. A non-2xx status is a Response; an *Error, or the context's error
// when ctx ends first, otherwise.
func (c *Client) Do(ctx context.Context, r Request) (Response, error) {
	u, err := url.Parse(r.URL)
	if err != nil || !u.IsAbs() || u.Host == "" {
		return Response{}, errorf(Invalid, nil, "%q is not an absolute http or https URL", clip(r.URL))
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return Response{}, errorf(Invalid, nil, "only http and https URLs are fetched, not %s:", u.Scheme)
	}
	if u.User != nil {
		return Response{}, errorf(Invalid, nil, "a URL with a user or password (%s); send credentials in a header", u.Host)
	}
	method := strings.ToUpper(r.Method)
	if method == "" {
		method = http.MethodGet
	}
	if !token(method) {
		return Response{}, errorf(Invalid, nil, "%q is not an HTTP method", clip(r.Method))
	}
	if len(r.Body) > MaxRequestBody {
		return Response{}, errorf(Invalid, nil, "the request body is %d bytes; %d at most (1 MiB)", len(r.Body), MaxRequestBody)
	}
	if len(r.Body) > 0 && (method == http.MethodGet || method == http.MethodHead) {
		return Response{}, errorf(Invalid, nil, "a %s request has no body", method)
	}
	h := http.Header{}
	for k, v := range r.Header {
		name := strings.ToLower(k)
		switch {
		case !token(k):
			return Response{}, errorf(Invalid, nil, "%q is not a header name", clip(k))
		case strings.ContainsAny(v, "\r\n\x00"):
			return Response{}, errorf(Invalid, nil, "the %s header's value has a line break", k)
		case slices.Contains(refusedHeaders, name) || strings.HasPrefix(name, "proxy-"):
			return Response{}, errorf(Invalid, nil, "the %s header is not sent (no cookies, no Origin; the daemon sets the rest)", k)
		case name == "accept-encoding":
			continue
		}
		h.Set(k, v)
	}
	if h.Get("User-Agent") == "" && c.o.UserAgent != "" {
		h.Set("User-Agent", c.o.UserAgent)
	}
	timeout := r.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	timeout = min(timeout, MaxTimeout)

	tctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	timedOut := func(err error) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return errorf(Timeout, err, "%s did not answer in %s", u.Host, seconds(timeout))
	}
	release, err := c.acquire(tctx, r.Thread)
	if err != nil {
		return Response{}, timedOut(err)
	}
	defer release()

	var body io.Reader = http.NoBody
	if len(r.Body) > 0 {
		body = bytes.NewReader(r.Body)
	}
	req, err := http.NewRequestWithContext(tctx, method, u.String(), body)
	if err != nil {
		return Response{}, errorf(Invalid, err, "cannot make the request to %s", u.Host)
	}
	req.Header = h
	start := time.Now()
	resp, err := c.http.Do(req)
	if err != nil {
		var fe *Error
		switch {
		case errors.As(err, &fe):
			c.logged(method, u.Host, 0, start, fe.Msg)
			return Response{}, fe
		case tctx.Err() != nil:
			return Response{}, timedOut(err)
		}
		// The url.Error's own text repeats the URL, query and all: keep only its cause.
		cause := err
		var ue *url.Error
		if errors.As(err, &ue) {
			cause = ue.Err
		}
		c.logged(method, u.Host, 0, start, cause.Error())
		return Response{}, errorf(Failed, err, "%s %s failed: %v", method, u.Host, cause)
	}
	defer func() { _ = resp.Body.Close() }()
	data, err := io.ReadAll(io.LimitReader(resp.Body, MaxResponseBody+1))
	if err != nil {
		if tctx.Err() != nil {
			return Response{}, timedOut(err)
		}
		return Response{}, errorf(Failed, err, "reading %s's answer failed: %v", u.Host, err)
	}
	c.logged(method, u.Host, resp.StatusCode, start, "")
	if len(data) > MaxResponseBody {
		return Response{}, errorf(TooLarge, nil, "%s answered more than %d bytes (8 MiB); ask for less (a page, a filter)", u.Host, MaxResponseBody)
	}
	out := Response{Status: resp.StatusCode, StatusText: strings.TrimSpace(strings.TrimPrefix(resp.Status, strconv.Itoa(resp.StatusCode))),
		Header: map[string]string{}, Body: data, URL: resp.Request.URL.String()}
	for k, vs := range resp.Header {
		name := strings.ToLower(k)
		if name == "set-cookie" || name == "set-cookie2" {
			continue
		}
		out.Header[name] = strings.Join(vs, ", ")
	}
	return out, nil
}

// logged logs a request at debug: method, host, status and duration, never its headers,
// body, path or query (they carry tokens).
func (c *Client) logged(method, host string, status int, start time.Time, failure string) {
	args := []any{"method", method, "host", host, "duration_ms", time.Since(start).Milliseconds()}
	if status > 0 {
		args = append(args, "status", status)
	}
	if failure != "" {
		args = append(args, "err", failure)
	}
	c.o.Log.Debug("page fetch", args...)
}

// acquire takes one of the thread's PerThread places, waiting while ctx lasts.
func (c *Client) acquire(ctx context.Context, thread string) (func(), error) {
	c.mu.Lock()
	s := c.slots[thread]
	if s == nil {
		s = &slot{ch: make(chan struct{}, PerThread)}
		c.slots[thread] = s
	}
	s.users++
	c.mu.Unlock()
	leave := func() {
		c.mu.Lock()
		if s.users--; s.users == 0 {
			delete(c.slots, thread)
		}
		c.mu.Unlock()
	}
	select {
	case s.ch <- struct{}{}:
		return func() { <-s.ch; leave() }, nil
	case <-ctx.Done():
		leave()
		return nil, ctx.Err()
	}
}

// dial resolves addr's host, refuses it when any of its addresses is refused, and dials
// those addresses in turn: the addresses checked are the ones dialed.
func (c *Client) dial(ctx context.Context, network, addr string) (net.Conn, error) {
	host, portText, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	port, err := strconv.ParseUint(portText, 10, 16)
	if err != nil {
		return nil, err
	}
	ips, err := c.o.Lookup(ctx, host)
	if err != nil {
		return nil, err
	}
	if len(ips) == 0 {
		return nil, fmt.Errorf("no address for %s", host)
	}
	addrs := make([]netip.AddrPort, len(ips))
	for i, ip := range ips {
		addrs[i] = netip.AddrPortFrom(ip.Unmap(), uint16(port))
		if err := c.check(host, addrs[i]); err != nil {
			return nil, err
		}
	}
	var first error
	for _, a := range addrs {
		conn, err := c.dialer.DialContext(ctx, network, a.String())
		if err == nil {
			return conn, nil
		}
		if first == nil {
			first = err
		}
		if ctx.Err() != nil {
			break
		}
	}
	return nil, first
}

// control checks the address the socket connects to, once more.
func (c *Client) control(_, address string, _ syscall.RawConn) error {
	a, err := netip.ParseAddrPort(address)
	if err != nil {
		return err
	}
	return c.check(a.Addr().String(), netip.AddrPortFrom(a.Addr().Unmap(), a.Port()))
}

// check refuses an address the rules (the package comment) refuse.
func (c *Client) check(host string, a netip.AddrPort) error {
	if slices.Contains(c.o.Allow, a) {
		return nil
	}
	if why := refusedAddr(a.Addr()); why != "" {
		return errorf(Invalid, nil, "%s is %s (%s), which a page may not reach", host, why, a.Addr())
	}
	if slices.Contains(c.o.OwnPorts, int(a.Port())) {
		local, err := c.o.Local()
		if err == nil && slices.Contains(local, a.Addr()) {
			return errorf(Invalid, nil, "%s:%d is Code Foundry's own listener", host, a.Port())
		}
	}
	return nil
}

var (
	thisNetwork = netip.MustParsePrefix("0.0.0.0/8")
	nat64       = netip.MustParsePrefix("64:ff9b::/96")
)

// refusedAddr names why ip is refused, or "" when it is allowed.
func refusedAddr(ip netip.Addr) string {
	ip = ip.Unmap()
	if nat64.Contains(ip) {
		b := ip.As16()
		ip = netip.AddrFrom4([4]byte(b[12:]))
	}
	switch {
	case ip.IsLoopback():
		return "a loopback address"
	case ip.IsUnspecified() || thisNetwork.Contains(ip):
		return "an unspecified address"
	case ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsInterfaceLocalMulticast():
		return "a link-local address"
	}
	return ""
}

func interfaceAddrs() ([]netip.Addr, error) {
	as, err := net.InterfaceAddrs()
	if err != nil {
		return nil, err
	}
	var out []netip.Addr
	for _, a := range as {
		if n, ok := a.(*net.IPNet); ok {
			if ip, ok := netip.AddrFromSlice(n.IP); ok {
				out = append(out, ip.Unmap())
			}
		}
	}
	return out, nil
}

// token reports whether s is an HTTP token (RFC 9110): a method or a header name.
func token(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		b := s[i]
		ok := b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z' || b >= '0' && b <= '9' || strings.IndexByte("!#$%&'*+-.^_`|~", b) >= 0
		if !ok {
			return false
		}
	}
	return true
}

func clip(s string) string {
	if len(s) > 80 {
		return s[:80] + "…"
	}
	return s
}

func seconds(d time.Duration) string {
	if d%time.Second == 0 {
		return strconv.Itoa(int(d/time.Second)) + " s"
	}
	return strconv.FormatFloat(d.Seconds(), 'f', 1, 64) + " s"
}
