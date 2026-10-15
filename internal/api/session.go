package api

import (
	"context"
	"errors"
	"fmt"
	"time"

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
	o := session.CreateOptions{
		RepoID: m.GetRepoId(), WorktreePath: m.GetWorktreePath(), Model: m.GetModel(), Effort: m.GetEffort(),
		Name: m.GetName(), InitialPrompt: m.GetInitialPrompt(), ComposerPrompt: m.GetComposerPrompt(), PermissionMode: session.PermissionMode(m.GetPermissionMode()),
		Attachments: m.GetAttachments(), WorkspaceID: m.GetWorkspaceId(), NoProject: m.GetNoProject(),
	}
	if nw := m.GetNewWorktree(); nw != nil {
		o.NewWorktree = &session.NewWorktree{BaseRef: nw.GetBaseRef()}
	}
	if nw := m.GetNewWorkspace(); nw != nil {
		o.NewWorkspace = &session.NewWorkspace{Repos: nw.GetRepos(), BaseRef: nw.GetBaseRef(), Name: nw.GetName()}
	}
	s, err := h.store.Create(ctx, o)
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

// List returns every session, and the retired usage ledger.
func (h *Session) List(context.Context, *connect.Request[v1.ListSessionsRequest]) (*connect.Response[v1.ListSessionsResponse], error) {
	snap := h.store.Snapshot()
	res := &v1.ListSessionsResponse{Sessions: sessionsToProto(snap)}
	if snap != nil {
		res.RetiredUsage = retiredToProto(snap.RetiredUsage)
	}
	return connect.NewResponse(res), nil
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

// Pin sets or clears the user's pin.
func (h *Session) Pin(ctx context.Context, req *connect.Request[v1.PinSessionRequest]) (*connect.Response[v1.PinSessionResponse], error) {
	s, err := h.store.Pin(ctx, req.Msg.GetId(), req.Msg.GetPinned())
	if err != nil {
		return nil, sessionError(err)
	}
	return connect.NewResponse(&v1.PinSessionResponse{Session: sessionToProto(s)}), nil
}

// Archive archives (closing it and its shells, unpinning) or unarchives a thread.
func (h *Session) Archive(ctx context.Context, req *connect.Request[v1.ArchiveSessionRequest]) (*connect.Response[v1.ArchiveSessionResponse], error) {
	s, err := h.store.Archive(ctx, req.Msg.GetId(), req.Msg.GetArchived())
	if err != nil {
		return nil, sessionError(err)
	}
	return connect.NewResponse(&v1.ArchiveSessionResponse{Session: sessionToProto(s)}), nil
}

// Snooze snoozes a thread until req.until (closing it and its shells, unpinning,
// unarchiving) or unsnoozes it (until unset).
func (h *Session) Snooze(ctx context.Context, req *connect.Request[v1.SnoozeSessionRequest]) (*connect.Response[v1.SnoozeSessionResponse], error) {
	var until time.Time
	if t := req.Msg.GetUntil(); t != nil {
		if err := t.CheckValid(); err != nil {
			return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("until: %w", err))
		}
		until = t.AsTime()
	}
	s, err := h.store.Snooze(ctx, req.Msg.GetId(), until)
	if err != nil {
		return nil, sessionError(err)
	}
	return connect.NewResponse(&v1.SnoozeSessionResponse{Session: sessionToProto(s)}), nil
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

// RunIn moves a workspace thread to another member worktree.
func (h *Session) RunIn(ctx context.Context, req *connect.Request[v1.RunInSessionRequest]) (*connect.Response[v1.RunInSessionResponse], error) {
	m := req.Msg
	s, err := h.store.RunIn(ctx, m.GetId(), session.RunInTarget{RepoID: m.GetRepoId(), WorktreePath: m.GetWorktreePath()})
	if err != nil {
		return nil, sessionError(err)
	}
	return connect.NewResponse(&v1.RunInSessionResponse{Session: sessionToProto(s)}), nil
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
		snap := &v1.SessionSnapshot{Sessions: sessionsToProto(e)}
		if e != nil {
			snap.RetiredUsage = retiredToProto(e.RetiredUsage)
		}
		return &v1.SessionEvent{Event: &v1.SessionEvent_Snapshot{Snapshot: snap}}
	case session.Updated:
		return &v1.SessionEvent{Event: &v1.SessionEvent_Updated{Updated: sessionToProto(e.Session)}}
	case session.Removed:
		return &v1.SessionEvent{Event: &v1.SessionEvent_RemovedId{RemovedId: e.ID}}
	case session.RetiredUsage:
		return &v1.SessionEvent{Event: &v1.SessionEvent_RetiredUsage{RetiredUsage: &v1.RetiredUsage{Buckets: retiredToProto(e.Buckets)}}}
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
		Id:                  s.ID,
		ClaudeSessionId:     s.ClaudeSessionID,
		RepoId:              s.RepoID,
		WorktreePath:        s.WorktreePath,
		Name:                s.Name,
		AutoNamed:           s.AutoNamed,
		Model:               s.Model,
		Effort:              s.Effort,
		State:               v1.SessionState(s.State),
		Status:              v1.SessionStatus(s.Status),
		StatusReason:        s.StatusReason,
		ExitCode:            int32(s.ExitCode),
		DisconnectReason:    s.DisconnectReason,
		LastError:           s.LastError,
		ParentId:            s.ParentID,
		PermissionMode:      v1.PermissionMode(s.PermissionMode),
		BaseRef:             s.BaseRef,
		CreatedWorktree:     s.CreatedWorktree,
		WorkspaceId:         s.WorkspaceID,
		PendingWorktreePath: s.PendingWorktreePath,
		Pinned:              s.Pinned,
		EffortPending:       s.EffortPending,
	}
	if !s.CreatedAt.IsZero() {
		p.CreatedAt = timestamppb.New(s.CreatedAt)
	}
	if !s.LastActivityAt.IsZero() {
		p.LastActivityAt = timestamppb.New(s.LastActivityAt)
	}
	if !s.StatusChangedAt.IsZero() {
		p.StatusChangedAt = timestamppb.New(s.StatusChangedAt)
	}
	if !s.ArchivedAt.IsZero() {
		p.ArchivedAt = timestamppb.New(s.ArchivedAt)
	}
	if !s.SnoozedUntil.IsZero() {
		p.SnoozedUntil = timestamppb.New(s.SnoozedUntil)
	}
	for _, l := range s.LinkedPullRequests {
		lp := &v1.LinkedPullRequest{Slug: l.Slug, Number: int32(l.Number), Url: l.URL}
		if !l.LinkedAt.IsZero() {
			lp.LinkedAt = timestamppb.New(l.LinkedAt)
		}
		p.LinkedPullRequests = append(p.LinkedPullRequests, lp)
	}
	p.Usage, p.CostUsd, p.Unpriced = usageToProto(s.Usage)
	p.AgentRuns = agentRunsToProto(s.AgentRuns)
	all, background := s.AgentsRunning()
	p.AgentsRunning, p.BackgroundAgentsRunning = int32(all), int32(background)
	p.ContextTokens, p.ContextRereadUsd = s.ContextTokens, contextRereadUSD(s)
	if !s.CacheExpiresAt.IsZero() {
		p.CacheExpiresAt = timestamppb.New(s.CacheExpiresAt)
	}
	if r := s.Retry; r != nil {
		p.Retry = &v1.ApiRetry{Attempt: int32(r.Attempt), MaxRetries: int32(r.MaxRetries), RetryAt: timestamppb.New(r.RetryAt), ErrorStatus: int32(r.Status), Error: r.Error}
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
	}
	return connect.NewError(code, err)
}

// StageAttachment stores an image for a first prompt and returns its path.
func (h *Session) StageAttachment(ctx context.Context, req *connect.Request[v1.StageAttachmentRequest]) (*connect.Response[v1.StageAttachmentResponse], error) {
	m := req.Msg
	path, err := h.store.StageAttachment(ctx, m.GetName(), m.GetMimeType(), m.GetData())
	if err != nil {
		return nil, sessionError(err)
	}
	return connect.NewResponse(&v1.StageAttachmentResponse{Path: path}), nil
}

// ReadAttachment returns a staged attachment's bytes.
func (h *Session) ReadAttachment(ctx context.Context, req *connect.Request[v1.ReadAttachmentRequest]) (*connect.Response[v1.ReadAttachmentResponse], error) {
	data, mimeType, err := h.store.ReadAttachment(ctx, req.Msg.GetPath())
	if err != nil {
		return nil, sessionError(err)
	}
	return connect.NewResponse(&v1.ReadAttachmentResponse{Data: data, MimeType: mimeType}), nil
}
