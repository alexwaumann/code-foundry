package command_test

import (
	"context"
	"slices"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	"github.com/alexwaumann/code-foundry/internal/store/notification"
	"github.com/alexwaumann/code-foundry/internal/store/notification/notificationtest"
)

// thread.flags lists a thread's flag notifications; thread.flag.clear asks the daemon to
// dismiss them; thread.get no longer prints flags.
func TestThreadFlagCommands(t *testing.T) {
	notes := notificationtest.New(t, notificationtest.Options{})
	ctx := context.Background()
	for _, p := range []notification.Post{
		{Source: "gh-actions", Key: notification.FlagKey("s-2", true), Level: notification.LevelError, Title: "deploy failed", ThreadID: "s-2"},
		{Source: "hello", Key: notification.FlagKey("s-2", false), Level: notification.LevelWarning, Title: "look", ThreadID: "s-2"},
		{Source: "hello", Key: "own", Title: "not a flag", ThreadID: "s-2"},
		{Source: "hello", Key: notification.FlagKey("s-3", false), Level: notification.LevelWarning, Title: "another thread", ThreadID: "s-3"},
	} {
		if _, err := notes.Post(ctx, p); err != nil {
			t.Fatal(err)
		}
	}
	at := notificationtest.T0.Local().Format(time.DateTime)
	gh, _ := notes.Active("gh-actions", notification.FlagKey("s-2", true))
	hello, _ := notes.Active("hello", notification.FlagKey("s-2", false))
	ids := []string{gh.ID, hello.ID}
	flagged := &v1.Thread{Name: "child", Status: v1.ThreadStatus_THREAD_STATUS_IDLE, WorktreePath: "/wt"}
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
			wantMsg: "PLUGIN      LEVEL      REASON         SET                  UNTIL SEEN  NOTIFICATION\n" +
				"gh-actions  error      deploy failed  " + at + "  yes         " + ids[0] + " (shown)\n" +
				"hello       attention  look           " + at + "  no          " + ids[1] + " (shown)",
			wantReqs: []proto.Message{&v1.GetThreadRequest{Id: "s-2"}}},
		{name: "no flags", cmd: "thread.flags", args: map[string]string{"id": "s-9"}, current: &v1.Thread{Name: "x"},
			wantMsg: "thread x (s-9) has no flags"},
		{name: "clear asks the daemon", cmd: "thread.flag.clear", args: map[string]string{"id": "s-2", "plugin": "hello"},
			current: &v1.Thread{Name: "child", Flags: []*v1.ThreadFlag{{Plugin: "hello"}}},
			wantMsg: "cleared 1 flag on thread child (s-2)", wantReqs: []proto.Message{&v1.ClearThreadFlagsRequest{Id: "s-2", Plugin: "hello"}}},
		{name: "clear none", cmd: "thread.flag.clear", args: map[string]string{"id": "s-2"}, current: &v1.Thread{}, wantCode: connect.CodeNotFound},
		{name: "get prints no flags", cmd: "thread.get", args: map[string]string{"id": "s-2"}, current: flagged,
			wantMsg: "thread child (s-2)\nstatus: idle\nworktree: /wt\ncost: $0.00"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg := command.NewRegistry()
			b := &commandtest.Thread{}
			if err := command.RegisterThreadLifecycle(reg, b, &commandtest.Emitter{}, command.WithFlagNotifications(notes)); err != nil {
				t.Fatal(err)
			}
			b.Current = tt.current
			res, err := reg.Invoke(ctx, command.Context{}, tt.cmd, tt.args)
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
			if tt.cmd == "thread.flags" && tt.name == "flags" {
				if js, _ := res.EncodeJSON(); !strings.Contains(js, `"threadId":"s-2"`) || !strings.Contains(js, `"plugin":"gh-actions","level":"error","reason":"deploy failed"`) ||
					!strings.Contains(js, `"untilSeen":true,"notificationId":"`+ids[0]+`","status":"shown"`) {
					t.Errorf("json = %s", js)
				}
			}
		})
	}
}

func TestPluginEnvCommand(t *testing.T) {
	reg, b := pluginFixture(t)
	if res, err := reg.Invoke(context.Background(), command.Context{}, "plugin.env", nil); err != nil || res.Message != "no plugin adds anything to new threads" {
		t.Fatalf("empty = %q, %v", res.Message, err)
	}
	b.Envs = []*v1.PluginEnvironment{{Plugin: "hello", Env: []*v1.PluginEnvVar{{Key: "CF_HELLO"}}, PathPrepend: []string{"/h/bin"},
		AddDirs: []string{"/h/data"}, Projects: []string{"p1"}, NoProject: true, Issues: []string{"env PATH is reserved for Code Foundry and Claude"}}}
	res, err := reg.Invoke(context.Background(), command.Context{}, "plugin.env", map[string]string{"name": "hello"})
	want := "plugin hello\n  scope: projects p1, and threads without a project\n  env CF_HELLO\n  PATH += /h/bin\n  --add-dir /h/data\n" +
		"  issue: env PATH is reserved for Code Foundry and Claude\n\n" +
		"New threads in scope get this, and new terminal shells in scope get the env and PATH entries too. " +
		"Running threads and shells keep what they started with; a thread shows \"Plugin environment changed\" until restarted (thread restart <id>)."
	if err != nil || res.Message != want {
		t.Errorf("plugin.env hello = %q, %v; want %q", res.Message, err, want)
	}
	if res, _ := reg.Invoke(context.Background(), command.Context{}, "plugin.env", map[string]string{"name": "quiet"}); res.Message != "plugin quiet adds nothing to new threads" {
		t.Errorf("quiet = %q", res.Message)
	}
}
