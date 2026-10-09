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
	// Created is returned by Create; its Argv and Cwd are filled from the request.
	Created *v1.Terminal
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
	term.Argv, term.Cwd = r.Msg.GetArgv(), r.Msg.GetCwd()
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

// Repo is a fake command.RepoBackend. Err, when set, is returned by every call. List
// returns Repos. CreateWorktree calls OnCreateWorktree (when set) and then fails with
// CreateWorktreeErr (when set).
type Repo struct {
	Calls
	Err               error
	Repos             []*v1.Repo
	CreateWorktreeErr error
	OnCreateWorktree  func(*v1.CreateWorktreeRequest)
}

var _ command.RepoBackend = (*Repo)(nil)

// Register records the request and returns a repo named after the path.
func (f *Repo) Register(_ context.Context, r *connect.Request[v1.RegisterRepoRequest]) (*connect.Response[v1.RegisterRepoResponse], error) {
	f.record(r.Msg)
	if f.Err != nil {
		return nil, f.Err
	}
	return connect.NewResponse(&v1.RegisterRepoResponse{Repo: &v1.Repo{Id: "r1", Name: "repo", Path: r.Msg.GetPath()}}), nil
}

// Unregister records the request.
func (f *Repo) Unregister(_ context.Context, r *connect.Request[v1.UnregisterRepoRequest]) (*connect.Response[v1.UnregisterRepoResponse], error) {
	f.record(r.Msg)
	return connect.NewResponse(&v1.UnregisterRepoResponse{}), f.Err
}

// CreateWorktree records the request and echoes it as a worktree.
func (f *Repo) CreateWorktree(_ context.Context, r *connect.Request[v1.CreateWorktreeRequest]) (*connect.Response[v1.CreateWorktreeResponse], error) {
	f.record(r.Msg)
	if f.OnCreateWorktree != nil {
		f.OnCreateWorktree(r.Msg)
	}
	if err := cmp.Or(f.Err, f.CreateWorktreeErr); err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.CreateWorktreeResponse{Worktree: &v1.Worktree{
		RepoId: r.Msg.GetRepoId(), Branch: r.Msg.GetBranch(), Path: "/wt/" + r.Msg.GetBranch(),
	}}), nil
}

// RemoveWorktree records the request.
func (f *Repo) RemoveWorktree(_ context.Context, r *connect.Request[v1.RemoveWorktreeRequest]) (*connect.Response[v1.RemoveWorktreeResponse], error) {
	f.record(r.Msg)
	return connect.NewResponse(&v1.RemoveWorktreeResponse{}), f.Err
}

// List records the request and returns copies of Repos.
func (f *Repo) List(_ context.Context, r *connect.Request[v1.ListReposRequest]) (*connect.Response[v1.ListReposResponse], error) {
	f.record(r.Msg)
	if f.Err != nil {
		return nil, f.Err
	}
	out := make([]*v1.Repo, len(f.Repos))
	for i, repo := range f.Repos {
		out[i] = proto.CloneOf(repo)
	}
	return connect.NewResponse(&v1.ListReposResponse{Repos: out}), nil
}

// Refresh records the request.
func (f *Repo) Refresh(_ context.Context, r *connect.Request[v1.RefreshRepoRequest]) (*connect.Response[v1.RefreshRepoResponse], error) {
	f.record(r.Msg)
	return connect.NewResponse(&v1.RefreshRepoResponse{}), f.Err
}
