package api

import (
	"context"
	"errors"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/session"
)

// Session implements codefoundryv1connect.SessionServiceHandler over a session.Store.
type Session struct {
	store session.Store
	bus   *bus.Bus
}

var _ codefoundryv1connect.SessionServiceHandler = (*Session)(nil)

// NewSession returns a SessionService handler. b must be the bus the store publishes
// session.Event on.
func NewSession(store session.Store, b *bus.Bus) *Session { return &Session{store: store, bus: b} }

// Route mounts the service.
func (h *Session) Route(opts ...connect.HandlerOption) Route {
	path, handler := codefoundryv1connect.NewSessionServiceHandler(h, opts...)
	return Route{Path: path, Handler: handler}
}

// Create spawns claude in a worktree.
func (h *Session) Create(ctx context.Context, req *connect.Request[v1.CreateSessionRequest]) (*connect.Response[v1.CreateSessionResponse], error) {
	m := req.Msg
	s, err := h.store.Create(ctx, session.CreateOptions{
		RepoID: m.GetRepoId(), WorktreePath: m.GetWorktreePath(), Model: m.GetModel(), Effort: m.GetEffort(),
		Name: m.GetName(), InitialPrompt: m.GetInitialPrompt(),
	})
	if err != nil {
		return nil, sessionError(err)
	}
	return connect.NewResponse(&v1.CreateSessionResponse{Session: sessionToProto(s)}), nil
}

// Fork continues a session's conversation in a new session.
func (h *Session) Fork(ctx context.Context, req *connect.Request[v1.ForkSessionRequest]) (*connect.Response[v1.ForkSessionResponse], error) {
	s, err := h.store.Fork(ctx, req.Msg.GetId(), req.Msg.GetName())
	if err != nil {
		return nil, sessionError(err)
	}
	return connect.NewResponse(&v1.ForkSessionResponse{Session: sessionToProto(s)}), nil
}

// List returns every session.
func (h *Session) List(context.Context, *connect.Request[v1.ListSessionsRequest]) (*connect.Response[v1.ListSessionsResponse], error) {
	return connect.NewResponse(&v1.ListSessionsResponse{Sessions: sessionsToProto(h.store.Snapshot())}), nil
}

// Get returns one session.
func (h *Session) Get(ctx context.Context, req *connect.Request[v1.GetSessionRequest]) (*connect.Response[v1.GetSessionResponse], error) {
	s, err := h.store.Get(ctx, req.Msg.GetId())
	if err != nil {
		return nil, sessionError(err)
	}
	return connect.NewResponse(&v1.GetSessionResponse{Session: sessionToProto(s)}), nil
}

// Rename sets a user-chosen name.
func (h *Session) Rename(ctx context.Context, req *connect.Request[v1.RenameSessionRequest]) (*connect.Response[v1.RenameSessionResponse], error) {
	s, err := h.store.Rename(ctx, req.Msg.GetId(), req.Msg.GetName())
	if err != nil {
		return nil, sessionError(err)
	}
	return connect.NewResponse(&v1.RenameSessionResponse{Session: sessionToProto(s)}), nil
}

// Close ends the process gracefully; it returns once the session is DISCONNECTED.
func (h *Session) Close(ctx context.Context, req *connect.Request[v1.CloseSessionRequest]) (*connect.Response[v1.CloseSessionResponse], error) {
	if err := h.store.Close(ctx, req.Msg.GetId()); err != nil {
		return nil, sessionError(err)
	}
	return connect.NewResponse(&v1.CloseSessionResponse{}), nil
}

// Reconnect resumes a DISCONNECTED session.
func (h *Session) Reconnect(ctx context.Context, req *connect.Request[v1.ReconnectSessionRequest]) (*connect.Response[v1.ReconnectSessionResponse], error) {
	s, err := h.store.Reconnect(ctx, req.Msg.GetId())
	if err != nil {
		return nil, sessionError(err)
	}
	return connect.NewResponse(&v1.ReconnectSessionResponse{Session: sessionToProto(s)}), nil
}

// Remove forgets a session, closing it first if needed.
func (h *Session) Remove(ctx context.Context, req *connect.Request[v1.RemoveSessionRequest]) (*connect.Response[v1.RemoveSessionResponse], error) {
	if err := h.store.Remove(ctx, req.Msg.GetId()); err != nil {
		return nil, sessionError(err)
	}
	return connect.NewResponse(&v1.RemoveSessionResponse{}), nil
}

// Watch sends a snapshot, then every session event. If the client falls behind and
// events are dropped, it sends a fresh snapshot.
func (h *Session) Watch(ctx context.Context, _ *connect.Request[v1.WatchSessionsRequest], stream *connect.ServerStream[v1.SessionEvent]) error {
	// Subscribe first so nothing published between snapshot and stream is lost. Each
	// event carries full state, so applying queued older events still converges.
	sub := bus.Subscribe[session.Event](h.bus, watchBuffer)
	defer sub.Close()
	if err := stream.Send(sessionEventToProto(h.store.Snapshot())); err != nil {
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
			if msg := sessionEventToProto(ev); msg != nil {
				if err := stream.Send(msg); err != nil {
					return err
				}
			}
		}
	}
}

// sessionEventToProto converts a bus event (or a *session.Snapshot) to the wire event.
func sessionEventToProto(ev session.Event) *v1.SessionEvent {
	switch e := ev.(type) {
	case *session.Snapshot:
		return &v1.SessionEvent{Event: &v1.SessionEvent_Snapshot{Snapshot: &v1.SessionSnapshot{Sessions: sessionsToProto(e)}}}
	case session.Updated:
		return &v1.SessionEvent{Event: &v1.SessionEvent_Updated{Updated: sessionToProto(e.Session)}}
	case session.Removed:
		return &v1.SessionEvent{Event: &v1.SessionEvent_RemovedId{RemovedId: e.ID}}
	}
	return nil
}

func sessionsToProto(snap *session.Snapshot) []*v1.Session {
	if snap == nil {
		return nil
	}
	out := make([]*v1.Session, len(snap.Sessions))
	for i, s := range snap.Sessions {
		out[i] = sessionToProto(s)
	}
	return out
}

func sessionToProto(s session.Session) *v1.Session {
	p := &v1.Session{
		Id:               s.ID,
		ClaudeSessionId:  s.ClaudeSessionID,
		RepoId:           s.RepoID,
		WorktreePath:     s.WorktreePath,
		Name:             s.Name,
		AutoNamed:        s.AutoNamed,
		Model:            s.Model,
		Effort:           s.Effort,
		TerminalId:       s.TerminalID,
		State:            v1.SessionState(s.State),
		Status:           v1.SessionStatus(s.Status),
		StatusReason:     s.StatusReason,
		ExitCode:         int32(s.ExitCode),
		DisconnectReason: s.DisconnectReason,
		LastError:        s.LastError,
		ParentId:         s.ParentID,
	}
	if !s.CreatedAt.IsZero() {
		p.CreatedAt = timestamppb.New(s.CreatedAt)
	}
	if !s.LastActivityAt.IsZero() {
		p.LastActivityAt = timestamppb.New(s.LastActivityAt)
	}
	return p
}

// sessionError maps store errors to Connect codes.
func sessionError(err error) error {
	var ce *connect.Error
	if errors.As(err, &ce) {
		return err
	}
	code := connect.CodeInternal
	switch {
	case errors.Is(err, session.ErrNotFound):
		code = connect.CodeNotFound
	case errors.Is(err, session.ErrInvalidArgument):
		code = connect.CodeInvalidArgument
	case errors.Is(err, session.ErrFailedPrecondition):
		code = connect.CodeFailedPrecondition
	case errors.Is(err, session.ErrClosed):
		code = connect.CodeUnavailable
	case errors.Is(err, context.Canceled):
		code = connect.CodeCanceled
	case errors.Is(err, context.DeadlineExceeded):
		code = connect.CodeDeadlineExceeded
	default:
		// Spawn failures surface the terminal store's error (bad argv, cwd).
		if te := terminalError(err); te != nil {
			var tce *connect.Error
			if errors.As(te, &tce) && tce.Code() != connect.CodeInternal {
				return te
			}
		}
	}
	return connect.NewError(code, err)
}
