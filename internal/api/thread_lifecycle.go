package api

import (
	"context"
	"errors"
	"fmt"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/model"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// optionalBool copies an optional bool (a fresh pointer: the proto's is shared by its
// message).
func optionalBool(b *bool) *bool {
	if b == nil {
		return nil
	}
	v := *b
	return &v
}

// Create spawns claude in a worktree.
func (h *Thread) Create(ctx context.Context, req *connect.Request[v1.CreateThreadRequest]) (*connect.Response[v1.CreateThreadResponse], error) {
	m := req.Msg
	o := thread.CreateOptions{
		ProjectID: m.GetProjectId(), WorktreePath: m.GetWorktreePath(), Model: m.GetModel(), Effort: m.GetEffort(),
		Name: m.GetName(), InitialPrompt: m.GetInitialPrompt(), ComposerPrompt: m.GetComposerPrompt(), PermissionMode: thread.PermissionMode(m.GetPermissionMode()),
		Attachments: m.GetAttachments(), WorkspaceID: m.GetWorkspaceId(), NoProject: m.GetNoProject(),
		CreatedBy: m.GetCreatedBy(), Brief: m.GetBrief(), Labels: m.GetLabels(), BudgetUSD: m.GetBudgetUsd(), Notify: m.GetNotify() || m.GetNotifyGroup() != "", NotifyGroup: m.GetNotifyGroup(),
		NotifyRepeat: m.GetNotifyRepeat(),
		ModelDefaulted: m.GetModelDefaulted(), EffortDefaulted: m.GetEffortDefaulted(),
		SystemPromptAppend: m.GetSystemPromptAppend(),
		ProjectIDs:         m.GetProjectIds(), Like: m.GetLikeThreadId(), NewBranch: m.GetNewBranch(), CheckoutMode: m.GetCheckoutMode(),
		BackgroundSetup: m.GetBackgroundSetup(), DraftJSON: m.GetDraftJson(),
	}
	if nw := m.GetNewWorktree(); nw != nil {
		o.NewWorktree = &thread.NewWorktree{BaseRef: nw.GetBaseRef(), Branch: nw.GetBranch(), BaseFromOrigin: optionalBool(nw.BaseFromOrigin)}
	}
	var report thread.CreateReport
	o.Report = &report
	s, reused, err := h.store.CreateOnce(ctx, m.GetRequestId(), o)
	if err != nil {
		return nil, threadError(err)
	}
	res := &v1.CreateThreadResponse{Thread: threadToProto(s), Reused: reused}
	// A background setup that makes worktrees has placed nothing yet, so there is nothing to
	// say about it; one that runs in a checkout has its place already.
	if !reused && (!o.BackgroundSetup || s.WorktreePath != "") {
		res.Hints = h.store.CheckoutHints(s)
	}
	if !reused && !o.BackgroundSetup {
		res.MadeWorktree, res.ExistingWorktree, res.SharedWith = report.MadeWorktree, report.ExistingWorktree, report.SharedWith
		res.WorktreeModeDropped, res.MadeBranch = report.DroppedWorktreeMode, report.MadeBranch
	}
	return connect.NewResponse(res), nil
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
		if f.GetDescendantsOf() != "" || f.GetArchiveCascadeOf() != "" {
			res.Totals = subtreeTotals(threads, res.Threads)
		}
		if snap := h.store.Snapshot(); f.GetAll() && snap != nil {
			res.RetiredUsage = retiredToProto(snap.RetiredUsage)
		}
		if f.GetIncludeRemoved() {
			removed, err := h.store.ListRemoved(ctx, listOptionsFromProto(f))
			if err != nil {
				return nil, threadError(err)
			}
			for _, r := range removed {
				res.Removed = append(res.Removed, removedToProto(r))
			}
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
	p := threadToProto(s)
	if req.Msg.GetWithDetail() {
		if err := h.addDetail(ctx, s, p); err != nil {
			return nil, threadError(err)
		}
	}
	return connect.NewResponse(&v1.GetThreadResponse{Thread: p}), nil
}

// Rename sets a user-chosen name.
func (h *Thread) Rename(ctx context.Context, req *connect.Request[v1.RenameThreadRequest]) (*connect.Response[v1.RenameThreadResponse], error) {
	s, err := h.store.Rename(ctx, req.Msg.GetId(), req.Msg.GetName())
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.RenameThreadResponse{Thread: threadToProto(s)}), nil
}

// RegenerateName names the thread again from its recent turns and returns it renamed.
func (h *Thread) RegenerateName(ctx context.Context, req *connect.Request[v1.RegenerateNameRequest]) (*connect.Response[v1.RegenerateNameResponse], error) {
	s, err := h.store.RegenerateName(ctx, req.Msg.GetId())
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.RegenerateNameResponse{Thread: threadToProto(s)}), nil
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
	if req.Msg.GetArchived() && bySelf(req.Msg.GetByThreadId(), req.Msg.GetId()) {
		s, deferred, err := h.store.PutAwaySelf(ctx, req.Msg.GetId(), thread.PutAway{Kind: thread.PutAwayArchive})
		if err != nil {
			return nil, threadError(err)
		}
		return connect.NewResponse(&v1.ArchiveThreadResponse{Thread: threadToProto(s), Deferred: deferred}), nil
	}
	// Who asks: a group's wake names a member archived by anyone but its subscriber.
	s, err := h.store.Archive(thread.ArchivedBy(ctx, req.Msg.GetByThreadId()), req.Msg.GetId(), req.Msg.GetArchived())
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.ArchiveThreadResponse{Thread: threadToProto(s)}), nil
}

// Snooze snoozes a thread until req.until (closing it and its shells, unpinning,
// unarchiving), saves it for later (req.save: the same with no wake time), or unsnoozes
// it (neither). A thread doing either to itself goes through snoozeSelf.
func (h *Thread) Snooze(ctx context.Context, req *connect.Request[v1.SnoozeThreadRequest]) (*connect.Response[v1.SnoozeThreadResponse], error) {
	self := bySelf(req.Msg.GetByThreadId(), req.Msg.GetId())
	if req.Msg.GetSave() {
		if req.Msg.GetUntil() != nil {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("give until or save, not both"))
		}
		if self {
			return h.snoozeSelf(ctx, req.Msg.GetId(), thread.PutAway{Kind: thread.PutAwaySave})
		}
		s, err := h.store.SaveForLater(ctx, req.Msg.GetId())
		if err != nil {
			return nil, threadError(err)
		}
		return connect.NewResponse(&v1.SnoozeThreadResponse{Thread: threadToProto(s)}), nil
	}
	var until time.Time
	if t := req.Msg.GetUntil(); t != nil {
		if err := t.CheckValid(); err != nil {
			return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("until: %w", err))
		}
		until = t.AsTime()
		if self {
			return h.snoozeSelf(ctx, req.Msg.GetId(), thread.PutAway{Kind: thread.PutAwaySnooze, Until: until})
		}
	}
	s, err := h.store.Snooze(ctx, req.Msg.GetId(), until)
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.SnoozeThreadResponse{Thread: threadToProto(s)}), nil
}

// bySelf reports whether a request about thread id comes from that thread (by is empty
// for the user).
func bySelf(by, id string) bool { return by != "" && by == id }

// snoozeSelf is a thread snoozing itself: mid-turn that waits for the turn's end.
func (h *Thread) snoozeSelf(ctx context.Context, id string, p thread.PutAway) (*connect.Response[v1.SnoozeThreadResponse], error) {
	s, deferred, err := h.store.PutAwaySelf(ctx, id, p)
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.SnoozeThreadResponse{Thread: threadToProto(s), Deferred: deferred}), nil
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
		ProjectIds:          s.Projects(),
		WorktreePath:        s.WorktreePath,
		Name:                s.Name,
		AutoNamed:           s.AutoNamed,
		NameProvisional:     s.NameProvisional,
		Naming:              s.Naming,
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
		PendingMove:         moveToProto(s.PendingMove),
		Pinned:              s.Pinned,
		EffortPending:       s.EffortPending,
		CheckoutPaths:       checkoutPathsToProto(s),
		Setup:               setupToProto(s.Setup),
	}
	p.CreatedAt = timestamp(s.CreatedAt)
	p.LastActivityAt = timestamp(s.LastActivityAt)
	p.StatusChangedAt = timestamp(s.StatusChangedAt)
	p.ArchivedAt = timestamp(s.ArchivedAt)
	p.SnoozedUntil = timestamp(s.SnoozedUntil)
	p.SavedAt = timestamp(s.SavedAt)
	for _, l := range s.LinkedPullRequests {
		p.LinkedPullRequests = append(p.LinkedPullRequests, linkedPullRequestToProto(l))
	}
	p.Usage, p.CostUsd, p.Unpriced = usageToProto(s.Usage)
	p.AgentRuns = agentRunsToProto(s.AgentRuns)
	all, background := s.AgentsRunning()
	p.AgentsRunning, p.BackgroundAgentsRunning = int32(all), int32(background)
	p.BackgroundShellsRunning = int32(s.BackgroundShellsRunning)
	p.BackgroundShells = backgroundShellsToProto(s.BackgroundShells) // thread_shell.go
	p.BackgroundWakePending = s.WakePending
	p.BusyTool = s.BusyTool // the running tool call, "" unless busy (busytool.go)
	p.ContextTokens, p.ContextRereadUsd = s.ContextTokens, contextRereadUSD(s)
	p.ContextWindow = model.ContextWindow(s.Model)
	p.CacheExpiresAt = timestamp(s.CacheExpiresAt)
	if r := s.Retry; r != nil {
		p.Retry = &v1.ApiRetry{Attempt: int32(r.Attempt), MaxRetries: int32(r.MaxRetries), RetryAt: timestamppb.New(r.RetryAt), ErrorStatus: int32(r.Status), Error: r.Error}
	}
	metadataToProto(s, p)           // thread_metadata.go
	p.Flags = flagsToProto(s.Flags) // thread_flags.go
	p.Owner = s.Owner
	p.PluginEnvStale, p.PluginEnvChange = s.PluginEnvStale, s.PluginEnvChange // thread_restart.go
	p.TranscriptMissing = s.TranscriptMissing                                 // the store's transcriptmissing.go
	residentToProto(s, p)                                                     // thread_reseed.go
	return p
}

// threadError maps store errors to Connect codes.
func threadError(err error) error {
	var ce *connect.Error
	if errors.As(err, &ce) {
		return err
	}
	if re := removedError(err); re != nil {
		return re
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

// StageAttachment stores an image or PDF for a message, sent as bytes or as a path the
// daemon reads, and returns its path.
func (h *Thread) StageAttachment(ctx context.Context, req *connect.Request[v1.StageAttachmentRequest]) (*connect.Response[v1.StageAttachmentResponse], error) {
	m := req.Msg
	var path string
	var err error
	switch {
	case m.GetPath() != "" && len(m.GetData()) > 0:
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("set either data or path, not both"))
	case m.GetPath() != "":
		path, err = h.store.StageAttachmentFile(ctx, m.GetPath(), m.GetMimeType(), int(m.GetPages()))
	default:
		path, err = h.store.StageAttachment(ctx, m.GetName(), m.GetMimeType(), m.GetData(), int(m.GetPages()))
	}
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
		Owner: f.GetOwner(), Limit: int(f.GetLimit()), DescendantsOf: f.GetDescendantsOf(),
		ArchiveCascadeOf: f.GetArchiveCascadeOf(), IncludeResident: f.GetIncludeResident(),
	}
}

// subtreeTotals sets each listed thread's depth (a List with descendants_of or
// archive_cascade_of) and sums them: threads and protos are the same list.
func subtreeTotals(threads []thread.Thread, protos []*v1.Thread) *v1.ThreadTotals {
	tot := &v1.ThreadTotals{Threads: int32(len(protos))}
	for i, p := range protos {
		p.Depth = proto.Int32(int32(threads[i].Depth))
		tot.CostUsd += p.GetCostUsd()
	}
	return tot
}
