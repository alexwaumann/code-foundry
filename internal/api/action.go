package api

import (
	"context"
	"errors"
	"strings"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/action"
)

// Action implements codefoundryv1connect.ActionServiceHandler over an action.Store.
type Action struct {
	store action.Store
	bus   *bus.Bus
}

var _ codefoundryv1connect.ActionServiceHandler = (*Action)(nil)

// NewAction returns an ActionService handler. b must be the bus the store publishes
// action.Event on.
func NewAction(store action.Store, b *bus.Bus) *Action { return &Action{store: store, bus: b} }

// Route mounts the service.
func (h *Action) Route(opts ...connect.HandlerOption) Route {
	path, handler := codefoundryv1connect.NewActionServiceHandler(h, opts...)
	return Route{Path: path, Handler: handler}
}

// List returns a project's actions (every project's without project_id) and the runs.
func (h *Action) List(_ context.Context, req *connect.Request[v1.ListActionsRequest]) (*connect.Response[v1.ListActionsResponse], error) {
	snap := h.store.Snapshot()
	projectID := req.Msg.GetProjectId()
	out := &v1.ListActionsResponse{Actions: actionsToProto(snap.ForProject(projectID))}
	for _, r := range snap.Runs {
		if projectID == "" || r.ProjectID == projectID {
			out.Runs = append(out.Runs, actionRunToProto(r))
		}
	}
	return connect.NewResponse(out), nil
}

// Create adds an action.
func (h *Action) Create(ctx context.Context, req *connect.Request[v1.CreateActionRequest]) (*connect.Response[v1.CreateActionResponse], error) {
	m := req.Msg
	a, err := h.store.Create(ctx, action.CreateOptions{
		ProjectID: m.GetProjectId(), Name: m.GetName(), Command: m.GetCommand(), Icon: actionIconFromProto(m.GetIcon()),
		InTerminal: m.GetInTerminal(), OnWorktreeCreate: m.GetOnWorktreeCreate(),
	})
	if err != nil {
		return nil, actionError(err)
	}
	return connect.NewResponse(&v1.CreateActionResponse{Action: actionToProto(a)}), nil
}

// Update changes the fields that are set.
func (h *Action) Update(ctx context.Context, req *connect.Request[v1.UpdateActionRequest]) (*connect.Response[v1.UpdateActionResponse], error) {
	m := req.Msg
	o := action.UpdateOptions{ID: m.GetId(), Name: m.Name, Command: m.Command, InTerminal: m.InTerminal, OnWorktreeCreate: m.OnWorktreeCreate}
	if m.Icon != nil {
		icon := actionIconFromProto(m.GetIcon())
		if icon == "" {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("icon: unspecified"))
		}
		o.Icon = &icon
	}
	if m.Position != nil {
		p := int(m.GetPosition())
		o.Position = &p
	}
	a, err := h.store.Update(ctx, o)
	if err != nil {
		return nil, actionError(err)
	}
	return connect.NewResponse(&v1.UpdateActionResponse{Action: actionToProto(a)}), nil
}

// Delete forgets an action.
func (h *Action) Delete(ctx context.Context, req *connect.Request[v1.DeleteActionRequest]) (*connect.Response[v1.DeleteActionResponse], error) {
	if err := h.store.Delete(ctx, req.Msg.GetId()); err != nil {
		return nil, actionError(err)
	}
	return connect.NewResponse(&v1.DeleteActionResponse{}), nil
}

// Run starts an action for a thread or a worktree.
func (h *Action) Run(ctx context.Context, req *connect.Request[v1.RunActionRequest]) (*connect.Response[v1.RunActionResponse], error) {
	m := req.Msg
	mode := action.ModeDefault
	switch m.GetMode() {
	case v1.ActionRunMode_ACTION_RUN_MODE_TERMINAL:
		mode = action.ModeTerminal
	case v1.ActionRunMode_ACTION_RUN_MODE_BACKGROUND:
		mode = action.ModeBackground
	}
	r, err := h.store.Run(ctx, action.RunOptions{
		Action: m.GetAction(), ThreadID: m.GetThreadId(), Worktree: m.GetWorktreePath(), ProjectID: m.GetProjectId(), Mode: mode,
	})
	if err != nil {
		return nil, actionError(err)
	}
	return connect.NewResponse(&v1.RunActionResponse{Run: actionRunToProto(r)}), nil
}

// GetRun returns a run with its output so far.
func (h *Action) GetRun(ctx context.Context, req *connect.Request[v1.GetActionRunRequest]) (*connect.Response[v1.GetActionRunResponse], error) {
	r, err := h.store.GetRun(ctx, req.Msg.GetRunId())
	if err != nil {
		return nil, actionError(err)
	}
	return connect.NewResponse(&v1.GetActionRunResponse{Run: actionRunToProto(r)}), nil
}

// WaitRun returns a run once it has finished.
func (h *Action) WaitRun(ctx context.Context, req *connect.Request[v1.WaitActionRunRequest]) (*connect.Response[v1.WaitActionRunResponse], error) {
	r, err := h.store.Wait(ctx, req.Msg.GetRunId())
	if err != nil {
		return nil, actionError(err)
	}
	return connect.NewResponse(&v1.WaitActionRunResponse{Run: actionRunToProto(r)}), nil
}

// StopRun ends a running run and returns it (usually still running).
func (h *Action) StopRun(ctx context.Context, req *connect.Request[v1.StopActionRunRequest]) (*connect.Response[v1.StopActionRunResponse], error) {
	r, err := h.store.StopRun(ctx, req.Msg.GetRunId())
	if err != nil {
		return nil, actionError(err)
	}
	return connect.NewResponse(&v1.StopActionRunResponse{Run: actionRunToProto(r)}), nil
}

// Watch sends a snapshot, then every action event; a fresh snapshot after drops.
func (h *Action) Watch(ctx context.Context, _ *connect.Request[v1.WatchActionsRequest], stream *connect.ServerStream[v1.ActionEvent]) error {
	sub := bus.Subscribe[action.Event](h.bus, watchBuffer)
	defer sub.Close()
	if err := stream.Send(actionEventToProto(h.store.Snapshot())); err != nil {
		return err
	}
	var dropped uint64
	for {
		select {
		case <-ctx.Done():
			return nil
		case ev, ok := <-sub.C():
			if !ok {
				return nil
			}
			if d := sub.Dropped(); d != dropped {
				dropped = d
				ev = h.store.Snapshot()
			}
			if msg := actionEventToProto(ev); msg != nil {
				if err := stream.Send(msg); err != nil {
					return err
				}
			}
		}
	}
}

// actionEventToProto converts a bus event (or a *action.Snapshot) to the wire event.
func actionEventToProto(ev action.Event) *v1.ActionEvent {
	switch e := ev.(type) {
	case *action.Snapshot:
		snap := &v1.ActionSnapshot{Actions: actionsToProto(e.Actions)}
		for _, r := range e.Runs {
			snap.Runs = append(snap.Runs, actionRunToProto(r))
		}
		return &v1.ActionEvent{Event: &v1.ActionEvent_Snapshot{Snapshot: snap}}
	case action.Updated:
		return &v1.ActionEvent{Event: &v1.ActionEvent_Updated{Updated: actionToProto(e.Action)}}
	case action.Removed:
		return &v1.ActionEvent{Event: &v1.ActionEvent_RemovedId{RemovedId: e.ID}}
	case action.RunUpdated:
		r := e.Run
		r.Output = "" // events never carry output
		return &v1.ActionEvent{Event: &v1.ActionEvent_RunUpdated{RunUpdated: actionRunToProto(r)}}
	case action.RunRemoved:
		return &v1.ActionEvent{Event: &v1.ActionEvent_RunRemovedId{RunRemovedId: e.ID}}
	case action.RunFinished:
		return &v1.ActionEvent{Event: &v1.ActionEvent_RunFinished{RunFinished: &v1.ActionRunFinished{
			RunId: e.RunID, ActionId: e.ActionID, ActionName: e.ActionName, ProjectId: e.ProjectID, ThreadId: e.ThreadID,
			ExitCode: int32(e.ExitCode), Mode: actionModeToProto(e.Mode), Trigger: actionTriggerToProto(e.Trigger),
			TerminalId: e.TerminalID,
		}}}
	}
	return nil
}

var actionIcons = map[string]v1.ActionIcon{
	action.IconPlay:      v1.ActionIcon_ACTION_ICON_PLAY,
	action.IconTest:      v1.ActionIcon_ACTION_ICON_TEST,
	action.IconLint:      v1.ActionIcon_ACTION_ICON_LINT,
	action.IconConfigure: v1.ActionIcon_ACTION_ICON_CONFIGURE,
	action.IconBuild:     v1.ActionIcon_ACTION_ICON_BUILD,
	action.IconDebug:     v1.ActionIcon_ACTION_ICON_DEBUG,
}

// actionIconFromProto is the store's icon name; "" for UNSPECIFIED (Create's default).
func actionIconFromProto(i v1.ActionIcon) string {
	for name, p := range actionIcons {
		if p == i {
			return name
		}
	}
	return ""
}

func actionsToProto(as []action.Action) []*v1.Action {
	out := make([]*v1.Action, len(as))
	for i, a := range as {
		out[i] = actionToProto(a)
	}
	return out
}

func actionToProto(a action.Action) *v1.Action {
	p := &v1.Action{
		Id: a.ID, ProjectId: a.ProjectID, Name: a.Name, Command: a.Command, Icon: actionIcons[a.Icon],
		InTerminal: a.InTerminal, OnWorktreeCreate: a.OnWorktreeCreate, Position: int32(a.Position),
	}
	if !a.CreatedAt.IsZero() {
		p.CreatedAt = timestamppb.New(a.CreatedAt)
	}
	if !a.UpdatedAt.IsZero() {
		p.UpdatedAt = timestamppb.New(a.UpdatedAt)
	}
	return p
}

func actionModeToProto(m action.Mode) v1.ActionRunMode {
	switch m {
	case action.ModeTerminal:
		return v1.ActionRunMode_ACTION_RUN_MODE_TERMINAL
	case action.ModeBackground:
		return v1.ActionRunMode_ACTION_RUN_MODE_BACKGROUND
	}
	return v1.ActionRunMode_ACTION_RUN_MODE_UNSPECIFIED
}

func actionTriggerToProto(t action.Trigger) v1.ActionRunTrigger {
	switch t {
	case action.TriggerUser:
		return v1.ActionRunTrigger_ACTION_RUN_TRIGGER_USER
	case action.TriggerWorktreeCreate:
		return v1.ActionRunTrigger_ACTION_RUN_TRIGGER_WORKTREE_CREATE
	}
	return v1.ActionRunTrigger_ACTION_RUN_TRIGGER_UNSPECIFIED
}

func actionRunToProto(r action.Run) *v1.ActionRun {
	p := &v1.ActionRun{
		Id: r.ID, ActionId: r.ActionID, ActionName: r.ActionName, Command: r.Command, ProjectId: r.ProjectID,
		ThreadId: r.ThreadID, WorktreePath: r.Worktree, Mode: actionModeToProto(r.Mode), TerminalId: r.TerminalID,
		// A proto string must be valid UTF-8 (the store already replaces invalid bytes).
		Trigger: actionTriggerToProto(r.Trigger), Output: strings.ToValidUTF8(r.Output, "\uFFFD"), OutputTruncated: r.Truncated,
		State: v1.ActionRunState_ACTION_RUN_STATE_RUNNING,
	}
	if r.State == action.RunExited {
		p.State, p.ExitCode = v1.ActionRunState_ACTION_RUN_STATE_EXITED, int32(r.ExitCode)
	}
	if !r.StartedAt.IsZero() {
		p.StartedAt = timestamppb.New(r.StartedAt)
	}
	if !r.FinishedAt.IsZero() {
		p.FinishedAt = timestamppb.New(r.FinishedAt)
	}
	return p
}

// actionError maps store errors to Connect codes.
func actionError(err error) error {
	code := connect.CodeInternal
	switch {
	case errors.Is(err, action.ErrNotFound):
		code = connect.CodeNotFound
	case errors.Is(err, action.ErrInvalidArgument):
		code = connect.CodeInvalidArgument
	case errors.Is(err, action.ErrFailedPrecondition):
		code = connect.CodeFailedPrecondition
	case errors.Is(err, action.ErrClosed):
		code = connect.CodeUnavailable
	case errors.Is(err, context.Canceled):
		code = connect.CodeCanceled
	case errors.Is(err, context.DeadlineExceeded):
		code = connect.CodeDeadlineExceeded
	}
	return connect.NewError(code, err)
}
