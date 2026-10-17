// Package newprojecttest provides an in-memory fake of newproject.Service for handler and
// command tests.
package newprojecttest

import (
	"context"
	"fmt"
	"path"
	"strings"
	"sync"

	"github.com/alexwaumann/code-foundry/internal/store/newproject"
	"github.com/alexwaumann/code-foundry/internal/store/project"
)

// Fake is a newproject.Service. Create validates the name like the real store and refuses
// a name it created before; Publish fails with the error set for owner/name, else
// returns the project with origin and its GitHub slug; Delete forgets a project under
// Root and refuses any other.
type Fake struct {
	Root string

	mu       sync.Mutex
	created  map[string]project.Project // by lower-cased name
	projects map[string]project.Project // by id, for Publish
	errs     map[string]error           // owner/name -> Publish error
	calls    []string
}

var _ newproject.Service = (*Fake)(nil)

// New returns a fake creating projects under root.
func New(root string) *Fake {
	return &Fake{Root: root, created: map[string]project.Project{}, projects: map[string]project.Project{}, errs: map[string]error{}}
}

// AddProject makes r publishable.
func (f *Fake) AddProject(r project.Project) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.projects[r.ID] = r
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

// Create implements newproject.Service.
func (f *Fake) Create(_ context.Context, name string) (project.Project, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "create "+name)
	if err := newproject.ValidateName(name); err != nil {
		return project.Project{}, err
	}
	dest := path.Join(f.Root, name)
	if _, ok := f.created[strings.ToLower(name)]; ok {
		return project.Project{}, fmt.Errorf("%s %w", dest, newproject.ErrExists)
	}
	r := project.Project{ID: "repo-" + strings.ToLower(name), Path: dest, Name: name, Git: true, DefaultBranch: "main"}
	f.created[strings.ToLower(name)] = r
	f.projects[r.ID] = r
	return r, nil
}

// Publish implements newproject.Service.
func (f *Fake) Publish(_ context.Context, o newproject.PublishOptions) (project.Project, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	r, ok := f.projects[o.ProjectID]
	if !ok {
		return project.Project{}, fmt.Errorf("%w: %q", newproject.ErrNotFound, o.ProjectID)
	}
	name := o.Name
	if name == "" {
		name = r.Name
	}
	slug := o.Owner + "/" + name
	f.calls = append(f.calls, fmt.Sprintf("publish %s %s %s", o.ProjectID, slug, o.Visibility))
	if err := f.errs[strings.ToLower(slug)]; err != nil {
		return project.Project{}, err
	}
	r.Remotes = []string{"origin"}
	r.GitHubSlug = strings.ToLower(slug)
	f.projects[r.ID] = r
	return r, nil
}

// Delete implements newproject.Service.
func (f *Fake) Delete(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "delete "+id)
	r, ok := f.projects[id]
	if !ok {
		return fmt.Errorf("%w: %q", newproject.ErrNotFound, id)
	}
	if path.Dir(r.Path) != f.Root {
		return fmt.Errorf("%w: %s is not in the projects directory %s", newproject.ErrFailedPrecondition, r.Path, f.Root)
	}
	delete(f.projects, id)
	delete(f.created, strings.ToLower(r.Name))
	return nil
}
