// Package commandtest provides fakes for the command package's dependencies.
package commandtest

import (
	"cmp"
	"context"
	"sync"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
)

// Emitter records intents and reports Delivered for each.
type Emitter struct {
	Delivered int

	mu      sync.Mutex
	intents []*v1.UiIntent
}

var _ command.Emitter = (*Emitter)(nil)

// Emit records intent.
func (e *Emitter) Emit(intent *v1.UiIntent) int {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.intents = append(e.intents, intent)
	return e.Delivered
}

// Intents returns the recorded intents.
func (e *Emitter) Intents() []*v1.UiIntent {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]*v1.UiIntent(nil), e.intents...)
}

// Calls records backend requests in order. Shared, when set, records them too: give
// several fakes the same Shared log to see the order of calls across them.
type Calls struct {
	Shared *Calls

	mu   sync.Mutex
	reqs []proto.Message
}

func (c *Calls) record(m proto.Message) {
	c.mu.Lock()
	c.reqs = append(c.reqs, m)
	c.mu.Unlock()
	if c.Shared != nil {
		c.Shared.record(m)
	}
}

// Requests returns the recorded request messages.
func (c *Calls) Requests() []proto.Message {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]proto.Message(nil), c.reqs...)
}

// Terminal is a fake command.TerminalBackend. Err, when set, is returned by every call.
type Terminal struct {
	Calls
	Err error
	// WriteErr, when set, is returned by Write only.
	WriteErr error
	// Created is returned by Create; its Argv, Cwd and Labels are filled from the
	// request.
	Created *v1.Terminal
	// Terminals is what List returns.
	Terminals []*v1.Terminal
}

var _ command.TerminalBackend = (*Terminal)(nil)

// Create records the request and returns Created.
func (t *Terminal) Create(_ context.Context, r *connect.Request[v1.CreateTerminalRequest]) (*connect.Response[v1.CreateTerminalResponse], error) {
	t.record(r.Msg)
	if t.Err != nil {
		return nil, t.Err
	}
	term := &v1.Terminal{Id: "t1"}
	if t.Created != nil {
		term = proto.CloneOf(t.Created)
	}
	term.Argv, term.Cwd, term.Labels = r.Msg.GetArgv(), r.Msg.GetCwd(), r.Msg.GetLabels()
	return connect.NewResponse(&v1.CreateTerminalResponse{Terminal: term}), nil
}

// Kill records the request.
func (t *Terminal) Kill(_ context.Context, r *connect.Request[v1.KillTerminalRequest]) (*connect.Response[v1.KillTerminalResponse], error) {
	t.record(r.Msg)
	return connect.NewResponse(&v1.KillTerminalResponse{}), t.Err
}

// Remove records the request.
func (t *Terminal) Remove(_ context.Context, r *connect.Request[v1.RemoveTerminalRequest]) (*connect.Response[v1.RemoveTerminalResponse], error) {
	t.record(r.Msg)
	return connect.NewResponse(&v1.RemoveTerminalResponse{}), t.Err
}

// Close records the request.
func (t *Terminal) Close(_ context.Context, r *connect.Request[v1.CloseTerminalRequest]) (*connect.Response[v1.CloseTerminalResponse], error) {
	t.record(r.Msg)
	return connect.NewResponse(&v1.CloseTerminalResponse{}), t.Err
}

// Write records the request. WriteErr, else Err, is returned.
func (t *Terminal) Write(_ context.Context, r *connect.Request[v1.WriteTerminalRequest]) (*connect.Response[v1.WriteTerminalResponse], error) {
	t.record(r.Msg)
	if err := cmp.Or(t.WriteErr, t.Err); err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.WriteTerminalResponse{}), nil
}

// List records the request and returns Terminals.
func (t *Terminal) List(_ context.Context, r *connect.Request[v1.ListTerminalsRequest]) (*connect.Response[v1.ListTerminalsResponse], error) {
	t.record(r.Msg)
	if t.Err != nil {
		return nil, t.Err
	}
	return connect.NewResponse(&v1.ListTerminalsResponse{Terminals: t.Terminals}), nil
}

// Output is a fake command.TerminalDeps.AwaitOutput (pass its Await): a shell that has
// printed its prompt (nil), never prints anything (Block), or fails (Err).
type Output struct {
	// Block makes Await wait for its context to end and return its error (the
	// RunWait timeout, or the caller going away).
	Block bool
	// Err is returned by Await when it does not block.
	Err error
	// OnAwait, when set, is called with the id as Await starts (to look at other fakes
	// at that moment).
	OnAwait func(id string)

	mu  sync.Mutex
	ids []string
}

// Await records id, then blocks or returns Err.
func (o *Output) Await(ctx context.Context, id string) error {
	o.mu.Lock()
	o.ids = append(o.ids, id)
	o.mu.Unlock()
	if o.OnAwait != nil {
		o.OnAwait(id)
	}
	if o.Block {
		<-ctx.Done()
		return ctx.Err()
	}
	return o.Err
}

// IDs returns the terminals Await was called for, in order.
func (o *Output) IDs() []string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return append([]string(nil), o.ids...)
}

// Repo is a fake command.RepoBackend. Err, when set, is returned by every call. List
// returns Repos. CreateWorktree calls OnCreateWorktree (when set) and then fails with
// CreateWorktreeErr (when set).
type Project struct {
	Calls
	Err               error
	Projects          []*v1.Project
	CreateWorktreeErr error
	OnCreateWorktree  func(*v1.CreateWorktreeRequest)
	// OnCleanup answers CleanupWorktrees (dry runs included); nil answers an empty
	// response for the requested repo.
	OnCleanup func(*v1.CleanupWorktreesRequest) (*v1.CleanupWorktreesResponse, error)
}

var _ command.ProjectBackend = (*Project)(nil)

// Register records the request and returns a repo named after the path.
func (f *Project) Register(_ context.Context, r *connect.Request[v1.RegisterProjectRequest]) (*connect.Response[v1.RegisterProjectResponse], error) {
	f.record(r.Msg)
	if f.Err != nil {
		return nil, f.Err
	}
	return connect.NewResponse(&v1.RegisterProjectResponse{Project: &v1.Project{Id: "r1", Name: "repo", Path: r.Msg.GetPath()}}), nil
}

// Unregister records the request.
func (f *Project) Unregister(_ context.Context, r *connect.Request[v1.UnregisterProjectRequest]) (*connect.Response[v1.UnregisterProjectResponse], error) {
	f.record(r.Msg)
	return connect.NewResponse(&v1.UnregisterProjectResponse{}), f.Err
}

// CreateWorktree records the request and echoes it as a worktree.
func (f *Project) CreateWorktree(_ context.Context, r *connect.Request[v1.CreateWorktreeRequest]) (*connect.Response[v1.CreateWorktreeResponse], error) {
	f.record(r.Msg)
	if f.OnCreateWorktree != nil {
		f.OnCreateWorktree(r.Msg)
	}
	if err := cmp.Or(f.Err, f.CreateWorktreeErr); err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.CreateWorktreeResponse{Worktree: &v1.Worktree{
		ProjectId: r.Msg.GetProjectId(), Branch: r.Msg.GetBranch(), Path: "/wt/" + r.Msg.GetBranch(),
	}}), nil
}

// RemoveWorktree records the request.
func (f *Project) RemoveWorktree(_ context.Context, r *connect.Request[v1.RemoveWorktreeRequest]) (*connect.Response[v1.RemoveWorktreeResponse], error) {
	f.record(r.Msg)
	return connect.NewResponse(&v1.RemoveWorktreeResponse{}), f.Err
}

// CleanupWorktrees records the request and answers with OnCleanup.
func (f *Project) CleanupWorktrees(_ context.Context, r *connect.Request[v1.CleanupWorktreesRequest]) (*connect.Response[v1.CleanupWorktreesResponse], error) {
	f.record(r.Msg)
	if f.Err != nil {
		return nil, f.Err
	}
	if f.OnCleanup == nil {
		return connect.NewResponse(&v1.CleanupWorktreesResponse{ProjectId: r.Msg.GetProject()}), nil
	}
	res, err := f.OnCleanup(r.Msg)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(res), nil
}

// List records the request and returns copies of Repos.
func (f *Project) List(_ context.Context, r *connect.Request[v1.ListProjectsRequest]) (*connect.Response[v1.ListProjectsResponse], error) {
	f.record(r.Msg)
	if f.Err != nil {
		return nil, f.Err
	}
	out := make([]*v1.Project, len(f.Projects))
	for i, project := range f.Projects {
		out[i] = proto.CloneOf(project)
	}
	return connect.NewResponse(&v1.ListProjectsResponse{Projects: out}), nil
}

// Refresh records the request.
func (f *Project) Refresh(_ context.Context, r *connect.Request[v1.RefreshProjectRequest]) (*connect.Response[v1.RefreshProjectResponse], error) {
	f.record(r.Msg)
	return connect.NewResponse(&v1.RefreshProjectResponse{}), f.Err
}

// InitGit records the request and returns a git repo on main with that id.
func (f *Project) InitGit(_ context.Context, r *connect.Request[v1.InitGitRequest]) (*connect.Response[v1.InitGitResponse], error) {
	f.record(r.Msg)
	if f.Err != nil {
		return nil, f.Err
	}
	return connect.NewResponse(&v1.InitGitResponse{Project: &v1.Project{Id: r.Msg.GetId(), Name: "notes", Git: true, DefaultBranch: "main"}}), nil
}
