// Package projecttest provides an in-memory fake of project.Service for handler and
// command tests.
package projecttest

import (
	"context"
	"fmt"
	"path"
	"strings"
	"sync"

	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/repo"
)

// Fake is a project.Service. Create validates the name like the real store and refuses
// a name it created before; Publish fails with the error set for owner/name, else
// returns the project with origin and its GitHub slug; Delete forgets a project under
// Root and refuses any other.
type Fake struct {
	Root string

	mu      sync.Mutex
	created map[string]repo.Repo // by lower-cased name
	repos   map[string]repo.Repo // by id, for Publish
	errs    map[string]error     // owner/name -> Publish error
	calls   []string
}

var _ project.Service = (*Fake)(nil)

// New returns a fake creating projects under root.
func New(root string) *Fake {
	return &Fake{Root: root, created: map[string]repo.Repo{}, repos: map[string]repo.Repo{}, errs: map[string]error{}}
}

// AddRepo makes r publishable.
func (f *Fake) AddRepo(r repo.Repo) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.repos[r.ID] = r
}

// FailPublish makes publishing to owner/name fail with err.
func (f *Fake) FailPublish(slug string, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.errs[strings.ToLower(slug)] = err
}

// Calls lists every call: "create <name>", "publish <id> <owner>/<name> <visibility>",
// "delete <id>".
func (f *Fake) Calls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...)
}

// Create implements project.Service.
func (f *Fake) Create(_ context.Context, name string) (repo.Repo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "create "+name)
	if err := project.ValidateName(name); err != nil {
		return repo.Repo{}, err
	}
	dest := path.Join(f.Root, name)
	if _, ok := f.created[strings.ToLower(name)]; ok {
		return repo.Repo{}, fmt.Errorf("%s %w", dest, project.ErrExists)
	}
	r := repo.Repo{ID: "repo-" + strings.ToLower(name), Path: dest, Name: name, Git: true, DefaultBranch: "main"}
	f.created[strings.ToLower(name)] = r
	f.repos[r.ID] = r
	return r, nil
}

// Publish implements project.Service.
func (f *Fake) Publish(_ context.Context, o project.PublishOptions) (repo.Repo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	r, ok := f.repos[o.RepoID]
	if !ok {
		return repo.Repo{}, fmt.Errorf("%w: %q", project.ErrNotFound, o.RepoID)
	}
	name := o.Name
	if name == "" {
		name = r.Name
	}
	slug := o.Owner + "/" + name
	f.calls = append(f.calls, fmt.Sprintf("publish %s %s %s", o.RepoID, slug, o.Visibility))
	if err := f.errs[strings.ToLower(slug)]; err != nil {
		return repo.Repo{}, err
	}
	r.Remotes = []string{"origin"}
	r.GitHubSlug = strings.ToLower(slug)
	f.repos[r.ID] = r
	return r, nil
}

// Delete implements project.Service.
func (f *Fake) Delete(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "delete "+id)
	r, ok := f.repos[id]
	if !ok {
		return fmt.Errorf("%w: %q", project.ErrNotFound, id)
	}
	if path.Dir(r.Path) != f.Root {
		return fmt.Errorf("%w: %s is not in the projects directory %s", project.ErrFailedPrecondition, r.Path, f.Root)
	}
	delete(f.repos, id)
	delete(f.created, strings.ToLower(r.Name))
	return nil
}
