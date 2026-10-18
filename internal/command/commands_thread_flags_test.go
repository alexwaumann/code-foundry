package command_test

import (
	"context"
	"slices"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
)

func TestThreadFlagCommands(t *testing.T) {
	at := time.Date(2026, 10, 18, 9, 30, 0, 0, time.Local)
	flagged := &v1.Thread{Name: "child", Status: v1.ThreadStatus_THREAD_STATUS_IDLE, WorktreePath: "/wt", Flags: []*v1.ThreadFlag{
		{Plugin: "gh-actions", PluginDisplayName: "GitHub Actions", Level: v1.ThreadFlagLevel_THREAD_FLAG_LEVEL_ERROR, Reason: "deploy failed", SetAt: timestamppb.New(at), UntilSeen: true},
		{Plugin: "hello", Level: v1.ThreadFlagLevel_THREAD_FLAG_LEVEL_ATTENTION, Reason: "look", SetAt: timestamppb.New(at)},
	}}
	tests := []struct {
		name     string
		cmd      string
		args     map[string]string
		current  *v1.Thread
		wantCode connect.Code
		wantMsg  string
		wantReqs []proto.Message
	}{
		{name: "flags", cmd: "thread.flags", args: map[string]string{"id": "s-2"}, current: flagged,
			wantMsg: "PLUGIN      LEVEL      REASON         SET                  UNTIL SEEN\n" +
				"gh-actions  error      deploy failed  2026-10-18 09:30:00  yes\n" +
				"hello       attention  look           2026-10-18 09:30:00  no",
			wantReqs: []proto.Message{&v1.GetThreadRequest{Id: "s-2"}}},
		{name: "no flags", cmd: "thread.flags", args: map[string]string{"id": "s-2"}, current: &v1.Thread{Name: "x"},
			wantMsg: "thread x (s-2) has no flags"},
		{name: "clear one plugin's", cmd: "thread.flag.clear", args: map[string]string{"id": "s-2", "plugin": "hello"}, current: flagged,
			wantMsg: "cleared 1 flag on thread child (s-2)", wantReqs: []proto.Message{&v1.ClearThreadFlagsRequest{Id: "s-2", Plugin: "hello"}}},
		{name: "clear all", cmd: "thread.flag.clear", args: map[string]string{"id": "s-2"}, current: flagged,
			wantMsg: "cleared 2 flags on thread child (s-2)"},
		{name: "clear none", cmd: "thread.flag.clear", args: map[string]string{"id": "s-2"}, current: &v1.Thread{}, wantCode: connect.CodeNotFound},
		{name: "get lists them", cmd: "thread.get", args: map[string]string{"id": "s-2"}, current: flagged,
			wantMsg: "thread child (s-2)\nstatus: idle\nworktree: /wt\nflags: gh-actions error: deploy failed; hello attention: look\ncost: $0.00"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, b, _ := newLifecycleRegistry(t)
			b.Current = tt.current
			res, err := reg.Invoke(context.Background(), command.Context{}, tt.cmd, tt.args)
			if connect.CodeOf(err) != tt.wantCode && (tt.wantCode != 0 || err != nil) {
				t.Fatalf("err = %v, want %v", err, tt.wantCode)
			}
			if tt.wantCode != 0 {
				return
			}
			if res.Message != tt.wantMsg {
				t.Errorf("message = %q, want %q", res.Message, tt.wantMsg)
			}
			if tt.wantReqs != nil {
				if got := b.Requests(); !slices.EqualFunc(got[:len(tt.wantReqs)], tt.wantReqs, proto.Equal) {
					t.Errorf("requests = %v, want %v", got, tt.wantReqs)
				}
			}
		})
	}
	reg, b, _ := newLifecycleRegistry(t)
	b.Current = flagged
	res, err := reg.Invoke(context.Background(), command.Context{}, "thread.flags", map[string]string{"id": "s-2"})
	if err != nil {
		t.Fatal(err)
	}
	if js, _ := res.EncodeJSON(); !strings.Contains(js, `"threadId":"s-2"`) || !strings.Contains(js, `"pluginDisplayName":"GitHub Actions","level":"error"`) {
		t.Errorf("json = %s", js)
	}
}

func TestPluginEnvCommand(t *testing.T) {
	reg, b := pluginFixture(t)
	if res, err := reg.Invoke(context.Background(), command.Context{}, "plugin.env", nil); err != nil || res.Message != "no plugin adds anything to new threads" {
		t.Fatalf("empty = %q, %v", res.Message, err)
	}
	b.Envs = []*v1.PluginEnvironment{{Plugin: "hello", Env: []*v1.PluginEnvVar{{Key: "CF_HELLO", Value: "1"}}, PathPrepend: []string{"/h/bin"},
		AddDirs: []string{"/h/data"}, Projects: []string{"p1"}, NoProject: true, Issues: []string{"env PATH is reserved for Code Foundry and Claude"}}}
	res, err := reg.Invoke(context.Background(), command.Context{}, "plugin.env", map[string]string{"name": "hello"})
	want := "plugin hello\n  scope: projects p1, and threads without a project\n  env CF_HELLO\n  PATH += /h/bin\n  --add-dir /h/data\n" +
		"  issue: env PATH is reserved for Code Foundry and Claude"
	if err != nil || res.Message != want {
		t.Errorf("plugin.env hello = %q, %v; want %q", res.Message, err, want)
	}
	if res, _ := reg.Invoke(context.Background(), command.Context{}, "plugin.env", map[string]string{"name": "quiet"}); res.Message != "plugin quiet adds nothing to new threads" {
		t.Errorf("quiet = %q", res.Message)
	}
}
