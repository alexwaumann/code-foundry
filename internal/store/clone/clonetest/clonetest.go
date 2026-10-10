// Package clonetest provides an in-memory fake of clone.Service for handler and
// command tests.
package clonetest

import (
	"context"
	"fmt"
	"path"
	"strings"
	"sync"

	"github.com/alexwaumann/code-foundry/internal/store/clone"
	"github.com/alexwaumann/code-foundry/internal/store/repo"
)

// Fake is a clone.Service. Clone emits Lines, then fails with Errs[owner/name] when
// set, else marks the destination taken and returns a git project at it.
type Fake struct {
	Root  string
	Lines []clone.Progress

	mu    sync.Mutex
	errs  map[string]error
	taken map[string]bool
	calls []string
}

var _ clone.Service = (*Fake)(nil)

// New returns a fake cloning into root.
func New(root string) *Fake {
	return &Fake{Root: root, errs: map[string]error{}, taken: map[string]bool{}}
}

// Fail makes cloning owner/name fail with err.
func (f *Fake) Fail(slug string, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.errs[strings.ToLower(slug)] = err
}

// Take marks owner/name's destination as existing.
func (f *Fake) Take(slug string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.taken[strings.ToLower(slug)] = true
}

// Calls returns the owner/name of every Clone call.
func (f *Fake) Calls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...)
}

// Destination implements clone.Service.
func (f *Fake) Destination(owner, name string) (string, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return path.Join(f.Root, owner, name), f.taken[strings.ToLower(owner+"/"+name)]
}

// Clone implements clone.Service.
func (f *Fake) Clone(_ context.Context, owner, name string, progress func(clone.Progress)) (repo.Repo, error) {
	slug := owner + "/" + name
	f.mu.Lock()
	f.calls = append(f.calls, slug)
	err, taken := f.errs[strings.ToLower(slug)], f.taken[strings.ToLower(slug)]
	f.mu.Unlock()
	dest := path.Join(f.Root, owner, name)
	if taken {
		return repo.Repo{}, fmt.Errorf("%s %w", dest, clone.ErrExists)
	}
	for _, l := range f.Lines {
		if progress != nil {
			progress(l)
		}
	}
	if err != nil {
		return repo.Repo{}, err
	}
	f.Take(slug)
	return repo.Repo{ID: "repo-" + strings.ToLower(name), Path: dest, Name: name, Git: true,
		GitHubSlug: strings.ToLower(slug), Remotes: []string{"origin"}}, nil
}
