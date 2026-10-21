package main

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/client"
	"github.com/alexwaumann/code-foundry/internal/paths"
)

func TestDaemonBinary(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	onPath := t.TempDir()
	bin := filepath.Join(onPath, "code-foundry")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name    string
		env     string
		path    string
		want    string
		wantErr bool
	}{
		{"env override wins", "/opt/cf/code-foundry", onPath, "/opt/cf/code-foundry", false},
		{"found on PATH", "", onPath, bin, false},
		{"not found", "", t.TempDir(), "", true},
		// Spawning the GUI as the daemon would open a window per spawn, forever.
		{"env pointing at this executable is rejected", self, onPath, "", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv(EnvDaemonBinary, tt.env)
			t.Setenv("PATH", tt.path)
			t.Chdir(t.TempDir()) // no ../bin/code-foundry next to the working directory
			got, err := daemonBinary()
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tt.wantErr)
			}
			if got != tt.want {
				t.Fatalf("daemonBinary() = %q, want %q", got, tt.want)
			}
		})
	}
}

// A daemon that exits at start is not spawned again within startBackoff, and every
// call in between gets the reason, not a timeout.
func TestConnectBacksOffAfterStartFailure(t *testing.T) {
	dir, err := os.MkdirTemp("/tmp", "cf-gui-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	p := paths.New(filepath.Join(dir, "home"))
	count := filepath.Join(dir, "spawns")
	bin := filepath.Join(dir, "code-foundry")
	script := "#!/bin/sh\necho x >> " + count + "\necho 'code-foundry: database was last opened by a newer Code Foundry' >&2\nexit 1\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv(EnvDaemonBinary, bin)
	s := NewDaemonService(p, slog.New(slog.DiscardHandler))
	for i := range 3 {
		_, err := s.connect(context.Background())
		if !errors.Is(err, client.ErrDaemonExited) || !strings.Contains(err.Error(), "newer Code Foundry") {
			t.Fatalf("call %d: err = %v, want the daemon's reason", i, err)
		}
	}
	b, _ := os.ReadFile(count)
	if n := strings.Count(string(b), "x"); n != 1 {
		t.Fatalf("spawned %d times, want 1 within the backoff", n)
	}
}
