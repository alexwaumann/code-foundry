package command_test

import (
	"context"
	"encoding/json"
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
		State:    &v1.SurfaceState{Instance: "hello/demo/thread:s-1", Phase: v1.SurfacePhase_SURFACE_PHASE_LIVE},
		View:     &v1.SurfaceView{Instance: "hello/demo/thread:s-1", Version: 4, ViewJson: `{"nodes":[{"key":"t","text":{"content":"hi"}}]}`},
		Elements: []*v1.SurfaceElement{{Key: "click", Kind: "click", Action: "click", Label: "Click"}},
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
	for _, want := range []string{"instance hello/demo/thread:s-1: live", "view version 4:\n{\n  \"nodes\": [", "KEY    KIND   ACTION  LABEL  FORM", "click  click  click   Click"} {
		if !strings.Contains(res.Message, want) {
			t.Errorf("surface output lacks %q:\n%s", want, res.Message)
		}
	}
	want := &v1.GetSurfaceRequest{Ref: &v1.SurfaceRef{Plugin: "hello", Surface: "demo", Context: &v1.UiContext{ActiveThreadId: "s-1"}}}
	if got := b.Requests()[0]; !proto.Equal(got, want) {
		t.Errorf("request %v, want %v", got, want)
	}

	res, err = reg.Invoke(ctx, uctx, "plugin.act", map[string]string{"name": "hello", "surface": "demo", "action": "save", "values": `{"name":"Ada","on":true}`})
	if err != nil || res.Message != "acted on save (view version 4)" {
		t.Fatalf("act = %q, %v", res.Message, err)
	}
	act := b.Requests()[2].(*v1.SurfaceActRequest)
	vals, _ := structpb.NewStruct(map[string]any{"name": "Ada", "on": true})
	if act.GetInstance() != "hello/demo/thread:s-1" || act.GetVersion() != 4 || act.GetAction() != "save" || !proto.Equal(act.GetValues(), vals) || act.Value != nil {
		t.Errorf("act request %v", act)
	}
	if _, err := reg.Invoke(ctx, uctx, "plugin.act", map[string]string{"name": "hello", "surface": "demo"}); err == nil || !strings.Contains(err.Error(), "name the element") {
		t.Errorf("act without an element: %v", err)
	}
	if _, err := reg.Invoke(ctx, uctx, "plugin.act", map[string]string{"name": "hello", "surface": "demo", "key": "x", "values": "[1]"}); err == nil || !strings.Contains(err.Error(), "not a JSON object") {
		t.Errorf("bad values: %v", err)
	}
	res, err = reg.Invoke(ctx, uctx, "plugin.act", map[string]string{"name": "hello", "surface": "demo", "key": "f-project", "value": "p1", "version": "2"})
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
