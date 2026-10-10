package client

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/paths"
)

func TestEndpointFromEnv(t *testing.T) {
	tests := []struct {
		name     string
		env      map[string]string
		want     Endpoint
		wantOK   bool
		errMatch string
	}{
		{name: "unset", env: nil},
		{name: "token alone is ignored", env: map[string]string{EnvToken: "t"}},
		{name: "loopback", env: map[string]string{EnvEndpoint: "http://127.0.0.1:4321", EnvToken: " t \n"},
			want: Endpoint{BaseURL: "http://127.0.0.1:4321", Token: "t"}, wantOK: true},
		{name: "trailing slash", env: map[string]string{EnvEndpoint: "http://127.0.0.1:4321/", EnvToken: "t"},
			want: Endpoint{BaseURL: "http://127.0.0.1:4321", Token: "t"}, wantOK: true},
		{name: "localhost", env: map[string]string{EnvEndpoint: "http://localhost:1", EnvToken: "t"},
			want: Endpoint{BaseURL: "http://localhost:1", Token: "t"}, wantOK: true},
		{name: "ipv6 loopback", env: map[string]string{EnvEndpoint: "http://[::1]:1", EnvToken: "t"},
			want: Endpoint{BaseURL: "http://[::1]:1", Token: "t"}, wantOK: true},
		{name: "no token", env: map[string]string{EnvEndpoint: "http://127.0.0.1:1"}, wantOK: true, errMatch: "CODE_FOUNDRY_TOKEN is not"},
		{name: "not loopback", env: map[string]string{EnvEndpoint: "http://example.com:80", EnvToken: "t"}, wantOK: true, errMatch: "loopback only"},
		{name: "https", env: map[string]string{EnvEndpoint: "https://127.0.0.1:1", EnvToken: "t"}, wantOK: true, errMatch: "want http://"},
		{name: "no port", env: map[string]string{EnvEndpoint: "http://127.0.0.1", EnvToken: "t"}, wantOK: true, errMatch: "want http://"},
		{name: "path", env: map[string]string{EnvEndpoint: "http://127.0.0.1:1/x", EnvToken: "t"}, wantOK: true, errMatch: "want http://"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ep, ok, err := EndpointFromEnv(func(k string) string { return tt.env[k] })
			if ok != tt.wantOK {
				t.Fatalf("ok = %v, want %v", ok, tt.wantOK)
			}
			if tt.errMatch != "" {
				if err == nil || !strings.Contains(err.Error(), tt.errMatch) {
					t.Fatalf("err = %v, want %q", err, tt.errMatch)
				}
				return
			}
			if err != nil || ep != tt.want {
				t.Fatalf("EndpointFromEnv = %+v, %v; want %+v", ep, err, tt.want)
			}
		})
	}
}

// With an endpoint, Connect uses it even when the socket path leads nowhere, which is
// what a sandboxed session sees.
func TestConnectPrefersEndpoint(t *testing.T) {
	p := shortHome(t)
	startDaemon(t, p)
	ep, err := ReadEndpoint(p)
	if err != nil {
		t.Fatal(err)
	}
	bogus := paths.New("/nonexistent/code-foundry")
	c, err := Connect(context.Background(), bogus, ConnectOptions{Endpoint: &ep, DaemonBinary: "/nonexistent/code-foundry-bin"})
	if err != nil {
		t.Fatal(err)
	}
	ping, err := c.Ping(context.Background())
	if err != nil || ping.GetPid() != int32(os.Getpid()) {
		t.Fatalf("ping = %v, %v", ping, err)
	}
	if _, err := c.ListCommands(context.Background(), nil, true); err != nil {
		t.Fatalf("list commands over loopback: %v", err)
	}

	// A wrong token is reported, not papered over by starting a daemon.
	wrong := Endpoint{BaseURL: ep.BaseURL, Token: strings.Repeat("0", 64)}
	if _, err := Connect(context.Background(), bogus, ConnectOptions{Endpoint: &wrong}); err == nil ||
		!strings.Contains(err.Error(), "unauthenticated") {
		t.Fatalf("wrong token: %v", err)
	}
}

// An endpoint that does not answer is an error; no daemon is started for it.
func TestConnectWithEndpointNeverStartsDaemon(t *testing.T) {
	p := shortHome(t)
	dead := Endpoint{BaseURL: "http://127.0.0.1:1", Token: "t"}
	start := time.Now()
	_, err := Connect(context.Background(), p, ConnectOptions{Endpoint: &dead, DaemonBinary: os.Args[0]})
	if err == nil || !strings.Contains(err.Error(), "CODE_FOUNDRY_ENDPOINT") || !strings.Contains(err.Error(), "not starting one") {
		t.Fatalf("err = %v", err)
	}
	if time.Since(start) > 3*time.Second {
		t.Errorf("Connect took %s", time.Since(start))
	}
	// spawnDaemon creates the home and its log before starting anything.
	if _, err := os.Stat(p.DaemonLog()); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("daemon log exists (a daemon was started?): %v", err)
	}
	if _, err := New(p).Ping(context.Background()); err == nil {
		t.Fatal("a daemon answers on the socket")
	}
}
