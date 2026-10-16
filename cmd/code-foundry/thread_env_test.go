package main

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
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
	}{
		{name: "a thread's agent acts for its thread", env: map[string]string{paths.EnvThread: "s-agent"},
			args: []string{"action", "run", "test"}, wantThread: "s-agent"},
		{name: "an explicit --context-thread wins", env: map[string]string{paths.EnvThread: "s-agent"},
			args: []string{"action", "run", "test", "--context-thread", "s-other"}, wantThread: "s-other"},
		{name: "--context-thread= opts out", env: map[string]string{paths.EnvThread: "s-agent"},
			args: []string{"action", "run", "test", "--context-thread="}, wantThread: ""},
		{name: "outside a thread", env: map[string]string{}, args: []string{"action", "run", "test"}, wantThread: ""},
		{name: "no environment at all (tests)", args: []string{"action", "run", "test"}, wantThread: ""},
		{name: "a reported exit code ends the CLI with it after the output",
			args:     []string{"action", "run", "test", "--wait"},
			res:      &v1.InvokeCommandResponse{Message: "FAIL\nTest exited with code 3 (run r1)", ExitCode: 3},
			wantExit: 3, wantStdout: "FAIL\nTest exited with code 3 (run r1)\n"},
		{name: "exit code 0 is success", args: []string{"action", "run", "test", "--wait"},
			res: &v1.InvokeCommandResponse{Message: "ok"}, wantStdout: "ok\n"},
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
			if tt.wantStdout != "" && stdout.String() != tt.wantStdout {
				t.Errorf("stdout = %q, want %q", stdout.String(), tt.wantStdout)
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
