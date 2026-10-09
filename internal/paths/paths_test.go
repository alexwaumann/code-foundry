package paths

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestResolve(t *testing.T) {
	userHome, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name string
		env  string
		want string
	}{
		{"default", "", filepath.Join(userHome, ".code-foundry")},
		{"override", "/tmp/cf-home", "/tmp/cf-home"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv(EnvHome, tt.env)
			p, err := Resolve()
			if err != nil {
				t.Fatal(err)
			}
			if p.Home() != tt.want {
				t.Fatalf("Home() = %q, want %q", p.Home(), tt.want)
			}
		})
	}
}

func TestLayout(t *testing.T) {
	p := New("/h")
	got := map[string]string{
		"socket": p.Socket(), "token": p.Token(), "port": p.Port(), "lock": p.Lock(),
		"db": p.DB(), "logs": p.Logs(), "daemonlog": p.DaemonLog(), "worktrees": p.Worktrees(),
		"attachments": p.Attachments(),
	}
	want := map[string]string{
		"socket": "/h/daemon.sock", "token": "/h/daemon.token", "port": "/h/daemon.port",
		"lock": "/h/daemon.lock", "db": "/h/db.sqlite", "logs": "/h/logs", "daemonlog": "/h/logs/daemon.log",
		"worktrees": "/h/worktrees", "attachments": "/h/attachments",
	}
	for k, w := range want {
		if got[k] != w {
			t.Errorf("%s = %q, want %q", k, got[k], w)
		}
	}
}

func TestEnsure(t *testing.T) {
	tests := []struct {
		name    string
		home    string
		wantErr string
	}{
		{"ok", filepath.Join(t.TempDir(), "h"), ""},
		{"empty", "", "empty home"},
		{"socket too long", "/" + strings.Repeat("x", 120), "socket path"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := New(tt.home)
			err := p.Ensure()
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("Ensure() err = %v, want containing %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			for _, dir := range []string{p.Home(), p.Logs()} {
				fi, err := os.Stat(dir)
				if err != nil {
					t.Fatal(err)
				}
				if perm := fi.Mode().Perm(); perm != 0o700 {
					t.Errorf("%s perm = %o, want 700", dir, perm)
				}
			}
		})
	}
}
