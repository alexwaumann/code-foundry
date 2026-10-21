package main

import (
	"bytes"
	"cmp"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/api"
	"github.com/alexwaumann/code-foundry/internal/client"
	"github.com/alexwaumann/code-foundry/internal/command"
)

// TestInvokeSecondStage: a command confirmed once may ask again (deleting uncommitted
// work) with args to merge. On a terminal the user is asked twice and the second yes
// adds --force; --yes (or no terminal) never answers the second question: the command's
// declined result stands when it has one, else it fails pointing at --force.
func TestInvokeSecondStage(t *testing.T) {
	var forced []string // the commands that ran with force
	reg := command.NewRegistry()
	for _, c := range []struct {
		name     string
		declined *command.Result
		asker    string // the command the second stage names (another one: plugin.act's button)
	}{
		{name: "x.remove"},
		{name: "x.cleanup", declined: &command.Result{Message: "kept 1 worktree: cf/d (uncommitted changes)"}},
		{name: "x.act", asker: "x.remove"},
	} {
		if err := reg.Register(command.Command{
			Name: c.name, Title: "X", Category: "X",
			Args:    []command.ArgSpec{{Name: "path", Type: command.String}, {Name: "force", Type: command.Bool}},
			Confirm: "Remove {path}?",
			Run: func(_ context.Context, _ command.Context, a command.Args) (command.Result, error) {
				if a.Bool("force") {
					forced = append(forced, c.name+" "+a.String("path"))
					return command.Result{Message: "removed " + a.String("path")}, nil
				}
				return command.Result{}, &command.ConfirmError{
					Command: cmp.Or(c.asker, c.name), Title: "Delete Uncommitted Work", Message: "cf/d at /wt/d has uncommitted work: 2 modified. Delete it?",
					Args: map[string]string{"force": "true"}, Declined: c.declined,
				}
			},
		}); err != nil {
			t.Fatal(err)
		}
	}
	path, h := codefoundryv1connect.NewCommandServiceHandler(api.NewCommand(reg))
	mux := http.NewServeMux()
	mux.Handle(path, h)
	srv := httptest.NewUnstartedServer(mux)
	srv.EnableHTTP2 = true
	srv.StartTLS()
	t.Cleanup(srv.Close)
	c := &client.Client{Command: codefoundryv1connect.NewCommandServiceClient(srv.Client(), srv.URL)}

	tests := []struct {
		name        string
		cmd         string
		yes         bool
		interactive bool
		stdin       string
		wantErr     error
		wantMsg     string // the response's message
		wantForced  bool
		wantStderr  []string
	}{
		{name: "terminal: yes twice deletes", cmd: "x.remove", interactive: true, stdin: "y\ny\n", wantMsg: "removed /wt/d", wantForced: true,
			wantStderr: []string{"Remove /wt/d? [y/N] ", "cf/d at /wt/d has uncommitted work: 2 modified. Delete it? [y/N] "}},
		{name: "terminal: no to the second", cmd: "x.remove", interactive: true, stdin: "y\nn\n", wantErr: errCancelled, wantStderr: []string{"cancelled"}},
		{name: "terminal: no to the second keeps the declined result", cmd: "x.cleanup", interactive: true, stdin: "y\nn\n",
			wantMsg: "kept 1 worktree: cf/d (uncommitted changes)"},
		{name: "terminal with --yes: the second is not asked", cmd: "x.remove", yes: true, interactive: true, wantErr: errUsage,
			wantStderr: []string{"code-foundry x.remove: cf/d at /wt/d has uncommitted work: 2 modified. Delete it?\n--yes does not answer this; re-run with --force to."}},
		{name: "--yes: refused", cmd: "x.remove", yes: true, wantErr: errUsage, wantStderr: []string{"re-run with --force to"}},
		{name: "--yes: the declined result stands", cmd: "x.cleanup", yes: true, wantMsg: "kept 1 worktree: cf/d (uncommitted changes)",
			wantStderr: []string{"--yes does not answer it; --force does"}},
		{name: "no terminal, no --yes: the first question", cmd: "x.remove", wantErr: errUsage, wantStderr: []string{"Remove /wt/d?\nRe-run with --yes to confirm."}},
		{name: "another command's second stage", cmd: "x.act", interactive: true, stdin: "y\ny\n", wantErr: errUsage, wantStderr: []string{"Run x.remove itself to answer this."}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			forced = nil
			var stdout, stderr bytes.Buffer
			cl := &cli{stdout: &stdout, stderr: &stderr, connect: func(context.Context) (*client.Client, error) { return c, nil },
				stdin: strings.NewReader(tt.stdin), interactive: func() bool { return tt.interactive }}
			res, err := cl.invoke(context.Background(), &v1.Command{Name: tt.cmd}, nil, map[string]string{"path": "/wt/d"}, tt.yes)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("err = %v, want %v\nstderr: %s", err, tt.wantErr, stderr.String())
			}
			if got := res.GetMessage(); got != tt.wantMsg {
				t.Errorf("message = %q, want %q", got, tt.wantMsg)
			}
			if (len(forced) > 0) != tt.wantForced {
				t.Errorf("forced runs = %q, want forced %v", forced, tt.wantForced)
			}
			for _, s := range tt.wantStderr {
				if !strings.Contains(stderr.String(), s) {
					t.Errorf("stderr = %q\nwant containing %q", stderr.String(), s)
				}
			}
		})
	}
}

// TestInvokeBindConfirm: a command whose confirmation binds the yes to what was shown
// (plugin consent) gets the digest back on the re-invoke after a yes on a terminal;
// --yes is never asked, so it sends none, and without a terminal the first question
// still points at --yes.
func TestInvokeBindConfirm(t *testing.T) {
	var got []string // the digests the command ran with
	reg := command.NewRegistry()
	if err := reg.Register(command.Command{
		Name: "x.enable", Title: "X", Category: "X",
		Args:        []command.ArgSpec{{Name: "name", Type: command.String}, {Name: "digest", Type: command.String}},
		Confirm:     "Enable {name}?",
		BindConfirm: "digest",
		Run: func(_ context.Context, _ command.Context, a command.Args) (command.Result, error) {
			got = append(got, a.String("digest"))
			return command.Result{Message: "enabled"}, nil
		},
	}); err != nil {
		t.Fatal(err)
	}
	path, h := codefoundryv1connect.NewCommandServiceHandler(api.NewCommand(reg))
	mux := http.NewServeMux()
	mux.Handle(path, h)
	srv := httptest.NewUnstartedServer(mux)
	srv.EnableHTTP2 = true
	srv.StartTLS()
	t.Cleanup(srv.Close)
	c := &client.Client{Command: codefoundryv1connect.NewCommandServiceClient(srv.Client(), srv.URL)}
	shown := command.ConfirmDigest("Enable hello?")

	tests := []struct {
		name        string
		yes         bool
		interactive bool
		want        []string
		wantErr     error
		wantStderr  string
	}{
		{name: "terminal: yes sends the digest", interactive: true, want: []string{shown}, wantStderr: "Enable hello? [y/N] "},
		{name: "--yes: no digest", yes: true, want: []string{""}},
		{name: "no terminal: points at --yes", wantErr: errUsage, wantStderr: "Re-run with --yes to confirm."},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got = nil
			var stdout, stderr bytes.Buffer
			cl := &cli{stdout: &stdout, stderr: &stderr, connect: func(context.Context) (*client.Client, error) { return c, nil },
				stdin: strings.NewReader("y\n"), interactive: func() bool { return tt.interactive }}
			_, err := cl.invoke(context.Background(), &v1.Command{Name: "x.enable"}, nil, map[string]string{"name": "hello"}, tt.yes)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("err = %v, want %v\nstderr: %s", err, tt.wantErr, stderr.String())
			}
			if strings.Join(got, ",") != strings.Join(tt.want, ",") {
				t.Errorf("ran with digests %q, want %q", got, tt.want)
			}
			if !strings.Contains(stderr.String(), tt.wantStderr) {
				t.Errorf("stderr = %q, want containing %q", stderr.String(), tt.wantStderr)
			}
		})
	}
}

func TestArgFlags(t *testing.T) {
	if got := argFlags(map[string]string{"force": "true", "mode": "x"}); got != "--force --mode=x" {
		t.Fatalf("argFlags = %q", got)
	}
}
