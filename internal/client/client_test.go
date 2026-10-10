package client

import (
	"context"
	"errors"
	"net"
	"net/http"
	"os"
	"strings"
	"syscall"
	"testing"
	"time"

	"connectrpc.com/connect"

	"github.com/alexwaumann/code-foundry/internal/daemon"
	"github.com/alexwaumann/code-foundry/internal/paths"
	"github.com/alexwaumann/code-foundry/internal/version"
)

// TestMain lets the test binary act as `code-foundry daemon`, so the auto-start test can
// spawn a real, separate daemon process without building cmd/code-foundry.
func TestMain(m *testing.M) {
	if len(os.Args) == 2 && os.Args[1] == "daemon" && os.Getenv("CF_TEST_DAEMON") == "1" {
		p, err := paths.Resolve()
		if err == nil {
			err = daemon.Run(context.Background(), daemon.Options{Paths: p, Version: version.Info{Version: "test"}})
		}
		if err != nil {
			_, _ = os.Stderr.WriteString(err.Error() + "\n")
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// shortHome returns a temp config home under /tmp: t.TempDir() lives under
// /var/folders/... which can push daemon.sock past macOS's 104-byte sun_path limit.
func shortHome(t *testing.T) paths.Paths {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "cf-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return paths.New(dir)
}

func startDaemon(t *testing.T, p paths.Paths) (stop func() error) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- daemon.Run(ctx, daemon.Options{Paths: p, Version: version.Info{Version: "test"}})
	}()
	c := New(p)
	deadline := time.Now().Add(5 * time.Second)
	for !c.alive(context.Background()) {
		select {
		case err := <-done:
			cancel()
			t.Fatalf("daemon exited early: %v", err)
		default:
		}
		if time.Now().After(deadline) {
			cancel()
			t.Fatal("daemon did not become ready")
		}
		time.Sleep(20 * time.Millisecond)
	}
	var stopped bool
	stop = func() error {
		if stopped {
			return nil
		}
		stopped = true
		cancel()
		return <-done
	}
	t.Cleanup(func() { _ = stop() })
	return stop
}

func assertPerm(t *testing.T, path string, want os.FileMode) {
	t.Helper()
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := fi.Mode().Perm(); got != want {
		t.Errorf("%s perm = %o, want %o", path, got, want)
	}
}

func TestDaemonBothTransports(t *testing.T) {
	p := shortHome(t)
	stop := startDaemon(t, p)
	ctx := context.Background()

	for _, f := range []string{p.Socket(), p.Token(), p.Port()} {
		assertPerm(t, f, 0o600)
	}

	// Unix socket.
	uds, err := New(p).Ping(ctx)
	if err != nil {
		t.Fatalf("unix ping: %v", err)
	}
	if uds.GetPid() != int32(os.Getpid()) || uds.GetVersion() != "test" {
		t.Fatalf("unix ping = %v", uds)
	}

	// Loopback with the right token.
	ep, err := ReadEndpoint(p)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(ep.BaseURL, "http://127.0.0.1:") || len(ep.Token) != 64 {
		t.Fatalf("endpoint = %+v", ep)
	}
	lb, err := NewLoopback(ep.BaseURL, ep.Token).Ping(ctx)
	if err != nil {
		t.Fatalf("loopback ping: %v", err)
	}
	if lb.GetPid() != uds.GetPid() {
		t.Fatalf("loopback pid %d != unix pid %d", lb.GetPid(), uds.GetPid())
	}

	// Loopback with a wrong token: Connect surfaces HTTP 401 as Unauthenticated.
	_, err = NewLoopback(ep.BaseURL, strings.Repeat("0", 64)).Ping(ctx)
	if got := connect.CodeOf(err); got != connect.CodeUnauthenticated {
		t.Fatalf("wrong-token ping code = %v (err %v), want unauthenticated", got, err)
	}

	// Raw HTTP: wrong or missing token is a 401; right token is served over h2c.
	for _, tt := range []struct {
		name      string
		token     string
		wantCode  int
		wantProto int
	}{
		{"missing token", "", http.StatusUnauthorized, 2},
		{"wrong token", "deadbeef", http.StatusUnauthorized, 2},
		{"right token", ep.Token, http.StatusOK, 2},
	} {
		t.Run(tt.name, func(t *testing.T) {
			req, _ := http.NewRequestWithContext(ctx, http.MethodPost,
				ep.BaseURL+"/codefoundry.v1.HealthService/Ping", strings.NewReader("{}"))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Connect-Protocol-Version", "1")
			if tt.token != "" {
				req.Header.Set("Authorization", "Bearer "+tt.token)
			}
			res, err := (&http.Client{Transport: h2cTransport(nil)}).Do(req)
			if err != nil {
				t.Fatal(err)
			}
			_ = res.Body.Close()
			if res.StatusCode != tt.wantCode || res.ProtoMajor != tt.wantProto {
				t.Fatalf("status %d proto %d, want %d over HTTP/%d", res.StatusCode, res.ProtoMajor, tt.wantCode, tt.wantProto)
			}
		})
	}

	// Second daemon on the same home is refused by the lock.
	err = daemon.Run(ctx, daemon.Options{Paths: p})
	if !errors.Is(err, daemon.ErrAlreadyRunning) {
		t.Fatalf("second daemon err = %v, want ErrAlreadyRunning", err)
	}

	// Graceful shutdown removes runtime files.
	if err := stop(); err != nil {
		t.Fatalf("daemon.Run returned %v", err)
	}
	for _, f := range []string{p.Socket(), p.Token(), p.Port()} {
		if _, err := os.Stat(f); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%s still exists after shutdown (err %v)", f, err)
		}
	}
}

func TestConnectAutoStartsDaemon(t *testing.T) {
	if testing.Short() {
		t.Skip("spawns a daemon process")
	}
	tests := []struct {
		name  string
		setup func(t *testing.T, p paths.Paths)
	}{
		{"socket absent", func(*testing.T, paths.Paths) {}},
		{"stale socket", func(t *testing.T, p paths.Paths) {
			if err := p.Ensure(); err != nil {
				t.Fatal(err)
			}
			ln, err := net.Listen("unix", p.Socket())
			if err != nil {
				t.Fatal(err)
			}
			ln.(*net.UnixListener).SetUnlinkOnClose(false)
			_ = ln.Close()
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := shortHome(t)
			tt.setup(t, p)
			t.Setenv("CF_TEST_DAEMON", "1")

			ctx := context.Background()
			c, err := Connect(ctx, p, ConnectOptions{DaemonBinary: os.Args[0], StartTimeout: 10 * time.Second})
			if err != nil {
				log, _ := os.ReadFile(p.DaemonLog())
				t.Fatalf("Connect: %v\ndaemon log:\n%s", err, log)
			}
			res, err := c.Ping(ctx)
			if err != nil {
				t.Fatal(err)
			}
			pid := int(res.GetPid())
			if pid == os.Getpid() {
				t.Fatal("daemon runs in the test process; expected a spawned process")
			}
			t.Cleanup(func() { stopProcess(t, pid, p) })

			// A second Connect reuses the running daemon.
			c2, err := Connect(ctx, p, ConnectOptions{DaemonBinary: "/nonexistent"})
			if err != nil {
				t.Fatal(err)
			}
			res2, err := c2.Ping(ctx)
			if err != nil || int(res2.GetPid()) != pid {
				t.Fatalf("second Connect pinged pid %d (err %v), want %d", res2.GetPid(), err, pid)
			}
		})
	}
}

func TestConnectFailsWithoutBinary(t *testing.T) {
	p := shortHome(t)
	_, err := Connect(context.Background(), p, ConnectOptions{DaemonBinary: "/nonexistent/code-foundry"})
	if err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("err = %v, want not found", err)
	}
}

func stopProcess(t *testing.T, pid int, p paths.Paths) {
	t.Helper()
	if err := syscall.Kill(pid, syscall.SIGTERM); err != nil {
		t.Errorf("kill daemon %d: %v", pid, err)
		return
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(p.Socket()); errors.Is(err, os.ErrNotExist) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Errorf("daemon %d did not remove its socket after SIGTERM", pid)
}

func TestConnectNoAutoStart(t *testing.T) {
	p := shortHome(t)
	_, err := Connect(context.Background(), p, ConnectOptions{NoAutoStart: true, DaemonBinary: os.Args[0]})
	if !errors.Is(err, ErrDaemonNotRunning) {
		t.Fatalf("err = %v, want ErrDaemonNotRunning", err)
	}
}
