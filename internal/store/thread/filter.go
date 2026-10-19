package thread

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/workspace"
)

// Listing threads for agents (thread.list; docs/notes/agents-5-cli.md): an agent with
// hundreds of archived threads asks the daemon for the few it cares about instead of
// reading them all.

// CreatedByUser is ListOptions.CreatedBy for threads no thread created.
const CreatedByUser = "user"

// ListOptions selects threads for Store.List. Every set field must match.
type ListOptions struct {
	// All: every thread, archived ones too (IncludeArchived); the other fields still
	// apply. (The API also answers with the retired usage ledger.)
	All bool
	// IncludeArchived keeps archived threads (they are left out by default).
	IncludeArchived bool
	// Status and State: only threads with them; StatusUnknown and StateUnspecified
	// match any.
	Status Status
	State  State
	// Project: only threads whose cwd is in this project. Store.List takes an id, a
	// name or a path inside one of its worktrees; FilterThreads compares the id.
	Project string
	// Workspace: only threads the workspace owns. Store.List takes an id or a name;
	// FilterThreads compares the id.
	Workspace string
	// CreatedBy: only threads this thread created, or CreatedByUser for the user's.
	CreatedBy string
	// Labels: only threads carrying every one (lowercased like Store.Label's).
	Labels []string
	// Owner: only threads with this owner ("plugin:hello"), or, ending in ":", any
	// owner with that prefix ("plugin:"). Without it (and without All) owned threads
	// are left out: they are not the user's (owner.go).
	Owner string
	// Limit: at most this many, the most recently active; 0 for no limit.
	Limit int
}

// FilterThreads returns the threads o selects, the most recently active first (last
// activity, else creation; then the newest created, then by id), at most o.Limit of
// them. o.Project and o.Workspace are compared as ids.
func FilterThreads(threads []Thread, o ListOptions) []Thread {
	var out []Thread
	for _, t := range threads {
		if o.matches(t) {
			out = append(out, t)
		}
	}
	slices.SortStableFunc(out, func(a, b Thread) int {
		return cmp.Or(lastActive(b).Compare(lastActive(a)), b.CreatedAt.Compare(a.CreatedAt), cmp.Compare(a.ID, b.ID))
	})
	if o.Limit > 0 && len(out) > o.Limit {
		out = out[:o.Limit]
	}
	return out
}

func (o ListOptions) matches(t Thread) bool {
	switch {
	case !o.All && !o.IncludeArchived && !t.ArchivedAt.IsZero():
		return false
	case !o.ownerMatches(t.Owner):
		return false
	case o.Status != StatusUnknown && t.Status != o.Status:
		return false
	case o.State != StateUnspecified && t.State != o.State:
		return false
	case o.Project != "" && t.ProjectID != o.Project:
		return false
	case o.Workspace != "" && t.WorkspaceID != o.Workspace:
		return false
	case o.CreatedBy == CreatedByUser && t.CreatedBy != "":
		return false
	case o.CreatedBy != "" && o.CreatedBy != CreatedByUser && t.CreatedBy != o.CreatedBy:
		return false
	}
	for _, l := range o.Labels {
		if l = strings.ToLower(strings.TrimSpace(l)); l != "" && !slices.Contains(t.Labels, l) {
			return false
		}
	}
	return true
}

// lastActive is when t last did something: its last activity, else its creation.
func lastActive(t Thread) time.Time {
	if !t.LastActivityAt.IsZero() {
		return t.LastActivityAt
	}
	return t.CreatedAt
}

// List returns the threads o selects (FilterThreads), resolving its Project (an id, a
// name, or a path inside a worktree) and Workspace (an id or a name) first. A ref that
// names nothing is ErrInvalidArgument.
func (m *Manager) List(_ context.Context, o ListOptions) ([]Thread, error) {
	o, err := m.resolveListRefs(o)
	if err != nil {
		return nil, err
	}
	return FilterThreads(m.Snapshot().Threads, o), nil
}

// resolveListRefs resolves o's Project (an id, a name, or a path inside a worktree)
// and Workspace (an id or a name) to ids. A ref that names nothing is
// ErrInvalidArgument.
func (m *Manager) resolveListRefs(o ListOptions) (ListOptions, error) {
	if o.Project != "" && m.opts.Projects != nil { // without a project store (tests): an id
		r, err := workspace.ResolveProject(m.opts.Projects.Snapshot(), o.Project)
		if err != nil {
			return o, listRefError("project", o.Project, err)
		}
		o.Project = r.ID
	}
	if o.Workspace != "" {
		if m.opts.Workspaces == nil {
			return o, fmt.Errorf("%w: no workspace %q", ErrInvalidArgument, o.Workspace)
		}
		w, err := workspace.ResolveWorkspace(m.opts.Workspaces.Snapshot(), workspace.Ref{Workspace: o.Workspace})
		if err != nil {
			return o, listRefError("workspace", o.Workspace, err)
		}
		o.Workspace = w.ID
	}
	return o, nil
}

// listRefError is a filter ref that names nothing (or several), as InvalidArgument.
func listRefError(what, ref string, err error) error {
	if errors.Is(err, workspace.ErrInvalidArgument) {
		return fmt.Errorf("%w: %s %q: %v", ErrInvalidArgument, what, ref, err)
	}
	return fmt.Errorf("%w: no %s %q", ErrInvalidArgument, what, ref)
}
