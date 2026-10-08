package commandtest

import (
	"context"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	v1 "github.com/awaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/awaumann/code-foundry/internal/command"
)

// Session is a fake command.SessionBackend. Err, when set, is returned by every call.
// Sessions returned by Create/Fork/Reconnect/Rename echo the request; Get returns
// Current (default: a CONNECTED session with the requested id).
type Session struct {
	Calls
	Err     error
	Current *v1.Session
}

var _ command.SessionBackend = (*Session)(nil)

func (s *Session) do(m proto.Message) error {
	s.record(m)
	return s.Err
}

// Create echoes the request as a STARTING session "s1".
func (s *Session) Create(_ context.Context, r *connect.Request[v1.CreateSessionRequest]) (*connect.Response[v1.CreateSessionResponse], error) {
	if err := s.do(r.Msg); err != nil {
		return nil, err
	}
	m := r.Msg
	return connect.NewResponse(&v1.CreateSessionResponse{Session: &v1.Session{
		Id: "s1", RepoId: m.GetRepoId(), WorktreePath: m.GetWorktreePath(), Model: m.GetModel(), Effort: m.GetEffort(),
		Name: m.GetName(), State: v1.SessionState_SESSION_STATE_STARTING,
	}}), nil
}

// Fork returns session "s2" with ParentId set.
func (s *Session) Fork(_ context.Context, r *connect.Request[v1.ForkSessionRequest]) (*connect.Response[v1.ForkSessionResponse], error) {
	if err := s.do(r.Msg); err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.ForkSessionResponse{Session: &v1.Session{Id: "s2", ParentId: r.Msg.GetId(), Name: r.Msg.GetName()}}), nil
}

// List returns Current, if set.
func (s *Session) List(_ context.Context, r *connect.Request[v1.ListSessionsRequest]) (*connect.Response[v1.ListSessionsResponse], error) {
	if err := s.do(r.Msg); err != nil {
		return nil, err
	}
	var out []*v1.Session
	if s.Current != nil {
		out = append(out, s.Current)
	}
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
