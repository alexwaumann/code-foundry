package client

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// A spawned daemon that exits before it answers fails Connect at once, with the reason
// from the daemon log (fuzz 2026-10-21: it used to wait the whole StartTimeout and say
// "did not become ready").
func TestConnectReportsDaemonExit(t *testing.T) {
	tests := []struct {
		name   string
		log    string // daemon.log before the spawn
		lock   string // daemon.lock before the spawn
		script string // the fake daemon's body
		want   []string
	}{
		{name: "error on stderr", script: `echo "code-foundry: database was last opened by a newer Code Foundry" >&2; exit 1`,
			want: []string{"daemon cannot start: database was last opened by a newer Code Foundry (see "}},
		{name: "json error line", script: `echo '{"time":"x","level":"INFO","msg":"opening"}'; echo '{"time":"x","level":"ERROR","msg":"daemon cannot start","err":"open db: corrupt"}'; exit 1`,
			want: []string{"daemon cannot start: open db: corrupt"}},
		{name: "json error without err", script: `echo '{"level":"ERROR","msg":"listener failed"}'; exit 1`,
			want: []string{"daemon cannot start: listener failed"}},
		{name: "lock held", lock: "4242\n", script: `exit 3`,
			want: []string{"a daemon (pid 4242, from ", "holds the lock but does not answer", "kill 4242"}},
		{name: "lock held, no pid", script: `exit 3`, want: []string{"another process holds"}},
		{name: "silent exit", script: `exit 7`, want: []string{"daemon cannot start: exit status 7"}},
		{name: "older log lines are not this start's", log: "code-foundry: an old failure\n", script: `exit 1`,
			want: []string{"daemon cannot start: exit status 1"}},
		{name: "passes the lock wait", script: `[ "$1 $2 $3" = "daemon --wait-lock 3s" ] || echo "code-foundry: args $*" >&2; exit 1`,
			want: []string{"daemon cannot start: exit status 1"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := shortHome(t)
			if err := p.Ensure(); err != nil {
				t.Fatal(err)
			}
			if tt.log != "" {
				writeFile(t, p.DaemonLog(), tt.log)
			}
			if tt.lock != "" {
				writeFile(t, p.Lock(), tt.lock)
			}
			bin := filepath.Join(p.Home(), "fake-daemon")
			writeFile(t, bin, "#!/bin/sh\n"+tt.script+"\n")
			if err := os.Chmod(bin, 0o700); err != nil {
				t.Fatal(err)
			}
			start := time.Now()
			_, err := Connect(context.Background(), p, ConnectOptions{DaemonBinary: bin, StartTimeout: 5 * time.Second})
			if took := time.Since(start); took > 3*time.Second {
				t.Errorf("took %s: waited for the timeout", took)
			}
			if !errors.Is(err, ErrDaemonExited) {
				t.Fatalf("err = %v, want ErrDaemonExited", err)
			}
			for _, w := range tt.want {
				if !strings.Contains(err.Error(), w) {
					t.Errorf("err = %q, want it to contain %q", err, w)
				}
			}
		})
	}
}

// A daemon still closing its stores holds daemon.lock after its socket is gone; the
// daemon Connect starts in that window waits for the lock and comes up.
func TestConnectWaitsForShuttingDownDaemon(t *testing.T) {
	if testing.Short() {
		t.Skip("spawns a daemon process")
	}
	p := shortHome(t)
	if err := p.Ensure(); err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(p.Lock(), os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		t.Fatal(err)
	}
	time.AfterFunc(time.Second, func() { _ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN) })
	t.Setenv("CF_TEST_DAEMON", "1")
	c, err := Connect(context.Background(), p, ConnectOptions{DaemonBinary: os.Args[0], StartTimeout: 10 * time.Second})
	if err != nil {
		log, _ := os.ReadFile(p.DaemonLog())
		t.Fatalf("Connect: %v\ndaemon log:\n%s", err, log)
	}
	res, err := c.Ping(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stopProcess(t, int(res.GetPid()), p) })
	log, _ := os.ReadFile(p.DaemonLog())
	if !strings.Contains(string(log), "the previous daemon was still shutting down") {
		t.Errorf("daemon log does not mention the wait:\n%s", log)
	}
}

func writeFile(t *testing.T, path, s string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(s), 0o600); err != nil {
		t.Fatal(err)
	}
}
