package main

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/awaumann/code-foundry/internal/client"
)

func runCLIInteractive(c *client.Client, stdin string, interactive bool, args ...string) run {
	var stdout, stderr bytes.Buffer
	cl := &cli{
		stdout:      &stdout,
		stderr:      &stderr,
		connect:     func(context.Context) (*client.Client, error) { return c, nil },
		getwd:       func() (string, error) { return "/work", nil },
		stdin:       strings.NewReader(stdin),
		interactive: func() bool { return interactive },
	}
	err := cl.dispatch(context.Background(), args)
	return run{err: err, stdout: stdout.String(), stderr: stderr.String()}
}

func TestCLISettings(t *testing.T) {
	c := startTestDaemon(t)
	tests := []struct {
		name       string
		args       []string
		wantErr    error
		wantStdout string
		wantStderr string
	}{
		{"get one", []string{"settings", "get", "appearance.font_size"}, nil, "13\n", ""},
		{"get all", []string{"settings", "get"}, nil, `sessions.auto_name = "true"`, ""},
		{"set positional", []string{"settings", "set", "appearance.font_size", "15"}, nil, `appearance.font_size = "15"`, ""},
		{"get after set", []string{"settings.get", "appearance.font_size"}, nil, "15\n", ""},
		{"flags still work", []string{"settings", "set", "--key", "appearance.theme", "--value", "dark"}, nil, `appearance.theme = "dark"`, ""},
		{"flags interleaved", []string{"settings", "get", "--json", "appearance.theme"}, nil, `"value":"dark"`, ""},
		{"restart note", []string{"settings", "set", "sessions.scrollback_lines", "20000"}, nil, "applies after a daemon restart", ""},
		{"reset", []string{"settings", "reset", "appearance.theme"}, nil, `appearance.theme = "system" (default)`, ""},
		{"path", []string{"settings", "path"}, nil, "/settings.toml\n", ""},
		{"invalid value", []string{"settings", "set", "appearance.font_size", "99"}, errAny, "", ""},
		{"reserved chord", []string{"settings", "set", "keybindings.session.new", "cmd+k"}, errAny, "", ""},
		{"unknown key", []string{"settings", "get", "nope.nope"}, errUsage, "", `unknown setting "nope.nope"`},
		{"too many words", []string{"settings", "set", "a", "b", "c"}, errUsage, "", "unexpected arguments [c]"},
		{"missing value", []string{"settings", "set", "appearance.font_size"}, errUsage, "", `missing required argument "value"`},
		{"help shows positionals", []string{"help", "settings", "set"}, nil, "code-foundry settings.set <key> <value> [flags]", ""},
		{"help shows --yes", []string{"help", "session", "remove"}, nil, "--yes", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := runCLI(c, tt.args...)
			switch {
			case tt.wantErr == errAny && r.err == nil:
				t.Fatalf("err = nil, want an error\nstdout: %s", r.stdout)
			case tt.wantErr != errAny && !errors.Is(r.err, tt.wantErr):
				t.Fatalf("err = %v, want %v\nstderr: %s", r.err, tt.wantErr, r.stderr)
			}
			if !strings.Contains(r.stdout, tt.wantStdout) {
				t.Errorf("stdout = %q, want containing %q", r.stdout, tt.wantStdout)
			}
			if !strings.Contains(r.stderr, tt.wantStderr) {
				t.Errorf("stderr = %q, want containing %q", r.stderr, tt.wantStderr)
			}
		})
	}
}

func TestCLIConfirm(t *testing.T) {
	c := startTestDaemon(t)
	tests := []struct {
		name        string
		args        []string
		stdin       string
		interactive bool
		wantErr     error
		wantStderr  string
	}{
		{"no terminal needs --yes", []string{"terminal", "kill", "--id", "t1"}, "", false, errUsage,
			"Kill terminal t1? Its process is terminated.\nRe-run with --yes to confirm."},
		{"prompt answered no", []string{"terminal", "kill", "--id", "t1"}, "n\n", true, errCancelled, "Kill terminal t1? Its process is terminated. [y/N] "},
		{"prompt answered with enter", []string{"terminal", "kill", "--id", "t1"}, "\n", true, errCancelled, "cancelled"},
		// Confirmed, the command runs and reaches the store, which has no terminal t1.
		{"prompt answered yes", []string{"terminal", "kill", "--id", "t1"}, "y\n", true, errUsage, "terminal not found: t1"},
		{"--yes skips the prompt", []string{"terminal", "kill", "--id", "t1", "--yes"}, "", true, errUsage, "terminal not found: t1"},
		{"worktree remove asks", []string{"repo", "worktree", "remove", "--repo", "r1", "--path", "/wt/x"}, "", false, errUsage,
			"Remove worktree /wt/x? This deletes files on disk."},
		{"--yes on a command without confirmation is unknown", []string{"settings", "path", "--yes"}, "", false, errUsage, "flag provided but not defined: -yes"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := runCLIInteractive(c, tt.stdin, tt.interactive, tt.args...)
			if !errors.Is(r.err, tt.wantErr) {
				t.Fatalf("err = %v, want %v\nstderr: %s", r.err, tt.wantErr, r.stderr)
			}
			if !strings.Contains(r.stderr, tt.wantStderr) {
				t.Errorf("stderr = %q, want containing %q", r.stderr, tt.wantStderr)
			}
		})
	}
}
