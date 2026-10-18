package api

import (
	"context"
	"errors"
	"fmt"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// Create spawns claude in a worktree.
func (h *Thread) Create(ctx context.Context, req *connect.Request[v1.CreateThreadRequest]) (*connect.Response[v1.CreateThreadResponse], error) {
	m := req.Msg
	o := thread.CreateOptions{
		ProjectID: m.GetProjectId(), WorktreePath: m.GetWorktreePath(), Model: m.GetModel(), Effort: m.GetEffort(),
		Name: m.GetName(), InitialPrompt: m.GetInitialPrompt(), ComposerPrompt: m.GetComposerPrompt(), PermissionMode: thread.PermissionMode(m.GetPermissionMode()),
		Attachments: m.GetAttachments(), WorkspaceID: m.GetWorkspaceId(), NoProject: m.GetNoProject(),
		CreatedBy: m.GetCreatedBy(), Brief: m.GetBrief(), Labels: m.GetLabels(), BudgetUSD: m.GetBudgetUsd(),
		Notify: m.GetNotify(),
	}
	if nw := m.GetNewWorktree(); nw != nil {
		o.NewWorktree = &thread.NewWorktree{BaseRef: nw.GetBaseRef()}
	}
	if nw := m.GetNewWorkspace(); nw != nil {
		o.NewWorkspace = &thread.NewWorkspace{Projects: nw.GetProjects(), BaseRef: nw.GetBaseRef(), Name: nw.GetName()}
	}
	s, reused, err := h.store.CreateOnce(ctx, m.GetRequestId(), o)
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.CreateThreadResponse{Thread: threadToProto(s), Reused: reused}), nil
}

// Fork continues a thread's conversation in a new thread.
func (h *Thread) Fork(ctx context.Context, req *connect.Request[v1.ForkThreadRequest]) (*connect.Response[v1.ForkThreadResponse], error) {
	s, err := h.store.Fork(ctx, req.Msg.GetId(), req.Msg.GetName())
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.ForkThreadResponse{Thread: threadToProto(s)}), nil
}

// List returns every thread, and the retired usage ledger; with a filter, the threads
// it selects, the most recently active first (the ledger only with filter.all, which
// the other filter fields narrow like include_archived).
func (h *Thread) List(ctx context.Context, req *connect.Request[v1.ListThreadsRequest]) (*connect.Response[v1.ListThreadsResponse], error) {
	if f := req.Msg.GetFilter(); f != nil {
		threads, err := h.store.List(ctx, listOptionsFromProto(f))
		if err != nil {
			return nil, threadError(err)
		}
		res := &v1.ListThreadsResponse{Threads: make([]*v1.Thread, len(threads))}
		for i, t := range threads {
			res.Threads[i] = threadToProto(t)
		}
		if snap := h.store.Snapshot(); f.GetAll() && snap != nil {
			res.RetiredUsage = retiredToProto(snap.RetiredUsage)
		}
		return connect.NewResponse(res), nil
	}
	snap := h.store.Snapshot()
	res := &v1.ListThreadsResponse{Threads: threadsToProto(snap)}
	if snap != nil {
		res.RetiredUsage = retiredToProto(snap.RetiredUsage)
	}
	return connect.NewResponse(res), nil
}

// Get returns one thread.
func (h *Thread) Get(ctx context.Context, req *connect.Request[v1.GetThreadRequest]) (*connect.Response[v1.GetThreadResponse], error) {
	s, err := h.store.Get(ctx, req.Msg.GetId())
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.GetThreadResponse{Thread: threadToProto(s)}), nil
}

// Rename sets a user-chosen name.
func (h *Thread) Rename(ctx context.Context, req *connect.Request[v1.RenameThreadRequest]) (*connect.Response[v1.RenameThreadResponse], error) {
	s, err := h.store.Rename(ctx, req.Msg.GetId(), req.Msg.GetName())
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.RenameThreadResponse{Thread: threadToProto(s)}), nil
}

// Pin sets or clears the user's pin.
func (h *Thread) Pin(ctx context.Context, req *connect.Request[v1.PinThreadRequest]) (*connect.Response[v1.PinThreadResponse], error) {
	s, err := h.store.Pin(ctx, req.Msg.GetId(), req.Msg.GetPinned())
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.PinThreadResponse{Thread: threadToProto(s)}), nil
}

// Archive archives (closing it and its shells, unpinning) or unarchives a thread.
func (h *Thread) Archive(ctx context.Context, req *connect.Request[v1.ArchiveThreadRequest]) (*connect.Response[v1.ArchiveThreadResponse], error) {
	s, err := h.store.Archive(ctx, req.Msg.GetId(), req.Msg.GetArchived())
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.ArchiveThreadResponse{Thread: threadToProto(s)}), nil
}

// Snooze snoozes a thread until req.until (closing it and its shells, unpinning,
// unarchiving) or unsnoozes it (until unset).
func (h *Thread) Snooze(ctx context.Context, req *connect.Request[v1.SnoozeThreadRequest]) (*connect.Response[v1.SnoozeThreadResponse], error) {
	var until time.Time
	if t := req.Msg.GetUntil(); t != nil {
		if err := t.CheckValid(); err != nil {
			return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("until: %w", err))
		}
		until = t.AsTime()
	}
	s, err := h.store.Snooze(ctx, req.Msg.GetId(), until)
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.SnoozeThreadResponse{Thread: threadToProto(s)}), nil
}

// Close ends the process gracefully; it returns once the thread is DISCONNECTED. No
// command calls it (docs/notes/thread-lifecycle.md); kept for compatibility.
func (h *Thread) Close(ctx context.Context, req *connect.Request[v1.CloseThreadRequest]) (*connect.Response[v1.CloseThreadResponse], error) {
	if err := h.store.Close(ctx, req.Msg.GetId()); err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.CloseThreadResponse{}), nil
}

// Reconnect resumes a DISCONNECTED thread without a prompt. No command calls it (a
// message starts a stopped thread); kept for compatibility.
func (h *Thread) Reconnect(ctx context.Context, req *connect.Request[v1.ReconnectThreadRequest]) (*connect.Response[v1.ReconnectThreadResponse], error) {
	s, err := h.store.Reconnect(ctx, req.Msg.GetId())
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.ReconnectThreadResponse{Thread: threadToProto(s)}), nil
}

// Remove forgets a thread, closing it first if needed.
func (h *Thread) Remove(ctx context.Context, req *connect.Request[v1.RemoveThreadRequest]) (*connect.Response[v1.RemoveThreadResponse], error) {
	if err := h.store.Remove(ctx, req.Msg.GetId()); err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.RemoveThreadResponse{}), nil
}

// RunIn moves a workspace thread to another member worktree.
func (h *Thread) RunIn(ctx context.Context, req *connect.Request[v1.RunInThreadRequest]) (*connect.Response[v1.RunInThreadResponse], error) {
	m := req.Msg
	s, err := h.store.RunIn(ctx, m.GetId(), thread.RunInTarget{ProjectID: m.GetProjectId(), WorktreePath: m.GetWorktreePath()})
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.RunInThreadResponse{Thread: threadToProto(s)}), nil
}

// Watch sends a snapshot, then every thread event. If the client falls behind and
// events are dropped, it sends a fresh snapshot.
func (h *Thread) Watch(ctx context.Context, _ *connect.Request[v1.WatchThreadsRequest], stream *connect.ServerStream[v1.ThreadListEvent]) error {
	// Subscribe first so nothing published between snapshot and stream is lost. Each
	// event carries full state, so applying queued older events still converges.
	sub := bus.Subscribe[thread.Event](h.bus, watchBuffer)
	defer sub.Close()
	if err := stream.Send(threadListEventToProto(h.store.Snapshot())); err != nil {
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
			if msg := threadListEventToProto(ev); msg != nil {
				if err := stream.Send(msg); err != nil {
					return err
				}
			}
		}
	}
}

// threadListEventToProto converts a bus event (or a *thread.Snapshot) to the wire event.
func threadListEventToProto(ev thread.Event) *v1.ThreadListEvent {
	switch e := ev.(type) {
	case *thread.Snapshot:
		snap := &v1.ThreadListSnapshot{Threads: threadsToProto(e)}
		if e != nil {
			snap.RetiredUsage = retiredToProto(e.RetiredUsage)
		}
		return &v1.ThreadListEvent{Event: &v1.ThreadListEvent_Snapshot{Snapshot: snap}}
	case thread.Updated:
		return &v1.ThreadListEvent{Event: &v1.ThreadListEvent_Updated{Updated: threadToProto(e.Thread)}}
	case thread.Removed:
		return &v1.ThreadListEvent{Event: &v1.ThreadListEvent_RemovedId{RemovedId: e.ID}}
	case thread.RetiredUsage:
		return &v1.ThreadListEvent{Event: &v1.ThreadListEvent_RetiredUsage{RetiredUsage: &v1.RetiredUsage{Buckets: retiredToProto(e.Buckets)}}}
	}
	return nil
}

func threadsToProto(snap *thread.Snapshot) []*v1.Thread {
	if snap == nil {
		return nil
	}
	out := make([]*v1.Thread, len(snap.Threads))
	for i, s := range snap.Threads {
		out[i] = threadToProto(s)
	}
	return out
}

func threadToProto(s thread.Thread) *v1.Thread {
	p := &v1.Thread{
		Id:                  s.ID,
		ClaudeSessionId:     s.ClaudeSessionID,
		ProjectId:           s.ProjectID,
		WorktreePath:        s.WorktreePath,
		Name:                s.Name,
		AutoNamed:           s.AutoNamed,
		NameProvisional:     s.NameProvisional,
		Model:               s.Model,
		Effort:              s.Effort,
		State:               v1.ThreadState(s.State),
		Status:              v1.ThreadStatus(s.Status),
		StatusReason:        s.StatusReason,
		ExitCode:            int32(s.ExitCode),
		DisconnectReason:    s.DisconnectReason,
		LastError:           s.LastError,
		ParentId:            s.ParentID,
		PermissionMode:      v1.PermissionMode(s.PermissionMode),
		BaseRef:             s.BaseRef,
		CreatedWorktree:     s.CreatedWorktree,
		Branch:              s.Branch,
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
	p.BackgroundShellsRunning = int32(s.BackgroundShellsRunning)
	p.BackgroundWakePending = s.WakePending
	p.ContextTokens, p.ContextRereadUsd = s.ContextTokens, contextRereadUSD(s)
	if !s.CacheExpiresAt.IsZero() {
		p.CacheExpiresAt = timestamppb.New(s.CacheExpiresAt)
	}
	if r := s.Retry; r != nil {
		p.Retry = &v1.ApiRetry{Attempt: int32(r.Attempt), MaxRetries: int32(r.MaxRetries), RetryAt: timestamppb.New(r.RetryAt), ErrorStatus: int32(r.Status), Error: r.Error}
	}
	metadataToProto(s, p) // thread_metadata.go
	return p
}

// threadError maps store errors to Connect codes.
func threadError(err error) error {
	var ce *connect.Error
	if errors.As(err, &ce) {
		return err
	}
	code := connect.CodeInternal
	switch {
	case errors.Is(err, thread.ErrNotFound):
		code = connect.CodeNotFound
	case errors.Is(err, thread.ErrInvalidArgument):
		code = connect.CodeInvalidArgument
	case errors.Is(err, thread.ErrFailedPrecondition):
		code = connect.CodeFailedPrecondition
	case errors.Is(err, thread.ErrClosed):
		code = connect.CodeUnavailable
	case errors.Is(err, context.Canceled):
		code = connect.CodeCanceled
	case errors.Is(err, context.DeadlineExceeded):
		code = connect.CodeDeadlineExceeded
	}
	return connect.NewError(code, err)
}

// StageAttachment stores an image or PDF for a message and returns its path.
func (h *Thread) StageAttachment(ctx context.Context, req *connect.Request[v1.StageAttachmentRequest]) (*connect.Response[v1.StageAttachmentResponse], error) {
	m := req.Msg
	path, err := h.store.StageAttachment(ctx, m.GetName(), m.GetMimeType(), m.GetData(), int(m.GetPages()))
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.StageAttachmentResponse{Path: path}), nil
}

// ReadAttachment returns a staged attachment's bytes.
func (h *Thread) ReadAttachment(ctx context.Context, req *connect.Request[v1.ReadAttachmentRequest]) (*connect.Response[v1.ReadAttachmentResponse], error) {
	data, mimeType, err := h.store.ReadAttachment(ctx, req.Msg.GetPath())
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.ReadAttachmentResponse{Data: data, MimeType: mimeType}), nil
}

// listOptionsFromProto maps ListThreadsRequest.filter to the store's options.
func listOptionsFromProto(f *v1.ThreadFilter) thread.ListOptions {
	return thread.ListOptions{
		All: f.GetAll(), IncludeArchived: f.GetIncludeArchived(),
		Status: thread.Status(f.GetStatus()), State: thread.State(f.GetState()),
		Project: f.GetProject(), Workspace: f.GetWorkspace(), CreatedBy: f.GetCreatedBy(), Labels: f.GetLabels(),
		Limit: int(f.GetLimit()),
	}
}
