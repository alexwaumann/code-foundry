package main

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/client"
	"github.com/alexwaumann/code-foundry/internal/paths"
)

// fakeArgCommands serves a thread.new with a created-by that defaults to the thread
// env and a thread.report whose data may come from a file or stdin, and records the
// args of each Invoke.
type fakeArgCommands struct {
	codefoundryv1connect.UnimplementedCommandServiceHandler

	mu   sync.Mutex
	args []map[string]string
}

func (f *fakeArgCommands) List(context.Context, *connect.Request[v1.ListCommandsRequest]) (*connect.Response[v1.ListCommandsResponse], error) {
	return connect.NewResponse(&v1.ListCommandsResponse{Commands: []*v1.Command{
		{Name: "thread.new", Title: "New Thread", Category: "Thread", Available: true, Args: []*v1.ArgSpec{
			{Name: "prompt", Type: v1.ArgType_ARG_TYPE_STRING},
			{Name: "created-by", Type: v1.ArgType_ARG_TYPE_STRING, DefaultToThreadEnv: true},
		}},
		{Name: "thread.report", Title: "Report", Category: "Thread", Available: true, Args: []*v1.ArgSpec{
			{Name: "status", Type: v1.ArgType_ARG_TYPE_ENUM, Positional: true},
			{Name: "data", Type: v1.ArgType_ARG_TYPE_STRING, FileOrStdin: true},
		}},
		{Name: "thread.subscribe", Title: "Subscribe", Category: "Thread", Available: true, Args: []*v1.ArgSpec{
			{Name: "plugin", Type: v1.ArgType_ARG_TYPE_STRING},
			{Name: "arg", Type: v1.ArgType_ARG_TYPE_STRING, Repeatable: true},
		}},
	}}), nil
}

func (f *fakeArgCommands) Invoke(_ context.Context, req *connect.Request[v1.InvokeCommandRequest]) (*connect.Response[v1.InvokeCommandResponse], error) {
	f.mu.Lock()
	f.args = append(f.args, req.Msg.GetArgs())
	f.mu.Unlock()
	return connect.NewResponse(&v1.InvokeCommandResponse{Message: "ok"}), nil
}

func TestCLIThreadEnvDefaultAndArgSources(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "r.json"), []byte(`{"n": 1}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	inThread := map[string]string{paths.EnvThread: "s-parent"}
	tests := []struct {
		name    string
		env     map[string]string
		stdin   string
		args    []string
		want    map[string]string
		wantErr string
	}{
		{name: "a thread's agent is the creator", env: inThread, args: []string{"thread", "new", "--prompt", "hi"},
			want: map[string]string{"prompt": "hi", "created-by": "s-parent"}},
		{name: "an explicit creator wins", env: inThread, args: []string{"thread", "new", "--created-by", "s-other"},
			want: map[string]string{"created-by": "s-other"}},
		{name: "--created-by= opts out", env: inThread, args: []string{"thread", "new", "--created-by="},
			want: map[string]string{"created-by": ""}},
		{name: "outside a thread nothing is sent", env: map[string]string{}, args: []string{"thread", "new"},
			want: map[string]string{}},
		{name: "data as given", args: []string{"thread", "report", "done", "--data", `{"n":2}`},
			want: map[string]string{"status": "done", "data": `{"n":2}`}},
		{name: "data from a file relative to the cwd", args: []string{"thread", "report", "done", "--data", "@r.json"},
			want: map[string]string{"status": "done", "data": `{"n": 1}` + "\n"}},
		{name: "data from stdin", stdin: `{"s":true}`, args: []string{"thread", "report", "done", "--data", "-"},
			want: map[string]string{"status": "done", "data": `{"s":true}`}},
		{name: "a missing file", args: []string{"thread", "report", "done", "--data", "@nope.json"}, wantErr: "--data: open"},
		{name: "a repeated flag's values joined by newlines", args: []string{"thread", "subscribe", "--plugin", "hello/tick", "--arg", "every=2s", "--arg=pr=a/b#1"},
			want: map[string]string{"plugin": "hello/tick", "arg": "every=2s\npr=a/b#1"}},
		{name: "a flag that does not repeat keeps the last value", args: []string{"thread", "subscribe", "--plugin", "a/b", "--plugin", "c/d"},
			want: map[string]string{"plugin": "c/d"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := &fakeArgCommands{}
			path, h := codefoundryv1connect.NewCommandServiceHandler(f)
			mux := http.NewServeMux()
			mux.Handle(path, h)
			srv := httptest.NewServer(mux)
			defer srv.Close()
			c := &client.Client{Command: codefoundryv1connect.NewCommandServiceClient(srv.Client(), srv.URL)}
			var stdout, stderr bytes.Buffer
			cl := &cli{
				stdout: &stdout, stderr: &stderr, stdin: strings.NewReader(tt.stdin),
				connect: func(context.Context) (*client.Client, error) { return c, nil },
				getwd:   func() (string, error) { return dir, nil },
			}
			if tt.env != nil {
				cl.getenv = func(k string) string { return tt.env[k] }
			}
			err := cl.dispatch(context.Background(), tt.args)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want %q", err, tt.wantErr)
				}
				if len(f.args) != 0 {
					t.Errorf("invoked with %v", f.args)
				}
				return
			}
			if err != nil {
				t.Fatalf("err = %v\nstderr: %s", err, stderr.String())
			}
			if len(f.args) != 1 {
				t.Fatalf("invoked %d times", len(f.args))
			}
			got := f.args[0]
			if len(got) != len(tt.want) {
				t.Errorf("args = %v, want %v", got, tt.want)
			}
			for k, v := range tt.want {
				if g, ok := got[k]; !ok || g != v {
					t.Errorf("arg %s = %q (%t), want %q", k, g, ok, v)
				}
			}
		})
	}
}
