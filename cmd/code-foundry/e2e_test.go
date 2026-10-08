package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/awaumann/code-foundry/internal/client"
	"github.com/awaumann/code-foundry/internal/daemon"
	"github.com/awaumann/code-foundry/internal/paths"
	"github.com/awaumann/code-foundry/internal/version"
)

// startTestDaemon runs a daemon in-process on a fresh home under /tmp (t.TempDir paths
// can exceed macOS's socket path limit) and returns a client for it.
func startTestDaemon(t *testing.T) *client.Client {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "cf-cli-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	p := paths.New(dir)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- daemon.Run(ctx, daemon.Options{Paths: p, Version: version.Info{Version: "test"}}) }()
	t.Cleanup(func() {
		cancel()
		if err := <-done; err != nil {
			t.Errorf("daemon.Run: %v", err)
		}
	})
	c := client.New(p)
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := c.Ping(ctx); err == nil {
			return c
		}
		if time.Now().After(deadline) {
			t.Fatal("daemon did not become ready")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

type run struct {
	err            error
	stdout, stderr string
}

func runCLI(c *client.Client, args ...string) run {
	var stdout, stderr bytes.Buffer
	cl := &cli{
		stdout:  &stdout,
		stderr:  &stderr,
		connect: func(context.Context) (*client.Client, error) { return c, nil },
		getwd:   func() (string, error) { return "/work", nil },
	}
	err := cl.dispatch(context.Background(), args)
	return run{err: err, stdout: stdout.String(), stderr: stderr.String()}
}

func TestCLIAgainstDaemon(t *testing.T) {
	c := startTestDaemon(t)
	tests := []struct {
		name       string
		args       []string
		wantErr    error // errUsage, nil, or errAny
		wantStdout string
		wantStderr string
	}{
		{"commands lists everything", []string{"commands"}, nil, "terminal.kill", ""},
		{"dotted name", []string{"daemon.status"}, nil, "version test", ""},
		{"spaced name shadows local verb", []string{"daemon", "status"}, nil, "version test", ""},
		{"json result", []string{"daemon.version", "--json"}, nil, `"version":"test"`, ""},
		{"notify with no GUI", []string{"ui", "notify", "--title", "hi", "--body", "there"}, nil, "delivered=0", ""},
		{"help for a command", []string{"help", "ui", "notify"}, nil, "--level info|warning|error", ""},
		{"-h on a command", []string{"ui.notify", "-h"}, nil, "", "--title string"},
		{"unknown command", []string{"bogus", "thing"}, errUsage, "", `unknown command "bogus thing"`},
		{"missing required arg", []string{"repo", "register"}, errUsage, "", `code-foundry repo.register: missing required argument "path"`},
		{"bad enum", []string{"ui.notify", "--title", "x", "--level", "loud"}, errUsage, "", "want one of info, warning, error"},
		{"unavailable", []string{"terminal", "kill"}, errUsage, "", "terminal.kill: not available in this context"},
		{"unknown flag", []string{"ui.notify", "--nope"}, errUsage, "", "flag provided but not defined: -nope"},
		{"stray positional", []string{"ui.notify", "--title", "x", "extra"}, errUsage, "", "unexpected arguments [extra]"},
		// terminal.* is registered against the Unimplemented stub until 1a is wired.
		{"store-backed stub", []string{"terminal.kill", "--id", "t1"}, errAny, "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := runCLI(c, tt.args...)
			switch {
			case tt.wantErr == errAny && r.err == nil:
				t.Fatal("err = nil, want an error")
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

	for _, tt := range []struct {
		name string
		args []string
		want string
	}{
		{"commands shows availability", []string{"commands"}, `(?m)^Terminal\s+terminal\.kill\s+no\s+Kill Terminal$`},
		{"commands with context", []string{"commands", "--context-terminal", "t1"}, `(?m)^Terminal\s+terminal\.kill\s+yes\s`},
		{"repo context enables worktree.new", []string{"commands", "--context-repo", "r1"}, `(?m)^Repository\s+repo\.worktree\.new\s+yes\s`},
	} {
		t.Run(tt.name, func(t *testing.T) {
			r := runCLI(c, tt.args...)
			if r.err != nil || !regexp.MustCompile(tt.want).MatchString(r.stdout) {
				t.Fatalf("err %v, stdout:\n%s\nwant match %s", r.err, r.stdout, tt.want)
			}
		})
	}

	t.Run("unknown terminal is a clean not-found error", func(t *testing.T) {
		r := runCLI(c, "terminal.kill", "--id", "t1")
		if !errors.Is(r.err, errUsage) || !strings.Contains(r.stderr, "terminal not found: t1") {
			t.Fatalf("err = %v\nstderr: %s", r.err, r.stderr)
		}
	})
}

var errAny = errors.New("any error")

func TestCLINotifyReachesWatcher(t *testing.T) {
	c := startTestDaemon(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stream, err := c.WatchIntents(ctx)
	if err != nil {
		t.Fatal(err)
	}

	r := runCLI(c, "ui", "notify", "--title", "hi", "--body", "there", "--json")
	if r.err != nil {
		t.Fatalf("notify: %v\n%s", r.err, r.stderr)
	}
	var got struct{ Delivered int }
	if err := json.Unmarshal([]byte(r.stdout), &got); err != nil || got.Delivered != 1 {
		t.Fatalf("stdout = %q (err %v), want delivered 1", r.stdout, err)
	}
	if !stream.Receive() {
		t.Fatalf("stream ended: %v", stream.Err())
	}
	n := stream.Msg().GetNotify()
	if n.GetTitle() != "hi" || n.GetBody() != "there" || n.GetLevel().String() != "LEVEL_INFO" {
		t.Fatalf("intent = %v", stream.Msg())
	}
}
