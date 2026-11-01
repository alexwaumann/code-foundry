package project

import (
	"context"
	"fmt"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// Renaming a project (docs/notes/projects-table-3-rename.md). Registration names a
// project after its folder; Rename changes only the stored display name. The folder,
// worktree paths (worktreeKey reads the folder, not the name) and branches stay.

// reservedName is the primary keyword (workspace.PrimaryWorkspace): a project with
// that name wins over the keyword wherever a primary is named, so a rename may not
// take it.
const reservedName = "workspace"

// CheckName trims and NFC-normalises name and validates it as project id's new name
// among snap's projects. Project refs (the commands', the workspace store's) resolve an
// id first, then a name only when exactly one project has it, then a path; and
// --projects is a comma-separated list. So a name may not be another project's id,
// another project's name in any case (registration still allows two folders with one
// basename), the keyword, a path or a list.
func CheckName(snap *Snapshot, id, name string) (string, error) {
	name = norm.NFC.String(strings.TrimSpace(name))
	switch {
	case name == "":
		return "", fmt.Errorf("%w: a project name is required", ErrInvalidArgument)
	case len(name) > 100 || strings.IndexFunc(name, unicode.IsControl) >= 0:
		return "", fmt.Errorf("%w: a project name must be one line of at most 100 bytes", ErrInvalidArgument)
	case strings.ContainsAny(name, "/,") || name == "~":
		return "", fmt.Errorf("%w: a project name may not contain / or , (or be ~): refs read those as paths and lists", ErrInvalidArgument)
	case strings.EqualFold(name, reservedName):
		return "", fmt.Errorf("%w: %q is reserved (it names a workspace's folder as a thread's primary)", ErrInvalidArgument, name)
	}
	if snap == nil {
		return name, nil
	}
	for _, p := range snap.Projects {
		if p.ID == id {
			continue
		}
		if strings.EqualFold(p.ID, name) {
			return "", fmt.Errorf("%w: %q is the id of project %s; pick another name", ErrInvalidArgument, name, p.Name)
		}
		if strings.EqualFold(norm.NFC.String(p.Name), name) {
			return "", fmt.Errorf("%w: project %s (%s) is already named %q; project names must be unique to be used as refs",
				ErrFailedPrecondition, p.Path, p.ID, p.Name)
		}
	}
	return name, nil
}

// Rename implements Store.
func (g *Git) Rename(ctx context.Context, id, name string) (Project, error) {
	// One rename at a time, so two cannot both pass CheckName with the same name.
	g.renameMu.Lock()
	defer g.renameMu.Unlock()
	st := g.project(id)
	if st == nil {
		return Project{}, fmt.Errorf("%w: project %q", ErrNotFound, id)
	}
	name, err := CheckName(g.Snapshot(), id, name)
	if err != nil {
		return Project{}, err
	}
	if st.meta.Load().Name != name {
		res, err := g.db.ExecContext(ctx, `UPDATE projects SET name = ? WHERE id = ?`, name, id)
		if err != nil {
			return Project{}, fmt.Errorf("project: rename %s: %w", id, err)
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return Project{}, fmt.Errorf("%w: project %q", ErrNotFound, id)
		}
		g.mu.Lock()
		if g.projects[id] != st { // unregistered meanwhile
			g.mu.Unlock()
			return Project{}, fmt.Errorf("%w: project %q", ErrNotFound, id)
		}
		next := *st.meta.Load()
		next.Name = name
		st.meta.Store(&next) // reconcile keeps the stored name (renamedLocked)
		g.mu.Unlock()
		g.log.Info("project renamed", "id", id, "name", name)
		g.commit(projectUpdated(id))
	}
	r, ok := g.Snapshot().Project(id)
	if !ok {
		return Project{}, fmt.Errorf("%w: project %q", ErrNotFound, id)
	}
	return r, nil
}

// renamedLocked is the name reconcile stores for a project whose metadata it read as
// prev: the current one, which a Rename since may have changed. g.mu is held.
func renamedLocked(st *projectState, prev *projectMeta) string {
	if cur := st.meta.Load(); cur != prev {
		return cur.Name
	}
	return prev.Name
}
