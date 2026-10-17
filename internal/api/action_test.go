package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/action"
	"github.com/alexwaumann/code-foundry/internal/store/action/actiontest"
)

func newActionServer(t *testing.T) (*actiontest.Fake, codefoundryv1connect.ActionServiceClient) {
	t.Helper()
	b := bus.New()
	fake := actiontest.New(b)
	route := NewAction(fake, b).Route()
	mux := http.NewServeMux()
	mux.Handle(route.Path, route.Handler)
	srv := httptest.NewUnstartedServer(mux)
	srv.EnableHTTP2 = true
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return fake, codefoundryv1connect.NewActionServiceClient(srv.Client(), srv.URL)
}

func TestActionUnary(t *testing.T) {
	fake, c := newActionServer(t)
	ctx := context.Background()
	res, err := c.Create(ctx, connect.NewRequest(&v1.CreateActionRequest{
		RepoId: "web", Name: "Test", Command: "go test ./...", Icon: v1.ActionIcon_ACTION_ICON_TEST, InTerminal: true,
	}))
	if err != nil {
		t.Fatal(err)
	}
	a := res.Msg.GetAction()
	if a.GetId() == "" || a.GetIcon() != v1.ActionIcon_ACTION_ICON_TEST || !a.GetInTerminal() || a.GetCreatedAt() == nil {
		t.Fatalf("Create = %v", a)
	}
	if _, err := c.Create(ctx, connect.NewRequest(&v1.CreateActionRequest{RepoId: "web", Name: "test", Command: "x"})); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Errorf("duplicate: %v", err)
	}
	// An unset icon is the default; only set fields change.
	plain, err := c.Create(ctx, connect.NewRequest(&v1.CreateActionRequest{RepoId: "web", Name: "Build", Command: "make"}))
	if err != nil || plain.Msg.GetAction().GetIcon() != v1.ActionIcon_ACTION_ICON_PLAY {
		t.Fatalf("Create default icon = %v, %v", plain, err)
	}
	name, f := "Unit tests", false
	up, err := c.Update(ctx, connect.NewRequest(&v1.UpdateActionRequest{Id: a.GetId(), Name: &name, InTerminal: &f}))
	if err != nil || up.Msg.GetAction().GetName() != name || up.Msg.GetAction().GetInTerminal() || up.Msg.GetAction().GetCommand() != "go test ./..." {
		t.Fatalf("Update = %v, %v", up, err)
	}
	if _, err := c.Update(ctx, connect.NewRequest(&v1.UpdateActionRequest{Id: "a-nope", Name: &name})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("Update unknown: %v", err)
	}
	unspecified := v1.ActionIcon_ACTION_ICON_UNSPECIFIED
	if _, err := c.Update(ctx, connect.NewRequest(&v1.UpdateActionRequest{Id: a.GetId(), Icon: &unspecified})); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("Update to no icon: %v", err)
	}

	run, err := c.Run(ctx, connect.NewRequest(&v1.RunActionRequest{Action: "unit TESTS", ThreadId: "s1", RepoId: "web",
		Mode: v1.ActionRunMode_ACTION_RUN_MODE_TERMINAL}))
	if err != nil {
		t.Fatal(err)
	}
	r := run.Msg.GetRun()
	if r.GetMode() != v1.ActionRunMode_ACTION_RUN_MODE_TERMINAL || r.GetState() != v1.ActionRunState_ACTION_RUN_STATE_RUNNING ||
		r.GetTerminalId() == "" || r.GetTrigger() != v1.ActionRunTrigger_ACTION_RUN_TRIGGER_USER {
		t.Fatalf("Run = %v", r)
	}
	if ran := fake.Ran(); len(ran) != 1 || ran[0] != (action.RunOptions{Action: "unit TESTS", ThreadID: "s1", RepoID: "web", Mode: action.ModeTerminal}) {
		t.Errorf("Ran = %+v", ran)
	}
	if _, err := c.Run(ctx, connect.NewRequest(&v1.RunActionRequest{Action: "deploy", RepoId: "web"})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("Run unknown: %v", err)
	}

	waited := make(chan *v1.ActionRun, 1)
	go func() {
		res, err := c.WaitRun(ctx, connect.NewRequest(&v1.WaitActionRunRequest{RunId: r.GetId()}))
		if err != nil {
			t.Error(err)
			waited <- nil
			return
		}
		waited <- res.Msg.GetRun()
	}()
	time.Sleep(20 * time.Millisecond)
	if err := fake.Finish(r.GetId(), 2, "FAIL\n\xff"); err != nil {
		t.Fatal(err)
	}
	select {
	case w := <-waited:
		if w.GetState() != v1.ActionRunState_ACTION_RUN_STATE_EXITED || w.GetExitCode() != 2 || w.GetOutput() != "FAIL\n\uFFFD" {
			t.Errorf("WaitRun = %v", w)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("WaitRun did not return")
	}
	list, err := c.List(ctx, connect.NewRequest(&v1.ListActionsRequest{RepoId: "web"}))
	if err != nil || len(list.Msg.GetActions()) != 2 || len(list.Msg.GetRuns()) != 1 || list.Msg.GetRuns()[0].GetOutput() != "" {
		t.Fatalf("List = %v, %v", list, err)
	}
	if other, _ := c.List(ctx, connect.NewRequest(&v1.ListActionsRequest{RepoId: "api"})); len(other.Msg.GetActions())+len(other.Msg.GetRuns()) != 0 {
		t.Errorf("List api = %v", other.Msg)
	}
	if _, err := c.Delete(ctx, connect.NewRequest(&v1.DeleteActionRequest{Id: a.GetId()})); err != nil {
		t.Fatal(err)
	}
	if _, err := c.GetRun(ctx, connect.NewRequest(&v1.GetActionRunRequest{RunId: "r-nope"})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("GetRun unknown: %v", err)
	}
}

func TestActionWatch(t *testing.T) {
	fake, c := newActionServer(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if _, err := fake.Create(ctx, action.CreateOptions{RepoID: "web", Name: "Lint", Command: "make lint"}); err != nil {
		t.Fatal(err)
	}
	stream, err := c.Watch(ctx, connect.NewRequest(&v1.WatchActionsRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	next := func() *v1.ActionEvent {
		t.Helper()
		if !stream.Receive() {
			t.Fatalf("stream ended: %v", stream.Err())
		}
		return stream.Msg()
	}
	if s := next().GetSnapshot(); len(s.GetActions()) != 1 || s.GetActions()[0].GetName() != "Lint" {
		t.Fatalf("snapshot = %v", s)
	}
	r, err := fake.Run(ctx, action.RunOptions{Action: "lint", RepoID: "web", Worktree: "/w"})
	if err != nil {
		t.Fatal(err)
	}
	if u := next().GetRunUpdated(); u.GetId() != r.ID || u.GetState() != v1.ActionRunState_ACTION_RUN_STATE_RUNNING {
		t.Fatalf("run_updated = %v", u)
	}
	if err := fake.Finish(r.ID, 1, "secret output"); err != nil {
		t.Fatal(err)
	}
	if u := next().GetRunUpdated(); u.GetState() != v1.ActionRunState_ACTION_RUN_STATE_EXITED || u.GetOutput() != "" {
		t.Fatalf("run_updated = %v", u)
	}
	f := next().GetRunFinished()
	if f.GetRunId() != r.ID || f.GetExitCode() != 1 || f.GetActionName() != "Lint" || f.GetRepoId() != "web" ||
		f.GetMode() != v1.ActionRunMode_ACTION_RUN_MODE_BACKGROUND || f.GetTrigger() != v1.ActionRunTrigger_ACTION_RUN_TRIGGER_USER {
		t.Fatalf("run_finished = %v", f)
	}
	if err := fake.Delete(ctx, r.ActionID); err != nil {
		t.Fatal(err)
	}
	if id := next().GetRemovedId(); id != r.ActionID {
		t.Fatalf("removed_id = %q", id)
	}
}
