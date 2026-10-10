package commandtest

import (
	"context"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
)

// Session is a fake command.SessionBackend. Err, when set, is returned by every call.
// Sessions returned by Create/Fork/Reconnect/Rename echo the request; Get returns
// Current (default: a CONNECTED session with the requested id). List returns Current
// and Others.
type Session struct {
	Calls
	Err     error
	Current *v1.Session
	// Others are listed after Current.
	Others []*v1.Session
}

var _ command.SessionBackend = (*Session)(nil)

func (s *Session) do(m proto.Message) error {
	s.record(m)
	return s.Err
}

// Create echoes the request as a STARTING session "s1". With new_worktree the session
// is in /worktrees/s1 with created_worktree and base_ref set. workspace_id is echoed;
// with new_workspace the session belongs to "w-new" and runs in /worktrees/<repo>
// (repo_id, else the first repo).
func (s *Session) Create(_ context.Context, r *connect.Request[v1.CreateSessionRequest]) (*connect.Response[v1.CreateSessionResponse], error) {
	if err := s.do(r.Msg); err != nil {
		return nil, err
	}
	m := r.Msg
	out := &v1.Session{
		Id: "s1", RepoId: m.GetRepoId(), WorktreePath: m.GetWorktreePath(), Model: m.GetModel(), Effort: m.GetEffort(),
		Name: m.GetName(), State: v1.SessionState_SESSION_STATE_STARTING, PermissionMode: m.GetPermissionMode(),
		WorkspaceId: m.GetWorkspaceId(),
	}
	if nw := m.GetNewWorktree(); nw != nil {
		out.WorktreePath, out.CreatedWorktree, out.BaseRef = "/worktrees/s1", true, nw.GetBaseRef()
	}
	if nw := m.GetNewWorkspace(); nw != nil && len(nw.GetRepos()) > 0 {
		if out.RepoId == "" {
			out.RepoId = nw.GetRepos()[0]
		}
		out.WorkspaceId, out.WorktreePath, out.CreatedWorktree, out.BaseRef = "w-new", "/worktrees/"+out.RepoId, true, nw.GetBaseRef()
	}
	return connect.NewResponse(&v1.CreateSessionResponse{Session: out}), nil
}

// Fork returns session "s2" with ParentId set.
func (s *Session) Fork(_ context.Context, r *connect.Request[v1.ForkSessionRequest]) (*connect.Response[v1.ForkSessionResponse], error) {
	if err := s.do(r.Msg); err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.ForkSessionResponse{Session: &v1.Session{Id: "s2", ParentId: r.Msg.GetId(), Name: r.Msg.GetName()}}), nil
}

// List returns Current, if set, then Others.
func (s *Session) List(_ context.Context, r *connect.Request[v1.ListSessionsRequest]) (*connect.Response[v1.ListSessionsResponse], error) {
	if err := s.do(r.Msg); err != nil {
		return nil, err
	}
	var out []*v1.Session
	if s.Current != nil {
		out = append(out, s.Current)
	}
	out = append(out, s.Others...)
	return connect.NewResponse(&v1.ListSessionsResponse{Sessions: out}), nil
}

// Get returns Current with the requested id.
func (s *Session) Get(_ context.Context, r *connect.Request[v1.GetSessionRequest]) (*connect.Response[v1.GetSessionResponse], error) {
	if err := s.do(r.Msg); err != nil {
		return nil, err
	}
	cur := &v1.Session{State: v1.SessionState_SESSION_STATE_CONNECTED}
	if s.Current != nil {
		cur = proto.CloneOf(s.Current)
	}
	cur.Id = r.Msg.GetId()
	return connect.NewResponse(&v1.GetSessionResponse{Session: cur}), nil
}

// Rename echoes the new name.
func (s *Session) Rename(_ context.Context, r *connect.Request[v1.RenameSessionRequest]) (*connect.Response[v1.RenameSessionResponse], error) {
	if err := s.do(r.Msg); err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.RenameSessionResponse{Session: &v1.Session{Id: r.Msg.GetId(), Name: r.Msg.GetName()}}), nil
}

// Close records the request.
func (s *Session) Close(_ context.Context, r *connect.Request[v1.CloseSessionRequest]) (*connect.Response[v1.CloseSessionResponse], error) {
	if err := s.do(r.Msg); err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.CloseSessionResponse{}), nil
}

// Reconnect returns a STARTING session.
func (s *Session) Reconnect(_ context.Context, r *connect.Request[v1.ReconnectSessionRequest]) (*connect.Response[v1.ReconnectSessionResponse], error) {
	if err := s.do(r.Msg); err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.ReconnectSessionResponse{Session: &v1.Session{Id: r.Msg.GetId(), State: v1.SessionState_SESSION_STATE_STARTING}}), nil
}

// Remove records the request.
func (s *Session) Remove(_ context.Context, r *connect.Request[v1.RemoveSessionRequest]) (*connect.Response[v1.RemoveSessionResponse], error) {
	if err := s.do(r.Msg); err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.RemoveSessionResponse{}), nil
}

// Pin returns Current (default: a CONNECTED session) with the requested id and pin.
func (s *Session) Pin(_ context.Context, r *connect.Request[v1.PinSessionRequest]) (*connect.Response[v1.PinSessionResponse], error) {
	if err := s.do(r.Msg); err != nil {
		return nil, err
	}
	cur := &v1.Session{State: v1.SessionState_SESSION_STATE_CONNECTED}
	if s.Current != nil {
		cur = proto.CloneOf(s.Current)
	}
	cur.Id, cur.Pinned = r.Msg.GetId(), r.Msg.GetPinned()
	return connect.NewResponse(&v1.PinSessionResponse{Session: cur}), nil
}

// RunIn returns Current (default: a CONNECTED session in workspace "w-1") with the
// requested id. A disconnected session runs in the target at once; a live one gets it
// as pending_worktree_path. The target is worktree_path, else /worktrees/<repo_id>.
func (s *Session) RunIn(_ context.Context, r *connect.Request[v1.RunInSessionRequest]) (*connect.Response[v1.RunInSessionResponse], error) {
	if err := s.do(r.Msg); err != nil {
		return nil, err
	}
	cur := &v1.Session{State: v1.SessionState_SESSION_STATE_CONNECTED, WorkspaceId: "w-1"}
	if s.Current != nil {
		cur = proto.CloneOf(s.Current)
	}
	cur.Id = r.Msg.GetId()
	path := r.Msg.GetWorktreePath()
	if path == "" {
		path = "/worktrees/" + r.Msg.GetRepoId()
	}
	if cur.GetState() == v1.SessionState_SESSION_STATE_DISCONNECTED {
		cur.WorktreePath = path
	} else {
		cur.PendingWorktreePath = path
	}
	return connect.NewResponse(&v1.RunInSessionResponse{Session: cur}), nil
}
