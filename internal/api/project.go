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
	"github.com/alexwaumann/code-foundry/internal/store/newproject"
	"github.com/alexwaumann/code-foundry/internal/store/project"
)

// watchBuffer is the per-Watch-stream event buffer. A client that falls further behind
// than this gets a fresh snapshot event instead of the dropped deltas.
const watchBuffer = 256

// Repo implements codefoundryv1connect.RepoServiceHandler.
type Project struct {
	store project.Store
	bus   *bus.Bus
	// github and cloner back SearchGitHub, LookupGitHub and Clone (repo_github.go);
	// nil answers Unimplemented.
	github gh.Finder
	cloner clone.Service
	// projects and owners back Create, Publish and ListPublishOwners
	// (repo_create.go); nil answers Unimplemented.
	newProjects newproject.Service
	owners      gh.Owners
	// cleanupHold backs CleanupWorktrees' non-git check (repo_cleanup.go); nil holds
	// nothing.
	cleanupHold func(project.Worktree) string
}

var _ codefoundryv1connect.ProjectServiceHandler = (*Project)(nil)

// NewRepo returns a RepoService handler over store, streaming repo.Event values from b.
func NewProject(store project.Store, b *bus.Bus) *Project {
	return &Project{store: store, bus: b}
}

// Route mounts the service.
func (h *Project) Route(opts ...connect.HandlerOption) Route {
	path, handler := codefoundryv1connect.NewProjectServiceHandler(h, opts...)
	return Route{Path: path, Handler: handler}
}

// Register adds the repository containing the given path (or the folder, as a project
// without git). The path is what a user typed: "~" expands to home, and it must be
// absolute (the Add Project dialog calls this directly; the CLI goes through repo.add).
func (h *Project) Register(ctx context.Context, req *connect.Request[v1.RegisterProjectRequest]) (*connect.Response[v1.RegisterProjectResponse], error) {
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
		return nil, projectError(err)
	}
	return connect.NewResponse(&v1.RegisterProjectResponse{Project: projectToProto(r)}), nil
}

// Unregister forgets a repository.
func (h *Project) Unregister(ctx context.Context, req *connect.Request[v1.UnregisterProjectRequest]) (*connect.Response[v1.UnregisterProjectResponse], error) {
	if err := h.store.Unregister(ctx, req.Msg.GetId()); err != nil {
		return nil, projectError(err)
	}
	return connect.NewResponse(&v1.UnregisterProjectResponse{}), nil
}

// List returns every registered repository from the current snapshot.
func (h *Project) List(context.Context, *connect.Request[v1.ListProjectsRequest]) (*connect.Response[v1.ListProjectsResponse], error) {
	return connect.NewResponse(&v1.ListProjectsResponse{Projects: projectsToProto(h.store.Snapshot().Projects)}), nil
}

// Get returns one repository from the current snapshot.
func (h *Project) Get(_ context.Context, req *connect.Request[v1.GetProjectRequest]) (*connect.Response[v1.GetProjectResponse], error) {
	r, ok := h.store.Snapshot().Project(req.Msg.GetId())
	if !ok {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("project not found"))
	}
	return connect.NewResponse(&v1.GetProjectResponse{Project: projectToProto(r)}), nil
}

// CreateWorktree creates a worktree.
func (h *Project) CreateWorktree(ctx context.Context, req *connect.Request[v1.CreateWorktreeRequest]) (*connect.Response[v1.CreateWorktreeResponse], error) {
	m := req.Msg
	w, err := h.store.CreateWorktree(ctx, project.CreateWorktreeOptions{
		ProjectID: m.GetProjectId(), Branch: m.GetBranch(), BaseRef: m.GetBaseRef(), Path: m.GetPath(),
		Fetch: m.GetFetch(),
	})
	if err != nil {
		return nil, projectError(err)
	}
	return connect.NewResponse(&v1.CreateWorktreeResponse{Worktree: worktreeToProto(w)}), nil
}

// ListRefs lists the refs a new branch can start from: local branches, then
// remote-tracking refs.
func (h *Project) ListRefs(ctx context.Context, req *connect.Request[v1.ListRefsRequest]) (*connect.Response[v1.ListRefsResponse], error) {
	refs, err := h.store.ListRefs(ctx, req.Msg.GetProjectId())
	if err != nil {
		return nil, projectError(err)
	}
	all := make([]string, 0, len(refs.Local)+len(refs.Remote))
	all = append(append(all, refs.Local...), refs.Remote...)
	return connect.NewResponse(&v1.ListRefsResponse{Refs: all, DefaultRef: refs.DefaultRef}), nil
}

// RemoveWorktree removes a worktree.
func (h *Project) RemoveWorktree(ctx context.Context, req *connect.Request[v1.RemoveWorktreeRequest]) (*connect.Response[v1.RemoveWorktreeResponse], error) {
	m := req.Msg
	if err := h.store.RemoveWorktree(ctx, project.RemoveWorktreeOptions{
		ProjectID: m.GetProjectId(), Path: m.GetPath(), DeleteBranch: m.GetDeleteBranch(), Force: m.GetForce(),
	}); err != nil {
		return nil, projectError(err)
	}
	return connect.NewResponse(&v1.RemoveWorktreeResponse{}), nil
}

// InitGit makes a project without git a git repository.
func (h *Project) InitGit(ctx context.Context, req *connect.Request[v1.InitGitRequest]) (*connect.Response[v1.InitGitResponse], error) {
	r, err := h.store.InitGit(ctx, req.Msg.GetId())
	if err != nil {
		return nil, projectError(err)
	}
	return connect.NewResponse(&v1.InitGitResponse{Project: projectToProto(r)}), nil
}

// Refresh reconciles one repo (or all) and waits for fresh status.
func (h *Project) Refresh(ctx context.Context, req *connect.Request[v1.RefreshProjectRequest]) (*connect.Response[v1.RefreshProjectResponse], error) {
	if err := h.store.Refresh(ctx, req.Msg.GetId()); err != nil {
		return nil, projectError(err)
	}
	return connect.NewResponse(&v1.RefreshProjectResponse{}), nil
}

// Watch sends a snapshot, then every repo event until the client goes away. If the
// client falls behind and events are dropped, it sends a fresh snapshot.
func (h *Project) Watch(ctx context.Context, _ *connect.Request[v1.WatchProjectsRequest], stream *connect.ServerStream[v1.ProjectEvent]) error {
	// Subscribe before reading the snapshot so nothing published in between is lost.
	// Events already queued may predate the snapshot; each carries full state, so
	// applying them in order still converges on the latest state.
	sub := bus.Subscribe[project.Event](h.bus, watchBuffer)
	defer sub.Close()
	sendSnapshot := func() error {
		return stream.Send(&v1.ProjectEvent{Event: &v1.ProjectEvent_Snapshot{
			Snapshot: &v1.ProjectSnapshot{Projects: projectsToProto(h.store.Snapshot().Projects)},
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
func projectError(err error) error {
	code := connect.CodeInternal
	switch {
	case errors.Is(err, project.ErrNotFound):
		code = connect.CodeNotFound
	case errors.Is(err, project.ErrInvalidArgument):
		code = connect.CodeInvalidArgument
	case errors.Is(err, project.ErrFailedPrecondition):
		code = connect.CodeFailedPrecondition
	case errors.Is(err, context.Canceled):
		code = connect.CodeCanceled
	case errors.Is(err, context.DeadlineExceeded):
		code = connect.CodeDeadlineExceeded
	}
	return connect.NewError(code, err)
}

func eventToProto(ev project.Event) *v1.ProjectEvent {
	switch e := ev.(type) {
	case project.ProjectUpdated:
		return &v1.ProjectEvent{Event: &v1.ProjectEvent_ProjectUpdated{ProjectUpdated: projectToProto(e.Project)}}
	case project.ProjectRemoved:
		return &v1.ProjectEvent{Event: &v1.ProjectEvent_ProjectRemovedId{ProjectRemovedId: e.ID}}
	case project.WorktreeUpdated:
		return &v1.ProjectEvent{Event: &v1.ProjectEvent_WorktreeUpdated{WorktreeUpdated: worktreeToProto(e.Worktree)}}
	case project.WorktreeRemoved:
		return &v1.ProjectEvent{Event: &v1.ProjectEvent_WorktreeRemoved{
			WorktreeRemoved: &v1.WorktreeRef{ProjectId: e.ProjectID, Path: e.Path},
		}}
	case project.WorktreeDetailUpdated:
		return worktreeDetailEvent(e)
	}
	return nil
}

func projectsToProto(rs []project.Project) []*v1.Project {
	out := make([]*v1.Project, len(rs))
	for i, r := range rs {
		out[i] = projectToProto(r)
	}
	return out
}

func projectToProto(r project.Project) *v1.Project {
	p := &v1.Project{
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

func worktreeToProto(w project.Worktree) *v1.Worktree {
	s := w.Status
	st := &v1.GitStatus{
		Upstream: s.Upstream, Ahead: int32(s.Ahead), Behind: int32(s.Behind),
		Staged: int32(s.Staged), Modified: int32(s.Modified), Untracked: int32(s.Untracked),
		Conflicted: int32(s.Conflicted), Dirty: s.Dirty,
		BaseRef: s.BaseRef, BaseAhead: int32(s.BaseAhead), BaseBehind: int32(s.BaseBehind),
		Operation: s.Operation, OperationStep: int32(s.OperationStep), OperationTotal: int32(s.OperationTotal),
		Error: s.Error,
	}
	if !s.RefreshedAt.IsZero() {
		st.RefreshedAt = timestamppb.New(s.RefreshedAt)
	}
	return &v1.Worktree{
		ProjectId: w.ProjectID, Path: w.Path, Branch: w.Branch, Head: w.Head,
		IsMain: w.IsMain, Detached: w.Detached, Status: st, MergedClean: w.MergedClean(),
	}
}
