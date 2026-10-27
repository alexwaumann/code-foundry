package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/api"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/client"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/internal/store/thread/threadtest"
)

// A thread whose transcript Claude Code deleted: the verbs that would run Claude print
// the daemon's words and exit 1 (a failure, not a usage mistake: no help pointer), and
// thread get says so. The thread store's own tests cover the refusal itself.
func TestCLITranscriptMissing(t *testing.T) {
	b := bus.New()
	fake := threadtest.New(b)
	fake.Put(thread.Thread{ID: "s-dead", Name: "old work", State: thread.StateDisconnected, Status: thread.StatusIdle,
		ClaudeSessionID: "c-1", TranscriptMissing: true})
	threads := api.NewThread(fake, b)
	reg := command.NewRegistry()
	emit := &commandtest.Emitter{Delivered: 1, OpenWindows: 1}
	for _, err := range []error{
		command.RegisterThread(reg, threads),
		command.RegisterThreadLifecycle(reg, threads, emit),
		command.RegisterSlash(reg, threads),
		command.RegisterMcp(reg, threads, emit),
	} {
		if err != nil {
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
	run := func(args ...string) (string, string, error) {
		var stdout, stderr bytes.Buffer
		cl := &cli{stdout: &stdout, stderr: &stderr, connect: func(context.Context) (*client.Client, error) { return c, nil },
			getwd: func() (string, error) { return "/work", nil }}
		err := cl.dispatch(context.Background(), args)
		return stdout.String(), stderr.String(), err
	}

	for _, tt := range []struct {
		name string
		args []string
	}{
		{"thread.send", []string{"thread", "send", "--id", "s-dead", "go on"}},
		{"thread.fork", []string{"thread", "fork", "--id", "s-dead"}},
		{"thread.mcp", []string{"thread", "mcp", "--id", "s-dead", "--refresh"}},
		{"thread.mcp-reconnect", []string{"thread", "mcp-reconnect", "--id", "s-dead", "--server", "github"}},
		{"thread.commands", []string{"thread", "commands", "--id", "s-dead"}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			stdout, stderr, err := run(tt.args...)
			if !errors.Is(err, errReported) {
				t.Fatalf("err = %v, want exit 1 (errReported)\nstderr: %s", err, stderr)
			}
			if want := "code-foundry " + tt.name + ": " + thread.TranscriptMissingMessage + "\n"; stderr != want || stdout != "" {
				t.Errorf("stdout %q\nstderr %q\nwant   %q", stdout, stderr, want)
			}
		})
	}
	if items, err := fake.Items(context.Background(), "s-dead"); err != nil || len(items.Items) > 0 {
		t.Errorf("the message was kept: %+v, %v", items.Items, err)
	}

	stdout, stderr, err := run("thread", "get", "s-dead")
	if err != nil || !strings.Contains(stdout, "transcript deleted: ") {
		t.Errorf("thread get: %v\n%s%s", err, stdout, stderr)
	}
	stdout, _, err = run("thread", "get", "s-dead", "--json")
	var got struct {
		TranscriptMissing bool `json:"transcriptMissing"`
	}
	if err != nil || json.Unmarshal([]byte(stdout), &got) != nil || !got.TranscriptMissing {
		t.Errorf("thread get --json: %v\n%s", err, stdout)
	}
}
