package command_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/structpb"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
)

func TestPluginSurfaceCommands(t *testing.T) {
	b := &commandtest.PluginSurface{Got: &v1.GetSurfaceResponse{
		State: &v1.SurfaceState{Instance: "hello/demo/thread:s-1", Phase: v1.SurfacePhase_SURFACE_PHASE_LIVE},
		View:  &v1.SurfaceView{Instance: "hello/demo/thread:s-1", Version: 4, ViewJson: `{"nodes":[{"key":"t","text":{"content":"hi"}}]}`},
		Elements: []*v1.SurfaceElement{{Key: "click", Kind: "click", Action: "click", Label: "Click"},
			{Key: "rerun", Kind: "command", Action: "plugin.hello.rerun", Label: "Rerun", Args: map[string]string{"run": "7"}},
			{Key: "t-log", Kind: "tab", Action: "tab", Label: "Log", Node: "run-tabs"}},
	}}
	reg := command.NewRegistry()
	if err := command.RegisterPluginSurface(reg, b); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	uctx := command.Context{ActiveThreadID: "s-1"}
	res, err := reg.Invoke(ctx, uctx, "plugin.surface", map[string]string{"name": "hello", "surface": "demo"})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"instance hello/demo/thread:s-1: live", "view version 4:\n{\n  \"nodes\": [",
		"KEY    KIND     ACTION                    LABEL  FORM  NODE", "click  click    click                     Click", "rerun  command  plugin.hello.rerun run=7  Rerun",
		"t-log  tab      tab                       Log          run-tabs"} {
		if !strings.Contains(res.Message, want) {
			t.Errorf("surface output lacks %q:\n%s", want, res.Message)
		}
	}
	want := &v1.GetSurfaceRequest{Ref: &v1.SurfaceRef{Plugin: "hello", Surface: "demo", Context: &v1.UiContext{ActiveThreadId: "s-1"}}}
	if got := b.Requests()[0]; !proto.Equal(got, want) {
		t.Errorf("request %v, want %v", got, want)
	}
	// --settle asks the daemon to wait for quiet, at most 30 s.
	for settle, ms := range map[string]int32{"2s": 2000, "5m": 30000} {
		n := len(b.Requests())
		if _, err := reg.Invoke(ctx, uctx, "plugin.surface", map[string]string{"name": "hello", "surface": "demo", "settle": settle}); err != nil {
			t.Fatal(err)
		}
		if got := b.Requests()[n].(*v1.GetSurfaceRequest).GetSettleMs(); got != ms {
			t.Errorf("--settle %s: settle_ms %d, want %d", settle, got, ms)
		}
	}
	if _, err := reg.Invoke(ctx, uctx, "plugin.surface", map[string]string{"name": "hello", "surface": "demo", "settle": "soon"}); err == nil ||
		!strings.Contains(err.Error(), "not a duration") {
		t.Errorf("bad --settle: %v", err)
	}

	// An event: the act, then the view after a 500 ms settle.
	n := len(b.Requests())
	res, err = reg.Invoke(ctx, uctx, "plugin.act", map[string]string{"name": "hello", "surface": "demo", "action": "save", "values": `{"name":"Ada","on":true}`})
	if err != nil || !strings.HasPrefix(res.Message, "acted on save (view version 4)\ninstance hello/demo/thread:s-1: live\nview version 4:") {
		t.Fatalf("act = %q, %v", res.Message, err)
	}
	reqs := b.Requests()[n:]
	act := reqs[1].(*v1.SurfaceActRequest)
	vals, _ := structpb.NewStruct(map[string]any{"name": "Ada", "on": true})
	if act.GetInstance() != "hello/demo/thread:s-1" || act.GetVersion() != 4 || act.GetAction() != "save" || !proto.Equal(act.GetValues(), vals) || act.Value != nil {
		t.Errorf("act request %v", act)
	}
	if after := reqs[2].(*v1.GetSurfaceRequest); after.GetRef().GetInstance() != "hello/demo/thread:s-1" || after.GetSettleMs() != 500 {
		t.Errorf("view after the act: %v", after)
	}
	if js, _ := res.EncodeJSON(); !strings.HasPrefix(js, `{"version":4,"surface":{"state":`) {
		t.Errorf("act --json %s", js)
	}
	n = len(b.Requests())
	res, err = reg.Invoke(ctx, uctx, "plugin.act", map[string]string{"name": "hello", "surface": "demo", "key": "click", "quiet": "true"})
	if err != nil || res.Message != "acted on click (view version 4)" || len(b.Requests()) != n+2 {
		t.Errorf("act --quiet = %q, %v (%d requests)", res.Message, err, len(b.Requests())-n)
	}
	if _, err := reg.Invoke(ctx, uctx, "plugin.act", map[string]string{"name": "hello", "surface": "demo"}); err == nil || !strings.Contains(err.Error(), "name the element") {
		t.Errorf("act without an element: %v", err)
	}
	if _, err := reg.Invoke(ctx, uctx, "plugin.act", map[string]string{"name": "hello", "surface": "demo", "key": "x", "values": "[1]"}); err == nil || !strings.Contains(err.Error(), "not a JSON object") {
		t.Errorf("bad values: %v", err)
	}
	res, err = reg.Invoke(ctx, uctx, "plugin.act", map[string]string{"name": "hello", "surface": "demo", "key": "f-project", "value": "p1", "version": "2", "quiet": "true"})
	if err != nil || res.Message != "acted on f-project (view version 2)" {
		t.Errorf("act with version = %q, %v", res.Message, err)
	}
	b.Got = &v1.GetSurfaceResponse{State: &v1.SurfaceState{Phase: v1.SurfacePhase_SURFACE_PHASE_NOT_RESPONDING, Message: "no view 10s after opening"}}
	if _, err := reg.Invoke(ctx, uctx, "plugin.act", map[string]string{"name": "hello", "surface": "demo", "key": "x"}); err == nil ||
		!strings.Contains(err.Error(), "sent no view yet (not responding: no view 10s after opening)") {
		t.Errorf("no view: %v", err)
	}
	if got := command.FormatSurface(b.Got); got != "instance : not responding: no view 10s after opening\n(no view yet)" {
		t.Errorf("format %q", got)
	}
}

// A command button runs its command through the registry with the panel's context, as
// the GUI does, passing the user's confirmation on.
func TestPluginActPressesCommandButtons(t *testing.T) {
	b := &commandtest.PluginSurface{Got: &v1.GetSurfaceResponse{
		State: &v1.SurfaceState{Instance: "hello/demo/thread:s-1", Phase: v1.SurfacePhase_SURFACE_PHASE_LIVE},
		View:  &v1.SurfaceView{Instance: "hello/demo/thread:s-1", Version: 4, ViewJson: `{"nodes":[]}`},
		Elements: []*v1.SurfaceElement{
			{Key: "rerun", Kind: "command", Action: "plugin.hello.rerun", Label: "Rerun", Args: map[string]string{"run": "7"}},
			{Key: "cancel", Kind: "command", Action: "plugin.hello.cancel", Label: "Cancel"},
			{Key: "save", Kind: "command", Action: "plugin.hello.save", Label: "Save", Form: "form"},
		},
	}}
	reg := command.NewRegistry()
	if err := command.RegisterPluginSurface(reg, b); err != nil {
		t.Fatal(err)
	}
	var ran []string
	record := func(_ context.Context, uctx command.Context, a command.Args) (command.Result, error) {
		ran = append(ran, fmt.Sprintf("thread=%s run=%s name=%s notify=%v", uctx.ActiveThreadID, a.String("run"), a.String("name"), a.Bool("notify")))
		return command.Result{Message: "done", JSON: map[string]int{"run": 8}}, nil
	}
	err := reg.RegisterAll(
		command.Command{Name: "plugin.hello.rerun", Title: "Rerun", Category: "Hello", Run: record,
			Args: []command.ArgSpec{{Name: "run", Type: command.String, Required: true}, {Name: "thread", Type: command.String, Context: command.ContextThread}}},
		command.Command{Name: "plugin.hello.cancel", Title: "Cancel", Category: "Hello", Run: record, Confirm: "Cancel the run?"},
		command.Command{Name: "plugin.hello.save", Title: "Save", Category: "Hello", Run: record,
			Args: []command.ArgSpec{{Name: "name", Type: command.String}, {Name: "notify", Type: command.Bool}}},
		command.Command{Name: "plugin.hello.fail", Title: "Fail", Category: "Hello",
			Run: func(context.Context, command.Context, command.Args) (command.Result, error) {
				return command.Result{}, command.Failed(errors.New("no such run"))
			}},
	)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	act := func(args map[string]string, opts ...command.InvokeOption) (command.Result, error) {
		args["name"], args["surface"] = "hello", "demo"
		return reg.Invoke(ctx, command.Context{}, "plugin.act", args, opts...)
	}
	tests := []struct {
		name    string
		args    map[string]string
		yes     bool
		wantMsg string
		wantRan string
		wantErr string
	}{
		{"by key, with the panel's thread", map[string]string{"key": "rerun", "thread": "s-1"}, false,
			"ran plugin.hello.rerun (the command of rerun): done\ninstance hello/demo/thread:s-1", "thread=s-1 run=7 name= notify=false", ""},
		{"by command name", map[string]string{"action": "plugin.hello.rerun", "quiet": "true"}, false,
			"ran plugin.hello.rerun (the command of rerun): done", "thread= run=7 name= notify=false", ""},
		{"a form's values become args", map[string]string{"key": "save", "values": `{"name":"Ada","notify":true}`, "quiet": "true"}, false,
			"ran plugin.hello.save (the command of save): done", "thread= run= name=Ada notify=true", ""},
		{"asks first", map[string]string{"key": "cancel"}, false, "", "", "Cancel the run?"},
		{"with --yes", map[string]string{"key": "cancel", "quiet": "true"}, true, "ran plugin.hello.cancel (the command of cancel): done", "thread= run= name= notify=false", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ran = nil
			res, err := act(tt.args, command.Confirmed(tt.yes))
			if tt.wantErr != "" {
				var ce *command.ConfirmError
				if !errors.As(err, &ce) || ce.Message != tt.wantErr || ce.Command != "plugin.hello.cancel" || len(ran) != 0 {
					t.Fatalf("err = %v, want the button's confirmation %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if !strings.HasPrefix(res.Message, tt.wantMsg) || len(ran) != 1 || ran[0] != tt.wantRan {
				t.Errorf("message %q, ran %q; want %q, %q", res.Message, ran, tt.wantMsg, tt.wantRan)
			}
			if js, _ := res.EncodeJSON(); !strings.Contains(js, `"result":{"run":8}`) {
				t.Errorf("json %s", js)
			}
		})
	}
	for _, r := range b.Requests() {
		if _, ok := r.(*v1.SurfaceActRequest); ok {
			t.Errorf("a command button reached Act: %v", r)
		}
	}
	// The command's own failure is plugin.act's.
	b.Got.Elements = append(b.Got.Elements, &v1.SurfaceElement{Key: "fail", Kind: "command", Action: "plugin.hello.fail", Label: "Fail"})
	if _, err := act(map[string]string{"key": "fail"}); !command.IsFailed(err) || err.Error() != "no such run" {
		t.Errorf("failing button: %v", err)
	}
}

func TestPullRequestChecks(t *testing.T) {
	at := time.Date(2026, 10, 18, 9, 0, 0, 0, time.UTC)
	b := &commandtest.PullRequestChecks{Res: &v1.GetPullRequestResponse{
		PullRequest: &v1.PullRequest{Url: "https://github.com/o/r/pull/7", HeadSha: "abc"},
		Checks: []*v1.CheckRun{
			{Name: "test", Workflow: "CI", Status: v1.CheckStatus_CHECK_STATUS_COMPLETED, Conclusion: v1.CheckConclusion_CHECK_CONCLUSION_FAILURE,
				App: "github-actions", Url: "https://github.com/o/r/actions/runs/1/job/2", StartedAt: timestamppb.New(at), CompletedAt: timestamppb.New(at.Add(time.Minute))},
			{Name: "lint", Status: v1.CheckStatus_CHECK_STATUS_IN_PROGRESS, Url: "https://github.com/o/r/actions/runs/1/job/3"},
			{Name: "jenkins", Status: v1.CheckStatus_CHECK_STATUS_PENDING, Url: "https://ci.example/1"},
		},
	}}
	reg := command.NewRegistry()
	err := command.RegisterPullRequestChecks(reg, command.PullRequestChecksDeps{Gh: b,
		ThreadPullRequest: func(_ context.Context, id string) (string, int, bool) { return "o/r", 7, id == "s-1" }})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	tests := []struct {
		name    string
		args    map[string]string
		uctx    command.Context
		wantErr string
		wantReq *v1.GetPullRequestRequest
	}{
		{"explicit", map[string]string{"repo-slug": "o/r", "number": "7"}, command.Context{}, "", &v1.GetPullRequestRequest{RepoSlug: "o/r", Number: 7}},
		{"thread", nil, command.Context{ActiveThreadID: "s-1"}, "", &v1.GetPullRequestRequest{RepoSlug: "o/r", Number: 7}},
		{"thread without one", nil, command.Context{ActiveThreadID: "s-2"}, "has no pull request", nil},
		{"nothing", nil, command.Context{}, "name a pull request", nil},
		{"slug only", map[string]string{"repo-slug": "o/r"}, command.Context{}, "positive pull request number", nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			n := len(b.Requests())
			res, err := reg.Invoke(ctx, tt.uctx, "pr.checks", tt.args)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Errorf("err = %v, want %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got := b.Requests()[n]; !proto.Equal(got, tt.wantReq) {
				t.Errorf("request %v", got)
			}
			js, _ := json.Marshal(res.JSON)
			for _, want := range []string{`"repo":"o/r","number":7`, `"status":"completed","conclusion":"failure","app":"github-actions","provider":"github-actions"`,
				`"name":"lint","status":"in_progress","provider":"github-actions"`, `"name":"jenkins","status":"pending","provider":"status"`} {
				if !strings.Contains(string(js), want) {
					t.Errorf("json lacks %s:\n%s", want, js)
				}
			}
			if !strings.Contains(res.Message, "CI / test  failure      github-actions") {
				t.Errorf("message:\n%s", res.Message)
			}
		})
	}
}
