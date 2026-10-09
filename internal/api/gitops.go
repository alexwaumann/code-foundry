package api

import (
	"context"
	"errors"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/gitops"
)

// gitopsWatchBuffer is the per-stream event buffer. Ops are few and slow; a client that
// falls this far behind gets a fresh snapshot instead.
const gitopsWatchBuffer = 64

// GitOps implements codefoundryv1connect.GitOpsServiceHandler over a gitops.Store.
type GitOps struct {
	store gitops.Store
	bus   *bus.Bus
	done  <-chan struct{}
}

var _ codefoundryv1connect.GitOpsServiceHandler = (*GitOps)(nil)

// NewGitOps returns a GitOpsService handler. Watch streams end when done closes (daemon
// shutdown); done may be nil.
func NewGitOps(store gitops.Store, b *bus.Bus, done <-chan struct{}) *GitOps {
	return &GitOps{store: store, bus: b, done: done}
}

// Route mounts the service.
func (h *GitOps) Route(opts ...connect.HandlerOption) Route {
	path, handler := codefoundryv1connect.NewGitOpsServiceHandler(h, opts...)
	return Route{Path: path, Handler: handler}
}

// Fetch implements GitOpsServiceHandler.
func (h *GitOps) Fetch(ctx context.Context, req *connect.Request[v1.GitFetchRequest]) (*connect.Response[v1.GitFetchResponse], error) {
	op, err := h.store.Fetch(ctx, gitops.FetchOptions{WorktreePath: req.Msg.GetWorktreePath(), Remote: req.Msg.GetRemote(), Branch: req.Msg.GetBranch()})
	if err != nil {
		return nil, gitopsError(err)
	}
	return connect.NewResponse(&v1.GitFetchResponse{Op: gitOpToProto(op)}), nil
}

// Pull implements GitOpsServiceHandler.
func (h *GitOps) Pull(ctx context.Context, req *connect.Request[v1.GitPullRequest]) (*connect.Response[v1.GitPullResponse], error) {
	op, err := h.store.Pull(ctx, gitops.PullOptions{WorktreePath: req.Msg.GetWorktreePath(), Rebase: req.Msg.GetRebase()})
	if err != nil {
		return nil, gitopsError(err)
	}
	return connect.NewResponse(&v1.GitPullResponse{Op: gitOpToProto(op)}), nil
}

// Push implements GitOpsServiceHandler.
func (h *GitOps) Push(ctx context.Context, req *connect.Request[v1.GitPushRequest]) (*connect.Response[v1.GitPushResponse], error) {
	op, err := h.store.Push(ctx, gitops.PushOptions{WorktreePath: req.Msg.GetWorktreePath(), ForceWithLease: req.Msg.GetForceWithLease()})
	if err != nil {
		return nil, gitopsError(err)
	}
	return connect.NewResponse(&v1.GitPushResponse{Op: gitOpToProto(op)}), nil
}

// CreatePullRequest implements GitOpsServiceHandler.
func (h *GitOps) CreatePullRequest(ctx context.Context, req *connect.Request[v1.CreatePullRequestRequest]) (*connect.Response[v1.CreatePullRequestResponse], error) {
	m := req.Msg
	op, err := h.store.CreatePR(ctx, gitops.CreatePROptions{
		WorktreePath: m.GetWorktreePath(), Title: m.GetTitle(), Body: m.GetBody(), Draft: m.GetDraft(), Base: m.GetBase(),
	})
	if err != nil {
		return nil, gitopsError(err)
	}
	return connect.NewResponse(&v1.CreatePullRequestResponse{Op: gitOpToProto(op)}), nil
}

// OpenPullRequest implements GitOpsServiceHandler.
func (h *GitOps) OpenPullRequest(ctx context.Context, req *connect.Request[v1.OpenPullRequestRequest]) (*connect.Response[v1.OpenPullRequestResponse], error) {
	op, err := h.store.OpenPR(ctx, req.Msg.GetWorktreePath())
	if err != nil {
		return nil, gitopsError(err)
	}
	return connect.NewResponse(&v1.OpenPullRequestResponse{Op: gitOpToProto(op)}), nil
}

// OpenEditor implements GitOpsServiceHandler.
func (h *GitOps) OpenEditor(ctx context.Context, req *connect.Request[v1.OpenEditorRequest]) (*connect.Response[v1.OpenEditorResponse], error) {
	op, err := h.store.OpenEditor(ctx, req.Msg.GetWorktreePath())
	if err != nil {
		return nil, gitopsError(err)
	}
	return connect.NewResponse(&v1.OpenEditorResponse{Op: gitOpToProto(op)}), nil
}

// Reveal implements GitOpsServiceHandler.
func (h *GitOps) Reveal(ctx context.Context, req *connect.Request[v1.RevealRequest]) (*connect.Response[v1.RevealResponse], error) {
	op, err := h.store.Reveal(ctx, req.Msg.GetWorktreePath())
	if err != nil {
		return nil, gitopsError(err)
	}
	return connect.NewResponse(&v1.RevealResponse{Op: gitOpToProto(op)}), nil
}

// OpenUrl implements GitOpsServiceHandler.
func (h *GitOps) OpenUrl(ctx context.Context, req *connect.Request[v1.OpenUrlRequest]) (*connect.Response[v1.OpenUrlResponse], error) {
	op, err := h.store.OpenURL(ctx, req.Msg.GetUrl())
	if err != nil {
		return nil, gitopsError(err)
	}
	return connect.NewResponse(&v1.OpenUrlResponse{Op: gitOpToProto(op)}), nil
}

// List implements GitOpsServiceHandler.
func (h *GitOps) List(context.Context, *connect.Request[v1.ListGitOpsRequest]) (*connect.Response[v1.ListGitOpsResponse], error) {
	return connect.NewResponse(&v1.ListGitOpsResponse{Ops: gitOpsToProto(h.store.Snapshot().Ops)}), nil
}

// Watch implements GitOpsServiceHandler: a snapshot, then queued/started/finished
// events. A client that falls behind gets a fresh snapshot instead of the missed events.
func (h *GitOps) Watch(ctx context.Context, _ *connect.Request[v1.WatchGitOpsRequest], stream *connect.ServerStream[v1.GitOpsEvent]) error {
	sub := bus.Subscribe[gitops.Event](h.bus, gitopsWatchBuffer)
	defer sub.Close()
	if err := stream.Send(gitopsSnapshotEvent(h.store.Snapshot())); err != nil {
		return err
	}
	var dropped uint64
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-h.done:
			return nil
		case ev, ok := <-sub.C():
			if !ok {
				return nil
			}
			msg := gitopsEventToProto(ev)
			if d := sub.Dropped(); d != dropped {
				dropped = d
				msg = gitopsSnapshotEvent(h.store.Snapshot())
			}
			if msg == nil {
				continue
			}
			if err := stream.Send(msg); err != nil {
				return err
			}
		}
	}
}

func gitopsError(err error) error {
	code := connect.CodeInternal
	switch {
	case errors.Is(err, gitops.ErrInvalidArgument):
		code = connect.CodeInvalidArgument
	case errors.Is(err, gitops.ErrClosed):
		code = connect.CodeUnavailable
	case errors.Is(err, context.Canceled):
		code = connect.CodeCanceled
	case errors.Is(err, context.DeadlineExceeded):
		code = connect.CodeDeadlineExceeded
	}
	return connect.NewError(code, err)
}

func gitopsSnapshotEvent(s *gitops.Snapshot) *v1.GitOpsEvent {
	return &v1.GitOpsEvent{Event: &v1.GitOpsEvent_Snapshot{Snapshot: &v1.GitOpsSnapshot{Ops: gitOpsToProto(s.Ops)}}}
}

// gitopsEventToProto maps a bus event; shared by Watch and the EventService source.
func gitopsEventToProto(ev gitops.Event) *v1.GitOpsEvent {
	op := gitOpToProto(ev.Op)
	switch ev.Type {
	case gitops.Queued:
		return &v1.GitOpsEvent{Event: &v1.GitOpsEvent_Queued{Queued: op}}
	case gitops.Started:
		return &v1.GitOpsEvent{Event: &v1.GitOpsEvent_Started{Started: op}}
	case gitops.Finished:
		return &v1.GitOpsEvent{Event: &v1.GitOpsEvent_Finished{Finished: op}}
	default:
		return nil
	}
}

func gitOpsToProto(ops []gitops.Op) []*v1.GitOp {
	out := make([]*v1.GitOp, len(ops))
	for i, o := range ops {
		out[i] = gitOpToProto(o)
	}
	return out
}

// gitOpToProto maps an op. gitops.Kind and gitops.State share the proto enums' values.
func gitOpToProto(o gitops.Op) *v1.GitOp {
	return &v1.GitOp{
		Id:           o.ID,
		Kind:         v1.GitOpKind(o.Kind),
		State:        v1.GitOpState(o.State),
		Title:        o.Title,
		WorktreePath: o.WorktreePath,
		RepoId:       o.RepoID,
		Branch:       o.Branch,
		QueuedAt:     timestamp(o.QueuedAt),
		StartedAt:    timestamp(o.StartedAt),
		FinishedAt:   timestamp(o.FinishedAt),
		DurationMs:   o.Duration.Milliseconds(),
		Summary:      o.Summary,
		Output:       o.Output,
		Url:          o.URL,
	}
}
