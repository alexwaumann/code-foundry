package commandtest

import (
	"context"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
)

// Action is a fake command.ActionBackend. Every call is recorded; Err, when set, is
// returned by every call.
type Action struct {
	Calls
	Err error
	// Actions is what List returns (filtered by repo).
	Actions []*v1.Action
	// Started is what Run returns; its owner fields and mode are filled from the
	// request (mode BACKGROUND when unspecified). Default: run r1 of the action.
	Started *v1.ActionRun
	// Finished is what WaitRun returns. Default: Started, exited 0.
	Finished *v1.ActionRun
}

var _ command.ActionBackend = (*Action)(nil)

func (f *Action) do(m proto.Message) error {
	f.record(m)
	return f.Err
}

// List returns Actions in repo_id (all without one).
func (f *Action) List(_ context.Context, r *connect.Request[v1.ListActionsRequest]) (*connect.Response[v1.ListActionsResponse], error) {
	if err := f.do(r.Msg); err != nil {
		return nil, err
	}
	out := &v1.ListActionsResponse{}
	for _, a := range f.Actions {
		if r.Msg.GetProjectId() == "" || a.GetProjectId() == r.Msg.GetProjectId() {
			out.Actions = append(out.Actions, a)
		}
	}
	return connect.NewResponse(out), nil
}

// Create returns the action as requested, id "a-new".
func (f *Action) Create(_ context.Context, r *connect.Request[v1.CreateActionRequest]) (*connect.Response[v1.CreateActionResponse], error) {
	if err := f.do(r.Msg); err != nil {
		return nil, err
	}
	m := r.Msg
	return connect.NewResponse(&v1.CreateActionResponse{Action: &v1.Action{
		Id: "a-new", ProjectId: m.GetProjectId(), Name: m.GetName(), Command: m.GetCommand(), Icon: m.GetIcon(),
		InTerminal: m.GetInTerminal(), OnWorktreeCreate: m.GetOnWorktreeCreate(),
	}}), nil
}

// Update returns the action with the set fields applied.
func (f *Action) Update(_ context.Context, r *connect.Request[v1.UpdateActionRequest]) (*connect.Response[v1.UpdateActionResponse], error) {
	if err := f.do(r.Msg); err != nil {
		return nil, err
	}
	a := &v1.Action{Id: r.Msg.GetId()}
	for _, x := range f.Actions {
		if x.GetId() == r.Msg.GetId() {
			a = proto.CloneOf(x)
		}
	}
	if r.Msg.Name != nil {
		a.Name = r.Msg.GetName()
	}
	return connect.NewResponse(&v1.UpdateActionResponse{Action: a}), nil
}

// Delete records the request.
func (f *Action) Delete(_ context.Context, r *connect.Request[v1.DeleteActionRequest]) (*connect.Response[v1.DeleteActionResponse], error) {
	if err := f.do(r.Msg); err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.DeleteActionResponse{}), nil
}

// Run returns Started with the request's owner and mode.
func (f *Action) Run(_ context.Context, r *connect.Request[v1.RunActionRequest]) (*connect.Response[v1.RunActionResponse], error) {
	if err := f.do(r.Msg); err != nil {
		return nil, err
	}
	run := &v1.ActionRun{Id: "r1", ActionName: r.Msg.GetAction(), State: v1.ActionRunState_ACTION_RUN_STATE_RUNNING}
	if f.Started != nil {
		run = proto.CloneOf(f.Started)
	}
	run.ThreadId, run.WorktreePath, run.ProjectId = r.Msg.GetThreadId(), r.Msg.GetWorktreePath(), r.Msg.GetProjectId()
	if run.Mode == v1.ActionRunMode_ACTION_RUN_MODE_UNSPECIFIED {
		run.Mode = r.Msg.GetMode()
	}
	if run.Mode == v1.ActionRunMode_ACTION_RUN_MODE_UNSPECIFIED {
		run.Mode = v1.ActionRunMode_ACTION_RUN_MODE_BACKGROUND
	}
	if run.Mode == v1.ActionRunMode_ACTION_RUN_MODE_TERMINAL && run.TerminalId == "" {
		run.TerminalId = "t1"
	}
	return connect.NewResponse(&v1.RunActionResponse{Run: run}), nil
}

// WaitRun returns Finished.
func (f *Action) WaitRun(_ context.Context, r *connect.Request[v1.WaitActionRunRequest]) (*connect.Response[v1.WaitActionRunResponse], error) {
	if err := f.do(r.Msg); err != nil {
		return nil, err
	}
	run := &v1.ActionRun{Id: r.Msg.GetRunId(), State: v1.ActionRunState_ACTION_RUN_STATE_EXITED, Mode: v1.ActionRunMode_ACTION_RUN_MODE_BACKGROUND}
	if f.Finished != nil {
		run = proto.CloneOf(f.Finished)
	}
	return connect.NewResponse(&v1.WaitActionRunResponse{Run: run}), nil
}
