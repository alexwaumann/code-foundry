// Package client is the Go client for the code-foundry daemon, used by the CLI and the
// Wails host. It talks to the daemon over the Unix socket and can start the daemon
// on demand.
package client

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/awaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/awaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/awaumann/code-foundry/internal/paths"
)

// unixBaseURL is the base URL used for requests over the Unix socket. The host is
// ignored by the dialer.
const unixBaseURL = "http://code-foundry.sock"

// Client is a connection to the daemon. It is cheap to create and safe for concurrent use.
type Client struct {
	Health codefoundryv1connect.HealthServiceClient

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
		Health: codefoundryv1connect.NewHealthServiceClient(hc, baseURL),
		paths:  p,
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
