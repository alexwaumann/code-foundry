package proxyfetch

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestRefusedAddr(t *testing.T) {
	for _, tc := range []struct {
		ip      string
		refused bool
	}{
		{"127.0.0.1", true},
		{"127.1.2.3", true},
		{"::1", true},
		{"::ffff:127.0.0.1", true},
		{"64:ff9b::7f00:1", true}, // NAT64 of 127.0.0.1
		{"0.0.0.0", true},
		{"0.1.2.3", true},
		{"::", true},
		{"169.254.169.254", true},
		{"fe80::1", true},
		// Private ranges are where internal APIs live: allowed.
		{"10.0.0.1", false},
		{"172.16.0.1", false},
		{"192.168.1.1", false},
		{"fc00::1", false},
		{"100.64.0.1", false},
		{"8.8.8.8", false},
		{"2606:4700::1111", false},
	} {
		got := refusedAddr(netip.MustParseAddr(tc.ip)) != ""
		if got != tc.refused {
			t.Errorf("refusedAddr(%s) refused = %v, want %v", tc.ip, got, tc.refused)
		}
	}
}

// The daemon's own ports are refused on this machine's addresses only.
func TestCheckOwnPorts(t *testing.T) {
	c := New(Options{OwnPorts: []int{4000, 4001}, Local: func() ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("192.168.1.5")}, nil
	}})
	for _, tc := range []struct {
		addr    string
		refused bool
	}{
		{"192.168.1.5:4000", true},
		{"192.168.1.5:4001", true},
		{"192.168.1.5:4002", false},
		{"192.168.1.6:4000", false},
		{"127.0.0.1:4002", true},
	} {
		err := c.check("h", netip.MustParseAddrPort(tc.addr))
		if (err != nil) != tc.refused {
			t.Errorf("check(%s) = %v, want refused %v", tc.addr, err, tc.refused)
		}
	}
}

// literal resolves an IP literal to itself, as the system resolver does.
func literal(host string) ([]netip.Addr, error) {
	a, err := netip.ParseAddr(host)
	if err != nil {
		return nil, err
	}
	return []netip.Addr{a}, nil
}

func kindOf(err error) Kind {
	var fe *Error
	if errors.As(err, &fe) {
		return fe.Kind
	}
	return 0
}

// Requests refused before anything is sent.
func TestDoRefuses(t *testing.T) {
	c := New(Options{Lookup: func(_ context.Context, host string) ([]netip.Addr, error) {
		switch host {
		case "rebind.test":
			return []netip.Addr{netip.MustParseAddr("8.8.8.8"), netip.MustParseAddr("127.0.0.1")}, nil
		case "meta.test":
			return []netip.Addr{netip.MustParseAddr("169.254.169.254")}, nil
		}
		return literal(host)
	}})
	big := make([]byte, MaxRequestBody+1)
	for _, tc := range []struct {
		name string
		req  Request
		want string
	}{
		{"not a URL", Request{URL: "::nope"}, "not an absolute"},
		{"relative", Request{URL: "/api/issues"}, "not an absolute"},
		{"scheme", Request{URL: "ftp://example.com/x"}, "not ftp:"},
		{"file", Request{URL: "file:///etc/passwd"}, "not an absolute"},
		{"credentials", Request{URL: "https://u:p@example.com/"}, "send credentials in a header"},
		{"method", Request{URL: "https://example.com/", Method: "GE T"}, "not an HTTP method"},
		{"GET body", Request{URL: "https://example.com/", Body: []byte("x")}, "has no body"},
		{"body cap", Request{URL: "https://example.com/", Method: "POST", Body: big}, "1 MiB"},
		{"cookie", Request{URL: "https://example.com/", Header: map[string]string{"Cookie": "a=b"}}, "Cookie header is not sent"},
		{"origin", Request{URL: "https://example.com/", Header: map[string]string{"origin": "x"}}, "origin header is not sent"},
		{"host", Request{URL: "https://example.com/", Header: map[string]string{"Host": "x"}}, "not sent"},
		{"proxy", Request{URL: "https://example.com/", Header: map[string]string{"Proxy-Authorization": "x"}}, "not sent"},
		{"header name", Request{URL: "https://example.com/", Header: map[string]string{"a b": "x"}}, "not a header name"},
		{"header value", Request{URL: "https://example.com/", Header: map[string]string{"X-A": "x\r\nB: y"}}, "line break"},
		{"loopback", Request{URL: "http://127.0.0.1:9/"}, "loopback"},
		{"loopback v6", Request{URL: "http://[::1]:9/"}, "loopback"},
		{"unspecified", Request{URL: "http://0.0.0.0:9/"}, "unspecified"},
		{"link-local", Request{URL: "http://meta.test/latest/meta-data/"}, "link-local"},
		// One refused address refuses the host, before any is dialed.
		{"one of several", Request{URL: "https://rebind.test/"}, "rebind.test is a loopback address"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := c.Do(context.Background(), tc.req)
			if kindOf(err) != Invalid || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("Do = %v (kind %d), want Invalid with %q", err, kindOf(err), tc.want)
			}
		})
	}
}

// upstream is an httptest server the client may reach, at a name of its own.
func upstream(t *testing.T, h http.HandlerFunc) (*Client, string) {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	ap := netip.MustParseAddrPort(strings.TrimPrefix(srv.URL, "http://"))
	c := New(Options{UserAgent: "code-foundry/test", Allow: []netip.AddrPort{ap}, Lookup: func(_ context.Context, host string) ([]netip.Addr, error) {
		if host == "api.test" {
			return []netip.Addr{ap.Addr()}, nil
		}
		return literal(host)
	}})
	t.Cleanup(c.Close)
	return c, fmt.Sprintf("http://api.test:%d", ap.Port())
}

func TestDoSends(t *testing.T) {
	var got http.Header
	var gotBody, gotHost string
	c, base := upstream(t, func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
		b, _ := io.ReadAll(r.Body)
		gotBody, gotHost = string(b), r.Host
		w.Header().Set("X-Total", "3")
		w.Header().Add("Vary", "a")
		w.Header().Add("Vary", "b")
		http.SetCookie(w, &http.Cookie{Name: "s", Value: "secret"})
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, `{"ok":true}`)
	})
	res, err := c.Do(context.Background(), Request{URL: base + "/issues?token=x", Method: "post", Body: []byte(`{"q":1}`),
		Header: map[string]string{"Authorization": "Bearer t", "Content-Type": "application/json", "Accept-Encoding": "br"}})
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != 201 || res.StatusText != "Created" || string(res.Body) != `{"ok":true}` {
		t.Errorf("response %d %q %q", res.Status, res.StatusText, res.Body)
	}
	if res.Header["x-total"] != "3" || res.Header["vary"] != "a, b" || res.Header["set-cookie"] != "" {
		t.Errorf("response headers %v", res.Header)
	}
	if gotHost != strings.TrimPrefix(base, "http://") || gotBody != `{"q":1}` {
		t.Errorf("host %q body %q", gotHost, gotBody)
	}
	if got.Get("Authorization") != "Bearer t" || got.Get("User-Agent") != "code-foundry/test" {
		t.Errorf("headers sent %v", got)
	}
	for _, h := range []string{"Cookie", "Origin", "Referer"} {
		if got.Get(h) != "" {
			t.Errorf("sent %s: %q", h, got.Get(h))
		}
	}
	if got.Get("Accept-Encoding") == "br" {
		t.Error("the page's Accept-Encoding was sent")
	}

	// A page's own User-Agent wins; a 404 is a response, not an error.
	c2, base2 := upstream(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-UA", r.UserAgent())
		http.NotFound(w, r)
	})
	res, err = c2.Do(context.Background(), Request{URL: base2 + "/x", Header: map[string]string{"user-agent": "mine"}})
	if err != nil || res.Status != 404 || res.Header["x-ua"] != "mine" {
		t.Errorf("404 = %+v, %v", res, err)
	}
}

func TestDoRedirects(t *testing.T) {
	var base string
	c, b := upstream(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/hop/"):
			var n int
			_, _ = fmt.Sscanf(r.URL.Path, "/hop/%d", &n)
			if n == 0 {
				_, _ = io.WriteString(w, "landed "+r.Header.Get("Authorization"))
				return
			}
			http.Redirect(w, r, fmt.Sprintf("/hop/%d", n-1), http.StatusFound)
		case r.URL.Path == "/https":
			http.Redirect(w, r, strings.Replace(base, "http:", "https:", 1)+"/hop/0", http.StatusFound)
		case r.URL.Path == "/loopback":
			http.Redirect(w, r, "http://127.0.0.2:9/", http.StatusFound)
		}
	})
	base = b
	for _, tc := range []struct {
		path string
		kind Kind
		want string
	}{
		{"/hop/5", 0, "landed Bearer t"},
		{"/hop/6", Failed, "more than 5"},
		{"/https", Failed, "from http to https"},
		{"/loopback", Invalid, "loopback"},
	} {
		res, err := c.Do(context.Background(), Request{URL: base + tc.path, Header: map[string]string{"Authorization": "Bearer t"}})
		if tc.kind == 0 {
			if err != nil || string(res.Body) != tc.want || !strings.HasSuffix(res.URL, "/hop/0") {
				t.Errorf("%s = %q at %s, %v", tc.path, res.Body, res.URL, err)
			}
			continue
		}
		if kindOf(err) != tc.kind || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s = %v, want kind %d with %q", tc.path, err, tc.kind, tc.want)
		}
	}
}

func TestDoResponseCap(t *testing.T) {
	c, base := upstream(t, func(w http.ResponseWriter, r *http.Request) {
		n := MaxResponseBody
		if r.URL.Path == "/over" {
			n++
		}
		_, _ = w.Write(make([]byte, n))
	})
	if res, err := c.Do(context.Background(), Request{URL: base + "/at"}); err != nil || len(res.Body) != MaxResponseBody {
		t.Errorf("at the cap: %d bytes, %v", len(res.Body), err)
	}
	if _, err := c.Do(context.Background(), Request{URL: base + "/over"}); kindOf(err) != TooLarge || !strings.Contains(err.Error(), "8 MiB") {
		t.Errorf("over the cap: %v", err)
	}
}

// The timeout and the caller's cancellation both end the request upstream.
func TestDoTimeoutAndCancel(t *testing.T) {
	ended := make(chan struct{}, 4)
	c, base := upstream(t, func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
		ended <- struct{}{}
	})
	start := time.Now()
	_, err := c.Do(context.Background(), Request{URL: base + "/slow", Timeout: 150 * time.Millisecond})
	if kindOf(err) != Timeout || !strings.Contains(err.Error(), "did not answer in 0.1 s") && !strings.Contains(err.Error(), "did not answer in 0.2 s") {
		t.Errorf("timeout: %v", err)
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Errorf("timeout took %s", d)
	}
	waitEnded(t, ended)

	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(100 * time.Millisecond); cancel() }()
	_, err = c.Do(ctx, Request{URL: base + "/slow"})
	if !errors.Is(err, context.Canceled) || kindOf(err) != 0 {
		t.Errorf("cancel: %v, want context.Canceled", err)
	}
	waitEnded(t, ended)
}

func waitEnded(t *testing.T, ended <-chan struct{}) {
	t.Helper()
	select {
	case <-ended:
	case <-time.After(2 * time.Second):
		t.Fatal("the upstream request did not end")
	}
}

// At most PerThread requests of a thread are in flight; another thread is not held up.
func TestDoPerThreadCap(t *testing.T) {
	var inFlight, most atomic.Int32
	release := make(chan struct{})
	c, base := upstream(t, func(w http.ResponseWriter, r *http.Request) {
		n := inFlight.Add(1)
		defer inFlight.Add(-1)
		for {
			m := most.Load()
			if n <= m || most.CompareAndSwap(m, n) {
				break
			}
		}
		if r.URL.Path == "/hold" {
			<-release
		}
	})
	done := make(chan error, PerThread)
	for range PerThread {
		go func() {
			_, err := c.Do(context.Background(), Request{Thread: "a", URL: base + "/hold"})
			done <- err
		}()
	}
	deadline := time.Now().Add(2 * time.Second)
	for inFlight.Load() < PerThread && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	// The ninth of thread a waits for a place and times out there.
	if _, err := c.Do(context.Background(), Request{Thread: "a", URL: base + "/now", Timeout: 100 * time.Millisecond}); kindOf(err) != Timeout {
		t.Errorf("ninth: %v, want Timeout", err)
	}
	if _, err := c.Do(context.Background(), Request{Thread: "b", URL: base + "/now", Timeout: time.Second}); err != nil {
		t.Errorf("another thread: %v", err)
	}
	close(release)
	for range PerThread {
		if err := <-done; err != nil {
			t.Error(err)
		}
	}
	if m := most.Load(); m > PerThread+1 {
		t.Errorf("%d in flight at once", m)
	}
	if _, err := c.Do(context.Background(), Request{Thread: "a", URL: base + "/now"}); err != nil {
		t.Errorf("after: %v", err)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.slots) != 0 {
		t.Errorf("%d slots left", len(c.slots))
	}
}

// The system resolver's answer for localhost is checked like any other.
func TestDoLocalhost(t *testing.T) {
	_, err := New(Options{}).Do(context.Background(), Request{URL: "http://localhost:9/"})
	if kindOf(err) != Invalid || !strings.Contains(err.Error(), "localhost is a loopback address") {
		t.Fatalf("localhost: %v", err)
	}
}
