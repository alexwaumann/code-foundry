// Package client is the Go client for the code-foundry daemon, used by the CLI and the
// Wails host. It talks to the daemon over the Unix socket and can start the daemon
// on demand. Inside a Claude session the daemon spawned, the CLI uses the loopback
// endpoint from the session's environment instead (EndpointFromEnv) and never starts
// a daemon.
package client

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/paths"
)

// unixBaseURL is the base URL used for requests over the Unix socket. The host is
// ignored by the dialer.
const unixBaseURL = "http://code-foundry.sock"

// Client is a connection to the daemon. It is cheap to create and safe for concurrent use.
type Client struct {
	Health  codefoundryv1connect.HealthServiceClient
	Command codefoundryv1connect.CommandServiceClient
	UI      codefoundryv1connect.UiServiceClient
	Update  codefoundryv1connect.UpdateServiceClient
	// Repo is for the repo.clone CLI verb, which streams RepoService.Clone itself.
	Repo codefoundryv1connect.RepoServiceClient

	paths paths.Paths
}

// New returns a client for the daemon at p's Unix socket. It does not touch the
// network; use Connect to also ensure the daemon is running.
func New(p paths.Paths) *Client {
	return newClient(p, unixHTTPClient(p.Socket()), unixBaseURL)
}

// NewLoopback returns a client that talks to the daemon's loopback HTTP listener at
// baseURL with the given bearer token. The GUI frontend uses the same transport from
// the browser side; this exists for tests and diagnostics.
func NewLoopback(baseURL, token string) *Client {
	hc := &http.Client{Transport: &bearerTransport{token: token, next: h2cTransport(nil)}}
	return newClient(paths.Paths{}, hc, baseURL)
}

func newClient(p paths.Paths, hc *http.Client, baseURL string) *Client {
	return &Client{
		Health:  codefoundryv1connect.NewHealthServiceClient(hc, baseURL),
		Command: codefoundryv1connect.NewCommandServiceClient(hc, baseURL),
		UI:      codefoundryv1connect.NewUiServiceClient(hc, baseURL),
		Update:  codefoundryv1connect.NewUpdateServiceClient(hc, baseURL),
		Repo:    codefoundryv1connect.NewRepoServiceClient(hc, baseURL),
		paths:   p,
	}
}

// Ping calls HealthService.Ping.
func (c *Client) Ping(ctx context.Context) (*v1.PingResponse, error) {
	res, err := c.Health.Ping(ctx, connect.NewRequest(&v1.PingRequest{}))
	if err != nil {
		return nil, fmt.Errorf("ping daemon: %w", err)
	}
	return res.Msg, nil
}

// Endpoint is how a browser client reaches the daemon's loopback listener.
type Endpoint struct {
	BaseURL string `json:"baseUrl"`
	Token   string `json:"token"`
}

// Environment variables the daemon sets in every Claude session it spawns, so the CLI
// inside the session reaches the daemon over loopback TCP: sandboxed sessions cannot
// connect to Unix sockets.
const (
	EnvEndpoint = paths.EnvEndpoint // http://127.0.0.1:<port>
	EnvToken    = paths.EnvToken    // the loopback bearer token
)

// EndpointFromEnv reads EnvEndpoint and EnvToken with getenv (os.Getenv). ok is false
// when EnvEndpoint is unset. A set endpoint without a token, or one that is not an
// http URL on a loopback host, is an error.
func EndpointFromEnv(getenv func(string) string) (ep Endpoint, ok bool, err error) {
	raw := strings.TrimSpace(getenv(EnvEndpoint))
	if raw == "" {
		return Endpoint{}, false, nil
	}
	token := strings.TrimSpace(getenv(EnvToken))
	if token == "" {
		return Endpoint{}, true, fmt.Errorf("%s is set but %s is not", EnvEndpoint, EnvToken)
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "http" || u.Port() == "" || u.Path != "" && u.Path != "/" {
		return Endpoint{}, true, fmt.Errorf("%s=%q: want http://127.0.0.1:<port>", EnvEndpoint, raw)
	}
	if ip := net.ParseIP(u.Hostname()); u.Hostname() != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return Endpoint{}, true, fmt.Errorf("%s=%q: the daemon listens on loopback only", EnvEndpoint, raw)
	}
	return Endpoint{BaseURL: "http://" + u.Host, Token: token}, true, nil
}

// ReadEndpoint reads the loopback port and token files written by a running daemon.
func ReadEndpoint(p paths.Paths) (Endpoint, error) {
	portRaw, err := os.ReadFile(p.Port())
	if err != nil {
		return Endpoint{}, fmt.Errorf("read daemon port: %w", err)
	}
	port, err := strconv.Atoi(strings.TrimSpace(string(portRaw)))
	if err != nil || port <= 0 || port > 65535 {
		return Endpoint{}, fmt.Errorf("read daemon port: invalid port %q", strings.TrimSpace(string(portRaw)))
	}
	tokenRaw, err := os.ReadFile(p.Token())
	if err != nil {
		return Endpoint{}, fmt.Errorf("read daemon token: %w", err)
	}
	token := strings.TrimSpace(string(tokenRaw))
	if token == "" {
		return Endpoint{}, errors.New("read daemon token: empty token file")
	}
	return Endpoint{BaseURL: "http://127.0.0.1:" + strconv.Itoa(port), Token: token}, nil
}

// h2cTransport speaks HTTP/2 with prior knowledge over plain TCP or a Unix socket, so
// Connect server streams work. dial overrides the dialer when non-nil.
func h2cTransport(dial func(ctx context.Context, network, addr string) (net.Conn, error)) *http.Transport {
	var protocols http.Protocols
	protocols.SetUnencryptedHTTP2(true)
	t := &http.Transport{
		Protocols:       &protocols,
		DialContext:     dial,
		IdleConnTimeout: 90 * time.Second,
	}
	if dial == nil {
		t.DialContext = (&net.Dialer{Timeout: 5 * time.Second}).DialContext
	}
	return t
}

func unixHTTPClient(socket string) *http.Client {
	d := net.Dialer{Timeout: 2 * time.Second}
	return &http.Client{Transport: h2cTransport(func(ctx context.Context, _, _ string) (net.Conn, error) {
		return d.DialContext(ctx, "unix", socket)
	})}
}

type bearerTransport struct {
	token string
	next  http.RoundTripper
}

func (t *bearerTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+t.token)
	return t.next.RoundTrip(r)
}
