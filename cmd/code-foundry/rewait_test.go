package main

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/client"
)

// dropOnce serves thread.wait, thread.send and action.wait; its first Invoke fails as
// a daemon going away does (code), the rest succeed.
type dropOnce struct {
	codefoundryv1connect.UnimplementedCommandServiceHandler
	code connect.Code

	mu      sync.Mutex
	invoked []*v1.InvokeCommandRequest
}

func (f *dropOnce) List(context.Context, *connect.Request[v1.ListCommandsRequest]) (*connect.Response[v1.ListCommandsResponse], error) {
	str := v1.ArgType_ARG_TYPE_STRING
	waitArgs := []*v1.ArgSpec{
		{Name: "id", Type: str, Positional: true, Id: true, ContextBound: true},
		{Name: "until", Type: str},
		{Name: "for", Type: str, DefaultValue: "10m"},
	}
	return connect.NewResponse(&v1.ListCommandsResponse{Commands: []*v1.Command{
		{Name: "thread.wait", Available: true, Args: waitArgs},
		{Name: "thread.send", Available: true, Args: []*v1.ArgSpec{
			{Name: "id", Type: str, Id: true, ContextBound: true},
			{Name: "text", Type: str, Positional: true},
			{Name: "wait", Type: v1.ArgType_ARG_TYPE_BOOL},
			{Name: "for", Type: str, DefaultValue: "10m"},
		}},
		{Name: "action.wait", Available: true, Args: []*v1.ArgSpec{{Name: "run", Type: str, Positional: true, Id: true}}},
	}}), nil
}

func (f *dropOnce) Invoke(_ context.Context, req *connect.Request[v1.InvokeCommandRequest]) (*connect.Response[v1.InvokeCommandResponse], error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.invoked = append(f.invoked, req.Msg)
	if len(f.invoked) == 1 {
		return nil, connect.NewError(f.code, errors.New("context canceled"))
	}
	return connect.NewResponse(&v1.InvokeCommandResponse{Message: "thread s-1 is idle"}), nil
}

func TestCLIWaitsAgainAfterADaemonRestart(t *testing.T) {
	defer func(p time.Duration) { rewaitPause = p }(rewaitPause)
	rewaitPause = 0
	tests := []struct {
		name       string
		code       connect.Code
		args       []string
		wantErr    bool
		wantStderr string
		wantRetry  map[string]string // the second invoke's args; nil: none
		failFirst  bool              // the first reconnect fails (a daemon still stopping)
	}{
		{name: "thread wait waits again for what is left", code: connect.CodeCanceled,
			args:       []string{"thread", "wait", "s-1", "--until", "error", "--for", "1h"},
			wantStderr: "code-foundry thread.wait: the daemon stopped or restarted while waiting; waiting again\n",
			wantRetry:  map[string]string{"id": "s-1", "until": "error", "for": "59m59s"}},
		{name: "a reconnect that fails is tried again", code: connect.CodeCanceled, failFirst: true,
			args:      []string{"thread", "wait", "s-1"},
			wantRetry: map[string]string{"id": "s-1", "for": "9m59s"}},
		{name: "send --wait waits, not sends, again", code: connect.CodeUnavailable,
			args:      []string{"thread", "send", "--id", "s-1", "hi", "--wait"},
			wantRetry: map[string]string{"id": "s-1", "for": "9m59s"}},
		{name: "send without wait is not retried", code: connect.CodeUnavailable,
			args: []string{"thread", "send", "--id", "s-1", "hi"}, wantErr: true},
		{name: "action wait says what happened", code: connect.CodeCanceled,
			args: []string{"action", "wait", "r-1"}, wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := &dropOnce{code: tt.code}
			path, h := codefoundryv1connect.NewCommandServiceHandler(f)
			mux := http.NewServeMux()
			mux.Handle(path, h)
			srv := httptest.NewServer(mux)
			defer srv.Close()
			c := &client.Client{Command: codefoundryv1connect.NewCommandServiceClient(srv.Client(), srv.URL)}
			var stdout, stderr bytes.Buffer
			connects := 0
			cl := &cli{stdout: &stdout, stderr: &stderr,
				connect: func(context.Context) (*client.Client, error) {
					// lookup, invoke, then rewait's first reconnect.
					if connects++; tt.failFirst && connects == 3 {
						return nil, errors.New("another daemon is already running")
					}
					return c, nil
				},
				getwd: func() (string, error) { return "/work", nil }}
			err := cl.dispatch(context.Background(), tt.args)
			if tt.wantErr {
				if !errors.Is(err, errConnLost) || !strings.Contains(err.Error(), "daemon connection lost (it stopped or restarted)") || len(f.invoked) != 1 {
					t.Fatalf("err = %v after %d invokes, want the connection lost once", err, len(f.invoked))
				}
				return
			}
			if err != nil {
				t.Fatalf("err = %v\nstderr: %s", err, stderr.String())
			}
			if tt.wantStderr != "" && stderr.String() != tt.wantStderr {
				t.Errorf("stderr = %q, want %q", stderr.String(), tt.wantStderr)
			}
			if len(f.invoked) != 2 {
				t.Fatalf("%d invokes, want 2", len(f.invoked))
			}
			got := f.invoked[1]
			if got.GetName() != "thread.wait" || len(got.GetArgs()) != len(tt.wantRetry) {
				t.Fatalf("retried %s %v, want thread.wait %v", got.GetName(), got.GetArgs(), tt.wantRetry)
			}
			for k, v := range tt.wantRetry {
				if g := got.GetArgs()[k]; g != v && !(k == "for" && closeDuration(g, v)) {
					t.Errorf("retry %s = %q, want %q", k, g, v)
				}
			}
		})
	}
}

// thread wait --json prints an object on a timeout, so `| jq` gets input.
func TestCLIWaitTimeoutJSON(t *testing.T) {
	f := &dropOnce{code: connect.CodeDeadlineExceeded}
	cl, stdout, _ := fakeCommandCLI(t, f)
	err := cl.dispatch(context.Background(), []string{"thread", "wait", "s-1", "--json"})
	if err == nil || stdout.String() != `{"timedOut":true,"error":"context canceled"}`+"\n" {
		t.Fatalf("err %v, stdout %q", err, stdout.String())
	}
}

// closeDuration: a and b are durations at most a second apart (the test's own time).
func closeDuration(a, b string) bool {
	da, err1 := time.ParseDuration(a)
	db, err2 := time.ParseDuration(b)
	return err1 == nil && err2 == nil && (da-db).Abs() <= time.Second
}
