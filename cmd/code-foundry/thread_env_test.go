package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/client"
	"github.com/alexwaumann/code-foundry/internal/paths"
)

// fakeCommands serves one command, action.run, and records each Invoke.
type fakeCommands struct {
	codefoundryv1connect.UnimplementedCommandServiceHandler
	res *v1.InvokeCommandResponse

	mu      sync.Mutex
	invoked []*v1.InvokeCommandRequest
}

func (f *fakeCommands) List(context.Context, *connect.Request[v1.ListCommandsRequest]) (*connect.Response[v1.ListCommandsResponse], error) {
	return connect.NewResponse(&v1.ListCommandsResponse{Commands: []*v1.Command{{
		Name: "action.run", Title: "Run Action", Category: "Action", Available: true,
		Args: []*v1.ArgSpec{
			{Name: "action", Type: v1.ArgType_ARG_TYPE_STRING, Positional: true},
			{Name: "wait", Type: v1.ArgType_ARG_TYPE_BOOL},
		},
	}}}), nil
}

func (f *fakeCommands) Invoke(_ context.Context, req *connect.Request[v1.InvokeCommandRequest]) (*connect.Response[v1.InvokeCommandResponse], error) {
	f.mu.Lock()
	f.invoked = append(f.invoked, req.Msg)
	f.mu.Unlock()
	return connect.NewResponse(f.res), nil
}

func TestCLIThreadDefaultAndExitCode(t *testing.T) {
	tests := []struct {
		name       string
		env        map[string]string // nil: no getenv
		args       []string
		res        *v1.InvokeCommandResponse
		wantThread string
		wantExit   int
		wantStdout string
		wantStderr string
	}{
		{name: "a thread's agent acts for its thread", env: map[string]string{paths.EnvThread: "s-agent"},
			args: []string{"action", "run", "test"}, wantThread: "s-agent"},
		{name: "an explicit --context-thread wins", env: map[string]string{paths.EnvThread: "s-agent"},
			args: []string{"action", "run", "test", "--context-thread", "s-other"}, wantThread: "s-other"},
		{name: "--context-thread= opts out", env: map[string]string{paths.EnvThread: "s-agent"},
			args: []string{"action", "run", "test", "--context-thread="}, wantThread: ""},
		{name: "outside a thread", env: map[string]string{}, args: []string{"action", "run", "test"}, wantThread: ""},
		{name: "the name before threads (CODE_FOUNDRY_SESSION) is not read", env: map[string]string{"CODE_FOUNDRY_SESSION": "s-old"},
			args: []string{"action", "run", "test"}, wantThread: ""},
		{name: "no environment at all (tests)", args: []string{"action", "run", "test"}, wantThread: ""},
		{name: "a reported exit code ends the CLI with it after the output",
			args:     []string{"action", "run", "test", "--wait"},
			res:      &v1.InvokeCommandResponse{Message: "FAIL\nTest exited with code 3 (run r1)", ExitCode: 3},
			wantExit: 3, wantStdout: "FAIL\nTest exited with code 3 (run r1)\n",
			wantStderr: "code-foundry action.run: exited with code 3 from what it ran, not a usage mistake\n"},
		{name: "exit code 0 is success", args: []string{"action", "run", "test", "--wait"},
			res: &v1.InvokeCommandResponse{Message: "ok"}, wantStdout: "ok\n"},
		{name: "warnings go to stderr, the result stays on stdout", args: []string{"action", "run", "test"},
			res:        &v1.InvokeCommandResponse{Message: "13", Warnings: []string{"settings.toml does not parse"}},
			wantStdout: "13\n", wantStderr: "warning: settings.toml does not parse\n"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := &fakeCommands{res: tt.res}
			if f.res == nil {
				f.res = &v1.InvokeCommandResponse{Message: "started"}
			}
			path, h := codefoundryv1connect.NewCommandServiceHandler(f)
			mux := http.NewServeMux()
			mux.Handle(path, h)
			srv := httptest.NewServer(mux)
			defer srv.Close()
			c := &client.Client{Command: codefoundryv1connect.NewCommandServiceClient(srv.Client(), srv.URL)}
			var stdout, stderr bytes.Buffer
			cl := &cli{
				stdout: &stdout, stderr: &stderr,
				connect: func(context.Context) (*client.Client, error) { return c, nil },
				getwd:   func() (string, error) { return "/work", nil },
			}
			if tt.env != nil {
				cl.getenv = func(k string) string { return tt.env[k] }
			}
			err := cl.dispatch(context.Background(), tt.args)
			var exit exitCodeError
			switch {
			case tt.wantExit != 0:
				if !errors.As(err, &exit) || int(exit) != tt.wantExit {
					t.Fatalf("err = %v, want exit %d", err, tt.wantExit)
				}
			case err != nil:
				t.Fatalf("err = %v\nstderr: %s", err, stderr.String())
			}
			if stderr.String() != tt.wantStderr {
				t.Errorf("stderr = %q, want %q", stderr.String(), tt.wantStderr)
			}
			if tt.wantStdout != "" && stdout.String() != tt.wantStdout {
				t.Errorf("stdout = %q, want %q", stdout.String(), tt.wantStdout)
			}
			if stderr.String() != tt.wantStderr {
				t.Errorf("stderr = %q, want %q", stderr.String(), tt.wantStderr)
			}
			if len(f.invoked) != 1 {
				t.Fatalf("invoked %d times", len(f.invoked))
			}
			if got := f.invoked[0].GetContext().GetActiveThreadId(); got != tt.wantThread {
				t.Errorf("context thread = %q, want %q", got, tt.wantThread)
			}
		})
	}
}

// Help is trimmed only where a model reads it: a thread's Claude process, which alone has
// both variables. A thread's action run has the id alone, plugins and search runs the
// endpoint alone, and a plain terminal neither.
func TestHelpInAThread(t *testing.T) {
	path, h := codefoundryv1connect.NewCommandServiceHandler(&helpCommands{cmd: &v1.Command{
		Name: "thread.send", Title: "Send", Category: "Thread", Available: true, Args: []*v1.ArgSpec{
			{Name: "composer-text", Type: v1.ArgType_ARG_TYPE_STRING, Description: "Composer text (the GUI sets it)"},
		}}})
	mux := http.NewServeMux()
	mux.Handle(path, h)
	srv := httptest.NewServer(mux)
	defer srv.Close()
	c := &client.Client{Command: codefoundryv1connect.NewCommandServiceClient(srv.Client(), srv.URL)}
	for _, tt := range []struct {
		name    string
		env     map[string]string
		trimmed bool
	}{
		{"a thread's Claude process", map[string]string{paths.EnvThread: "s-1", paths.EnvEndpoint: "http://127.0.0.1:1"}, true},
		{"a thread's action run", map[string]string{paths.EnvThread: "s-1"}, false},
		{"a plugin or a search run", map[string]string{paths.EnvEndpoint: "http://127.0.0.1:1"}, false},
		{"a plain terminal", map[string]string{}, false},
		{"no environment at all", nil, false},
	} {
		for _, args := range [][]string{{"help", "thread", "send"}, {"thread", "send", "-h"}, {"thread.send", "--help"}} {
			var stdout bytes.Buffer
			cl := &cli{stdout: &stdout, stderr: io.Discard, getwd: func() (string, error) { return "/work", nil },
				connect: func(context.Context) (*client.Client, error) { return c, nil }}
			if tt.env != nil {
				cl.getenv = func(k string) string { return tt.env[k] }
			}
			if err := cl.dispatch(context.Background(), args); err != nil {
				t.Fatalf("%s: %v: %v", tt.name, args, err)
			}
			out := stdout.String()
			if got := !strings.Contains(out, "--composer-text") && !strings.Contains(out, "--context-worktree path"); got != tt.trimmed {
				t.Errorf("%s: %v trimmed %t, want %t:\n%s", tt.name, args, got, tt.trimmed, out)
			}
		}
	}
}

// helpCommands serves one command, for help to read.
type helpCommands struct {
	codefoundryv1connect.UnimplementedCommandServiceHandler
	cmd *v1.Command
}

func (f *helpCommands) List(context.Context, *connect.Request[v1.ListCommandsRequest]) (*connect.Response[v1.ListCommandsResponse], error) {
	return connect.NewResponse(&v1.ListCommandsResponse{Commands: []*v1.Command{f.cmd}}), nil
}
