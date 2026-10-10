package main

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/client"
)

var errNoDaemon = errors.New("no daemon in unit tests")

// newTestCLI returns a cli whose connect fails, for paths that must stay local.
func newTestCLI() (*cli, *bytes.Buffer, *bytes.Buffer) {
	var stdout, stderr bytes.Buffer
	return &cli{
		stdout:  &stdout,
		stderr:  &stderr,
		connect: func(context.Context) (*client.Client, error) { return nil, errNoDaemon },
		getwd:   func() (string, error) { return "/work", nil },
	}, &stdout, &stderr
}

func TestDispatchLocal(t *testing.T) {
	tests := []struct {
		name       string
		args       []string
		wantErr    error
		wantStdout string
		wantStderr string
	}{
		{"no args prints GUI hint", nil, nil, "code-foundry gui", ""},
		{"help", []string{"help"}, nil, "Built-in commands:", ""},
		{"help lists commands verb", []string{"--help"}, nil, "commands", ""},
		{"help for a local verb", []string{"help", "status"}, nil, "Show daemon status", ""},
		{"version", []string{"version"}, nil, "code-foundry ", ""},
		{"version -h", []string{"version", "-h"}, nil, "", "Usage of code-foundry version"},
		{"version bad flag", []string{"version", "--bogus"}, errUsage, "", "flag provided but not defined"},
		{"unknown leading flag", []string{"--bogus"}, errUsage, "", `unknown flag "--bogus"`},
		// A bare word that is not a local verb is a daemon command, which needs the daemon.
		{"daemon command needs daemon", []string{"bogus"}, errNoDaemon, "", ""},
		{"local verb plus word is a daemon command", []string{"daemon", "status"}, errNoDaemon, "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cl, stdout, stderr := newTestCLI()
			err := cl.dispatch(context.Background(), tt.args)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("err = %v, want %v", err, tt.wantErr)
			}
			if !strings.Contains(stdout.String(), tt.wantStdout) {
				t.Errorf("stdout = %q, want containing %q", stdout.String(), tt.wantStdout)
			}
			if !strings.Contains(stderr.String(), tt.wantStderr) {
				t.Errorf("stderr = %q, want containing %q", stderr.String(), tt.wantStderr)
			}
		})
	}
}

func TestResolveCommand(t *testing.T) {
	cmds := []*v1.Command{{Name: "terminal.new"}, {Name: "repo.worktree.new"}, {Name: "repo.refresh"}}
	tests := []struct {
		words    []string
		wantName string
		wantN    int
	}{
		{[]string{"terminal.new"}, "terminal.new", 1},
		{[]string{"terminal", "new"}, "terminal.new", 2},
		{[]string{"repo", "worktree", "new"}, "repo.worktree.new", 3},
		{[]string{"repo.worktree", "new"}, "repo.worktree.new", 2},
		{[]string{"repo", "refresh", "extra"}, "repo.refresh", 2},
		{[]string{"terminal"}, "", 0},
		{[]string{"bogus", "thing"}, "", 0},
		{nil, "", 0},
	}
	for _, tt := range tests {
		t.Run(strings.Join(tt.words, " "), func(t *testing.T) {
			cmd, n := resolveCommand(cmds, tt.words)
			if cmd.GetName() != tt.wantName || n != tt.wantN {
				t.Fatalf("got %q, %d; want %q, %d", cmd.GetName(), n, tt.wantName, tt.wantN)
			}
		})
	}
}

func TestLeadingWords(t *testing.T) {
	got := leadingWords([]string{"terminal", "new", "--cwd", "x", "y"})
	if strings.Join(got, " ") != "terminal new" {
		t.Fatalf("got %v", got)
	}
}

func TestAbsPath(t *testing.T) {
	cl, _, _ := newTestCLI()
	tests := []struct{ in, want string }{
		{"", ""},
		{".", "/work"},
		{"sub/dir", "/work/sub/dir"},
		{"../up", "/up"},
		{"/abs", "/abs"},
		{"~/proj", "~/proj"},
	}
	for _, tt := range tests {
		if got, err := cl.absPath(tt.in); err != nil || got != tt.want {
			t.Errorf("absPath(%q) = %q, %v; want %q", tt.in, got, err, tt.want)
		}
	}
}

func TestFormatVersion(t *testing.T) {
	tests := []struct{ v, commit, want string }{
		{"dev", "", "dev"},
		{"1.0.0", "abc", "1.0.0 (abc)"},
		{"1.0.0", "0123456789abcdef", "1.0.0 (0123456789ab)"},
		{"1.0.0", "0123456789abcdef-dirty", "1.0.0 (0123456789ab-dirty)"},
	}
	for _, tt := range tests {
		if got := formatVersion(tt.v, tt.commit); got != tt.want {
			t.Errorf("formatVersion(%q, %q) = %q, want %q", tt.v, tt.commit, got, tt.want)
		}
	}
}

func TestConnectOptionsFromEnv(t *testing.T) {
	tests := []struct {
		name    string
		env     map[string]string
		wantURL string // "" means the Unix socket
		wantErr bool
	}{
		{"outside a session", nil, "", false},
		{"inside a session", map[string]string{"CODE_FOUNDRY_ENDPOINT": "http://127.0.0.1:5555", "CODE_FOUNDRY_TOKEN": "t"}, "http://127.0.0.1:5555", false},
		{"endpoint without token", map[string]string{"CODE_FOUNDRY_ENDPOINT": "http://127.0.0.1:5555"}, "", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			opts, err := connectOptions(func(k string) string { return tt.env[k] })
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v", err)
			}
			got := ""
			if opts.Endpoint != nil {
				got = opts.Endpoint.BaseURL
			}
			if got != tt.wantURL {
				t.Fatalf("endpoint = %q, want %q", got, tt.wantURL)
			}
		})
	}
}
