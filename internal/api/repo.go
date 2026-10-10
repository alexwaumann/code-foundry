package api

import (
	"context"
	"errors"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/store/clone"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/repo"
)

// watchBuffer is the per-Watch-stream event buffer. A client that falls further behind
// than this gets a fresh snapshot event instead of the dropped deltas.
const watchBuffer = 256

// Repo implements codefoundryv1connect.RepoServiceHandler.
type Repo struct {
	store repo.Store
	bus   *bus.Bus
	// github and cloner back SearchGitHub, LookupGitHub and Clone (repo_github.go);
	// nil answers Unimplemented.
	github gh.Finder
	cloner clone.Service
	// projects and owners back Create, Publish and ListPublishOwners
	// (repo_create.go); nil answers Unimplemented.
	projects project.Service
	owners   gh.Owners
}

var _ codefoundryv1connect.RepoServiceHandler = (*Repo)(nil)

// NewRepo returns a RepoService handler over store, streaming repo.Event values from b.
func NewRepo(store repo.Store, b *bus.Bus) *Repo {
	return &Repo{store: store, bus: b}
}

// Route mounts the service.
func (h *Repo) Route(opts ...connect.HandlerOption) Route {
	path, handler := codefoundryv1connect.NewRepoServiceHandler(h, opts...)
	return Route{Path: path, Handler: handler}
}

// Register adds the repository containing the given path (or the folder, as a project
// without git). The path is what a user typed: "~" expands to home, and it must be
// absolute (the Add Project dialog calls this directly; the CLI goes through repo.add).
func (h *Repo) Register(ctx context.Context, req *connect.Request[v1.RegisterRepoRequest]) (*connect.Response[v1.RegisterRepoResponse], error) {
	path := req.Msg.GetPath()
	if path != "" {
		p, err := command.ExpandPath(path)
		if err != nil {
			return nil, connect.NewError(connect.CodeInvalidArgument, err)
		}
		path = p
	}
	r, err := h.store.Register(ctx, path)
	if err != nil {
		return nil, repoError(err)
	}
	return connect.NewResponse(&v1.RegisterRepoResponse{Repo: repoToProto(r)}), nil
}

// Unregister forgets a repository.
func (h *Repo) Unregister(ctx context.Context, req *connect.Request[v1.UnregisterRepoRequest]) (*connect.Response[v1.UnregisterRepoResponse], error) {
	if err := h.store.Unregister(ctx, req.Msg.GetId()); err != nil {
		return nil, repoError(err)
	}
	return connect.NewResponse(&v1.UnregisterRepoResponse{}), nil
}

// List returns every registered repository from the current snapshot.
func (h *Repo) List(context.Context, *connect.Request[v1.ListReposRequest]) (*connect.Response[v1.ListReposResponse], error) {
	return connect.NewResponse(&v1.ListReposResponse{Repos: reposToProto(h.store.Snapshot().Repos)}), nil
}

// Get returns one repository from the current snapshot.
func (h *Repo) Get(_ context.Context, req *connect.Request[v1.GetRepoRequest]) (*connect.Response[v1.GetRepoResponse], error) {
	r, ok := h.store.Snapshot().Repo(req.Msg.GetId())
	if !ok {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("repo not found"))
	}
	return connect.NewResponse(&v1.GetRepoResponse{Repo: repoToProto(r)}), nil
}

// CreateWorktree creates a worktree.
func (h *Repo) CreateWorktree(ctx context.Context, req *connect.Request[v1.CreateWorktreeRequest]) (*connect.Response[v1.CreateWorktreeResponse], error) {
	m := req.Msg
	w, err := h.store.CreateWorktree(ctx, repo.CreateWorktreeOptions{
		RepoID: m.GetRepoId(), Branch: m.GetBranch(), BaseRef: m.GetBaseRef(), Path: m.GetPath(),
		Fetch: m.GetFetch(),
	})
	if err != nil {
		return nil, repoError(err)
	}
	return connect.NewResponse(&v1.CreateWorktreeResponse{Worktree: worktreeToProto(w)}), nil
}

// ListRefs lists the refs a new branch can start from: local branches, then
// remote-tracking refs.
func (h *Repo) ListRefs(ctx context.Context, req *connect.Request[v1.ListRefsRequest]) (*connect.Response[v1.ListRefsResponse], error) {
	refs, err := h.store.ListRefs(ctx, req.Msg.GetRepoId())
	if err != nil {
		return nil, repoError(err)
	}
	all := make([]string, 0, len(refs.Local)+len(refs.Remote))
	all = append(append(all, refs.Local...), refs.Remote...)
	return connect.NewResponse(&v1.ListRefsResponse{Refs: all, DefaultRef: refs.DefaultRef}), nil
}

// RemoveWorktree removes a worktree.
func (h *Repo) RemoveWorktree(ctx context.Context, req *connect.Request[v1.RemoveWorktreeRequest]) (*connect.Response[v1.RemoveWorktreeResponse], error) {
	m := req.Msg
	if err := h.store.RemoveWorktree(ctx, repo.RemoveWorktreeOptions{
		RepoID: m.GetRepoId(), Path: m.GetPath(), DeleteBranch: m.GetDeleteBranch(), Force: m.GetForce(),
	}); err != nil {
		return nil, repoError(err)
	}
	return connect.NewResponse(&v1.RemoveWorktreeResponse{}), nil
}

// InitGit makes a project without git a git repository.
func (h *Repo) InitGit(ctx context.Context, req *connect.Request[v1.InitGitRequest]) (*connect.Response[v1.InitGitResponse], error) {
	r, err := h.store.InitGit(ctx, req.Msg.GetId())
	if err != nil {
		return nil, repoError(err)
	}
	return connect.NewResponse(&v1.InitGitResponse{Repo: repoToProto(r)}), nil
}

// Refresh reconciles one repo (or all) and waits for fresh status.
func (h *Repo) Refresh(ctx context.Context, req *connect.Request[v1.RefreshRepoRequest]) (*connect.Response[v1.RefreshRepoResponse], error) {
	if err := h.store.Refresh(ctx, req.Msg.GetId()); err != nil {
		return nil, repoError(err)
	}
	return connect.NewResponse(&v1.RefreshRepoResponse{}), nil
}

// Watch sends a snapshot, then every repo event until the client goes away. If the
// client falls behind and events are dropped, it sends a fresh snapshot.
func (h *Repo) Watch(ctx context.Context, _ *connect.Request[v1.WatchReposRequest], stream *connect.ServerStream[v1.RepoEvent]) error {
	// Subscribe before reading the snapshot so nothing published in between is lost.
	// Events already queued may predate the snapshot; each carries full state, so
	// applying them in order still converges on the latest state.
	sub := bus.Subscribe[repo.Event](h.bus, watchBuffer)
	defer sub.Close()
	sendSnapshot := func() error {
		return stream.Send(&v1.RepoEvent{Event: &v1.RepoEvent_Snapshot{
			Snapshot: &v1.RepoSnapshot{Repos: reposToProto(h.store.Snapshot().Repos)},
		}})
	}
	if err := sendSnapshot(); err != nil {
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
				if err := sendSnapshot(); err != nil {
					return err
				}
				continue
			}
			if msg := eventToProto(ev); msg != nil {
				if err := stream.Send(msg); err != nil {
					return err
				}
			}
		}
	}
}

// repoError maps store errors to Connect codes.
func repoError(err error) error {
	code := connect.CodeInternal
	switch {
	case errors.Is(err, repo.ErrNotFound):
		code = connect.CodeNotFound
	case errors.Is(err, repo.ErrInvalidArgument):
		code = connect.CodeInvalidArgument
	case errors.Is(err, repo.ErrFailedPrecondition):
		code = connect.CodeFailedPrecondition
	case errors.Is(err, context.Canceled):
		code = connect.CodeCanceled
	case errors.Is(err, context.DeadlineExceeded):
		code = connect.CodeDeadlineExceeded
	}
	return connect.NewError(code, err)
}

func eventToProto(ev repo.Event) *v1.RepoEvent {
	switch e := ev.(type) {
	case repo.RepoUpdated:
		return &v1.RepoEvent{Event: &v1.RepoEvent_RepoUpdated{RepoUpdated: repoToProto(e.Repo)}}
	case repo.RepoRemoved:
		return &v1.RepoEvent{Event: &v1.RepoEvent_RepoRemovedId{RepoRemovedId: e.ID}}
	case repo.WorktreeUpdated:
		return &v1.RepoEvent{Event: &v1.RepoEvent_WorktreeUpdated{WorktreeUpdated: worktreeToProto(e.Worktree)}}
	case repo.WorktreeRemoved:
		return &v1.RepoEvent{Event: &v1.RepoEvent_WorktreeRemoved{
			WorktreeRemoved: &v1.WorktreeRef{RepoId: e.RepoID, Path: e.Path},
		}}
	case repo.WorktreeDetailUpdated:
		return worktreeDetailEvent(e)
	}
	return nil
}

func reposToProto(rs []repo.Repo) []*v1.Repo {
	out := make([]*v1.Repo, len(rs))
	for i, r := range rs {
		out[i] = repoToProto(r)
	}
	return out
}

func repoToProto(r repo.Repo) *v1.Repo {
	p := &v1.Repo{
		Id: r.ID, Path: r.Path, Name: r.Name, DefaultBranch: r.DefaultBranch,
		GithubSlug: r.GitHubSlug, Error: r.Error, Remotes: r.Remotes, Git: r.Git,
		Worktrees: make([]*v1.Worktree, len(r.Worktrees)),
	}
	if !r.RegisteredAt.IsZero() {
		p.RegisteredAt = timestamppb.New(r.RegisteredAt)
	}
	for i, w := range r.Worktrees {
		p.Worktrees[i] = worktreeToProto(w)
	}
	return p
}

func worktreeToProto(w repo.Worktree) *v1.Worktree {
	s := w.Status
	st := &v1.GitStatus{
		Upstream: s.Upstream, Ahead: int32(s.Ahead), Behind: int32(s.Behind),
		Staged: int32(s.Staged), Modified: int32(s.Modified), Untracked: int32(s.Untracked),
		Conflicted: int32(s.Conflicted), Dirty: s.Dirty,
		BaseRef: s.BaseRef, BaseAhead: int32(s.BaseAhead), BaseBehind: int32(s.BaseBehind),
		Error: s.Error,
	}
	if !s.RefreshedAt.IsZero() {
		st.RefreshedAt = timestamppb.New(s.RefreshedAt)
	}
	return &v1.Worktree{
		RepoId: w.RepoID, Path: w.Path, Branch: w.Branch, Head: w.Head,
		IsMain: w.IsMain, Detached: w.Detached, Status: st,
	}
}
