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

	"github.com/alexwaumann/code-foundry/internal/client"
	"github.com/alexwaumann/code-foundry/internal/daemon"
	"github.com/alexwaumann/code-foundry/internal/paths"
	"github.com/alexwaumann/code-foundry/internal/version"
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
		{"guide", []string{"guide"}, nil, "## More commands: `code-foundry guide <topic>`", ""},
		{"guide topic", []string{"guide", "terminal"}, nil, "# code-foundry guide: Terminal", ""},
		{"guide unknown topic", []string{"guide", "bogus"}, errUsage, "", `no guide topic "bogus"; topics: action,`},
		{"json result", []string{"daemon.version", "--json"}, nil, `"version":"test"`, ""},
		{"notify with no GUI", []string{"ui", "notify", "--title", "hi", "--body", "there"}, nil, "no app window is open: nothing was shown", ""},
		{"help for a command", []string{"help", "ui", "notify"}, nil, "--level info|warning|error", ""},
		{"-h on a command", []string{"ui.notify", "-h"}, nil, "--title string", ""},
		{"unknown command", []string{"bogus", "thing"}, errUsage, "", `unknown command "bogus thing"`},
		{"missing required arg", []string{"workspace", "new"}, errUsage, "", `code-foundry workspace.new: missing required argument "name"`},
		{"bad enum", []string{"ui.notify", "--title", "x", "--level", "loud"}, errUsage, "", "want one of info, warning, error"},
		{"missing the active id", []string{"terminal", "kill"}, errUsage, "", "terminal.kill: missing --id (default: the active terminal; there is none)"},
		{"unknown flag", []string{"ui.notify", "--nope"}, errUsage, "", "flag provided but not defined: -nope"},
		{"stray positional", []string{"ui.notify", "--title", "x", "extra"}, errUsage, "", "unexpected arguments [extra]"},
		{"no thread outside one", []string{"thread", "get"}, errUsage, "", "thread.get: missing --id (default: the active thread; there is none)"},
		{"git fetch defaults to the working directory", []string{"git", "fetch"}, errUsage, "", "/work"},
		{"workspace list", []string{"workspace", "list"}, nil, "no workspaces", ""},
		{"thread checkouts defaults to the working directory", []string{"thread", "checkouts"}, errUsage, "", "no thread has a checkout holding /work"},
		{"kebab-case verb with a positional", []string{"workspace", "add-project", "api"}, errUsage, "", "code-foundry workspace.add-project: name the workspace"},
		{"explicit --cwd wins", []string{"thread", "checkouts", "--cwd", "/elsewhere"}, errUsage, "", "no thread has a checkout holding /elsewhere"},
		{"project add prints the CLI hint", []string{"project", "add"}, nil, "code-foundry project add <folder>", ""},
		{"project add resolves a relative folder against the working directory", []string{"project", "add", "rel"}, errUsage, "",
			"code-foundry project.add: /work/rel: lstat /work: no such file or directory"},
		{"project add-workspace needs a folder", []string{"project", "add-workspace"}, errUsage, "",
			`code-foundry project.add-workspace: missing required argument "folder"`},
		{"project add-workspace refuses a folder outside home", []string{"project", "add-workspace", "/"}, errUsage, "", "outside your home directory"},
		{"project clone refuses ssh before the daemon runs gh", []string{"project", "clone", "git@github.com:o/r.git"}, errUsage, "",
			"code-foundry project.clone: invalid argument: SSH URLs are not supported"},
		{"project clone needs a project", []string{"project", "clone"}, errUsage, "", "no repository given"},
		{"project create refuses a dot name", []string{"project", "create", ".hidden"}, errUsage, "",
			`code-foundry project.create: a project name cannot start with "."`},
		// The test daemon's config home is under /tmp, outside the home directory.
		{"project create keeps projects under home", []string{"project", "create", "demo"}, errUsage, "", "outside your home directory"},
		{"project github publish needs a project", []string{"project", "github", "publish", "--owner", "me", "--visibility", "public"}, errUsage, "",
			"project.github.publish: missing --project (default: the active project; there is none)"},
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
		{"project context enables worktree.new", []string{"commands", "--context-project", "r1"}, `(?m)^Project\s+project\.worktree\.new\s+yes\s`},
	} {
		t.Run(tt.name, func(t *testing.T) {
			r := runCLI(c, tt.args...)
			if r.err != nil || !regexp.MustCompile(tt.want).MatchString(r.stdout) {
				t.Fatalf("err %v, stdout:\n%s\nwant match %s", r.err, r.stdout, tt.want)
			}
		})
	}

	t.Run("empty ids", func(t *testing.T) { testCLIRefusesEmptyIDs(t, c) })

	t.Run("unknown terminal is a clean not-found error", func(t *testing.T) {
		r := runCLI(c, "terminal.kill", "--id", "t1", "--yes")
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
	// A WatchIntents stream receives the intent but is no app window.
	var got struct{ Windows, Receivers int }
	if err := json.Unmarshal([]byte(r.stdout), &got); err != nil || got.Receivers != 1 || got.Windows != 0 {
		t.Fatalf("stdout = %q (err %v), want 1 receiver and no window", r.stdout, err)
	}
	if !stream.Receive() {
		t.Fatalf("stream ended: %v", stream.Err())
	}
	n := stream.Msg().GetNotify()
	if n.GetTitle() != "hi" || n.GetBody() != "there" || n.GetLevel().String() != "LEVEL_INFO" {
		t.Fatalf("intent = %v", stream.Msg())
	}
}
