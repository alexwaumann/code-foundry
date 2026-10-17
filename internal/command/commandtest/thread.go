package commandtest

import (
	"context"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/command"
)

// Thread is a fake command.ThreadBackend. Err, when set, is returned by every call.
// Threads returned by Create/Fork/Rename echo the request; Get returns
// Current (default: a CONNECTED thread with the requested id). List returns Current
// and Others.
type Thread struct {
	// The conversation RPCs (ListItems, Send, ...) are unimplemented.
	codefoundryv1connect.UnimplementedThreadServiceHandler
	Calls
	Err     error
	Current *v1.Thread
	// Others are listed after Current.
	Others []*v1.Thread
	// RetiredUsage is List's retired usage ledger.
	RetiredUsage []*v1.UsageBucket
	// Fired and Existed are Subscribe's answer flags; Subscriptions is what
	// ListSubscriptions returns and Unsubscribe removes from (thread_subscriptions.go).
	Fired, Existed bool
	Subscriptions  []*v1.ThreadSubscription
	// Reused is Create's answer flag (a repeated request_id).
	Reused bool
}

var _ command.ThreadBackend = (*Thread)(nil)

func (s *Thread) do(m proto.Message) error {
	s.record(m)
	return s.Err
}

// Create echoes the request as a STARTING thread "s1". With new_worktree the thread
// is in /worktrees/s1 with created_worktree and base_ref set. workspace_id is echoed;
// with new_workspace the thread belongs to "w-new" and runs in /worktrees/<repo>
// (repo_id, else the first repo). With no_project it runs in /home.
func (s *Thread) Create(_ context.Context, r *connect.Request[v1.CreateThreadRequest]) (*connect.Response[v1.CreateThreadResponse], error) {
	if err := s.do(r.Msg); err != nil {
		return nil, err
	}
	m := r.Msg
	out := &v1.Thread{
		Id: "s1", ProjectId: m.GetProjectId(), WorktreePath: m.GetWorktreePath(), Model: m.GetModel(), Effort: m.GetEffort(),
		Name: m.GetName(), State: v1.ThreadState_THREAD_STATE_STARTING, PermissionMode: m.GetPermissionMode(),
		WorkspaceId: m.GetWorkspaceId(), CreatedBy: m.GetCreatedBy(), Brief: m.GetBrief(), Labels: m.GetLabels(),
		BudgetUsd: m.GetBudgetUsd(),
	}
	if nw := m.GetNewWorktree(); nw != nil {
		out.WorktreePath, out.CreatedWorktree, out.BaseRef = "/worktrees/s1", true, nw.GetBaseRef()
	}
	if nw := m.GetNewWorkspace(); nw != nil && len(nw.GetProjects()) > 0 {
		if out.ProjectId == "" {
			out.ProjectId = nw.GetProjects()[0]
		}
		out.WorkspaceId, out.WorktreePath, out.CreatedWorktree, out.BaseRef = "w-new", "/worktrees/"+out.ProjectId, true, nw.GetBaseRef()
	}
	if m.GetNoProject() {
		out.WorktreePath = "/home"
	}
	return connect.NewResponse(&v1.CreateThreadResponse{Thread: out, Reused: s.Reused}), nil
}

// Fork returns thread "s2" with ParentId set.
func (s *Thread) Fork(_ context.Context, r *connect.Request[v1.ForkThreadRequest]) (*connect.Response[v1.ForkThreadResponse], error) {
	if err := s.do(r.Msg); err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.ForkThreadResponse{Thread: &v1.Thread{Id: "s2", ParentId: r.Msg.GetId(), Name: r.Msg.GetName()}}), nil
}

// List returns Current, if set, then Others.
func (s *Thread) List(_ context.Context, r *connect.Request[v1.ListThreadsRequest]) (*connect.Response[v1.ListThreadsResponse], error) {
	if err := s.do(r.Msg); err != nil {
		return nil, err
	}
	var out []*v1.Thread
	if s.Current != nil {
		out = append(out, s.Current)
	}
	out = append(out, s.Others...)
	return connect.NewResponse(&v1.ListThreadsResponse{Threads: out, RetiredUsage: s.RetiredUsage}), nil
}

// Get returns Current with the requested id.
func (s *Thread) Get(_ context.Context, r *connect.Request[v1.GetThreadRequest]) (*connect.Response[v1.GetThreadResponse], error) {
	if err := s.do(r.Msg); err != nil {
		return nil, err
	}
	cur := &v1.Thread{State: v1.ThreadState_THREAD_STATE_CONNECTED}
	if s.Current != nil {
		cur = proto.CloneOf(s.Current)
	}
	cur.Id = r.Msg.GetId()
	return connect.NewResponse(&v1.GetThreadResponse{Thread: cur}), nil
}

// Rename echoes the new name.
func (s *Thread) Rename(_ context.Context, r *connect.Request[v1.RenameThreadRequest]) (*connect.Response[v1.RenameThreadResponse], error) {
	if err := s.do(r.Msg); err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.RenameThreadResponse{Thread: &v1.Thread{Id: r.Msg.GetId(), Name: r.Msg.GetName()}}), nil
}

// Remove records the request.
func (s *Thread) Remove(_ context.Context, r *connect.Request[v1.RemoveThreadRequest]) (*connect.Response[v1.RemoveThreadResponse], error) {
	if err := s.do(r.Msg); err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.RemoveThreadResponse{}), nil
}

// Pin returns Current (default: a CONNECTED thread) with the requested id and pin.
func (s *Thread) Pin(_ context.Context, r *connect.Request[v1.PinThreadRequest]) (*connect.Response[v1.PinThreadResponse], error) {
	if err := s.do(r.Msg); err != nil {
		return nil, err
	}
	cur := &v1.Thread{State: v1.ThreadState_THREAD_STATE_CONNECTED}
	if s.Current != nil {
		cur = proto.CloneOf(s.Current)
	}
	cur.Id, cur.Pinned = r.Msg.GetId(), r.Msg.GetPinned()
	return connect.NewResponse(&v1.PinThreadResponse{Thread: cur}), nil
}

// Archive returns Current (default: a CONNECTED thread) with the requested id:
// archiving disconnects and unpins it and sets archived_at (kept when already set);
// unarchiving clears archived_at.
func (s *Thread) Archive(_ context.Context, r *connect.Request[v1.ArchiveThreadRequest]) (*connect.Response[v1.ArchiveThreadResponse], error) {
	if err := s.do(r.Msg); err != nil {
		return nil, err
	}
	cur := &v1.Thread{State: v1.ThreadState_THREAD_STATE_CONNECTED}
	if s.Current != nil {
		cur = proto.CloneOf(s.Current)
	}
	cur.Id = r.Msg.GetId()
	if !r.Msg.GetArchived() {
		cur.ArchivedAt = nil
	} else {
		cur.State, cur.Pinned = v1.ThreadState_THREAD_STATE_DISCONNECTED, false
		if cur.ArchivedAt == nil {
			cur.ArchivedAt = timestamppb.New(time.UnixMilli(1))
		}
	}
	return connect.NewResponse(&v1.ArchiveThreadResponse{Thread: cur}), nil
}

// Snooze returns Current (default: a CONNECTED thread) with the requested id:
// snoozing disconnects, unpins and unarchives it and sets snoozed_until to the request's
// until; an unset until clears snoozed_until.
func (s *Thread) Snooze(_ context.Context, r *connect.Request[v1.SnoozeThreadRequest]) (*connect.Response[v1.SnoozeThreadResponse], error) {
	if err := s.do(r.Msg); err != nil {
		return nil, err
	}
	cur := &v1.Thread{State: v1.ThreadState_THREAD_STATE_CONNECTED}
	if s.Current != nil {
		cur = proto.CloneOf(s.Current)
	}
	cur.Id = r.Msg.GetId()
	cur.SnoozedUntil = r.Msg.GetUntil()
	if cur.SnoozedUntil != nil {
		cur.State, cur.Pinned, cur.ArchivedAt = v1.ThreadState_THREAD_STATE_DISCONNECTED, false, nil
	}
	return connect.NewResponse(&v1.SnoozeThreadResponse{Thread: cur}), nil
}

// RunIn returns Current (default: a CONNECTED thread in workspace "w-1") with the
// requested id. A disconnected thread runs in the target at once; a live one gets it
// as pending_worktree_path. The target is worktree_path, else /worktrees/<repo_id>.
func (s *Thread) RunIn(_ context.Context, r *connect.Request[v1.RunInThreadRequest]) (*connect.Response[v1.RunInThreadResponse], error) {
	if err := s.do(r.Msg); err != nil {
		return nil, err
	}
	cur := &v1.Thread{State: v1.ThreadState_THREAD_STATE_CONNECTED, WorkspaceId: "w-1"}
	if s.Current != nil {
		cur = proto.CloneOf(s.Current)
	}
	cur.Id = r.Msg.GetId()
	path := r.Msg.GetWorktreePath()
	if path == "" {
		path = "/worktrees/" + r.Msg.GetProjectId()
	}
	if cur.GetState() == v1.ThreadState_THREAD_STATE_DISCONNECTED {
		cur.WorktreePath = path
	} else {
		cur.PendingWorktreePath = path
	}
	return connect.NewResponse(&v1.RunInThreadResponse{Thread: cur}), nil
}
