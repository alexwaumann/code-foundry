package workspace

import (
	"cmp"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"

	"github.com/alexwaumann/code-foundry/internal/store/project"
)

// Pure lookups and validation shared by the Manager and the fake.

// ResolveWorkspace finds the workspace ref names in snap: by id (an exact match of an
// existing id), then by name (case-insensitively, NFC). A name never looks like an id
// (cleanName, nameFree), so the two cannot shadow each other.
func ResolveWorkspace(snap *Snapshot, ref string) (Workspace, error) {
	key := strings.TrimSpace(ref)
	if key == "" {
		return Workspace{}, fmt.Errorf("%w: a workspace id or name is required", ErrInvalidArgument)
	}
	if w, ok := snap.Workspace(key); ok {
		return w, nil
	}
	if w, ok := snap.Named(norm.NFC.String(key)); ok {
		return w, nil
	}
	return Workspace{}, fmt.Errorf("%w: workspace %q", ErrNotFound, key)
}

// ResolveProject finds a registered project by id, by name when exactly one has it,
// or by an absolute path inside its main worktree or any of its worktrees.
func ResolveProject(snap *project.Snapshot, ref string) (project.Project, error) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return project.Project{}, fmt.Errorf("%w: a project is required", ErrInvalidArgument)
	}
	if snap == nil {
		snap = &project.Snapshot{}
	}
	if r, ok := snap.Project(ref); ok {
		return r, nil
	}
	var named []project.Project
	for _, r := range snap.Projects {
		if r.Name == ref {
			named = append(named, r)
		}
	}
	switch len(named) {
	case 1:
		return named[0], nil
	case 0:
	default:
		ids := make([]string, len(named))
		for i, r := range named {
			ids[i] = r.ID + " (" + r.Path + ")"
		}
		return project.Project{}, fmt.Errorf("%w: more than one project is named %q; use its id: %s",
			ErrInvalidArgument, ref, strings.Join(ids, ", "))
	}
	if filepath.IsAbs(ref) {
		var best project.Project
		depth := -1
		for _, r := range snap.Projects {
			roots := []string{r.Path}
			for _, w := range r.Worktrees {
				roots = append(roots, w.Path)
			}
			for _, root := range roots {
				if Within(ref, root) && len(root) > depth {
					best, depth = r, len(root)
				}
			}
		}
		if depth >= 0 {
			return best, nil
		}
	}
	return project.Project{}, fmt.Errorf("%w: project %q is not registered (add it with `code-foundry project add <folder>`)", ErrNotFound, ref)
}

// IsKeyword reports whether ref is the PrimaryWorkspace keyword (any case) and no
// registered project answers to it: a project whose id or name is "workspace" wins
// everywhere a primary is named (thread new --project, set-primary, a default primary).
func IsKeyword(snap *project.Snapshot, ref string) bool {
	if !strings.EqualFold(strings.TrimSpace(ref), PrimaryWorkspace) {
		return false
	}
	_, err := ResolveProject(snap, ref)
	return err != nil
}

// memberRef resolves ref to one of w's members: a member id, a member project's name,
// or anything ResolveProject resolves to a member.
func memberRef(w Workspace, projects *project.Snapshot, ref string) (string, error) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return "", fmt.Errorf("%w: a project is required", ErrInvalidArgument)
	}
	if w.Member(ref) {
		return ref, nil
	}
	for _, id := range w.Members {
		if r, ok := projects.Project(id); ok && r.Name == ref {
			return id, nil
		}
	}
	if r, err := ResolveProject(projects, ref); err == nil && w.Member(r.ID) {
		return r.ID, nil
	}
	return "", fmt.Errorf("%w: %q is not a member of workspace %s", ErrNotFound, ref, w.Name)
}

// Within reports whether path is root or inside it, comparing both the cleaned paths
// and their symlink-resolved forms (/tmp and /private/tmp are the same place).
func Within(path, root string) bool {
	if path == "" || root == "" {
		return false
	}
	for _, p := range []string{filepath.Clean(path), realPath(path)} {
		for _, r := range []string{filepath.Clean(root), realPath(root)} {
			if p == r || strings.HasPrefix(p, strings.TrimSuffix(r, "/")+"/") {
				return true
			}
		}
	}
	return false
}

// realPath resolves symlinks. For a path that does not exist (yet), it resolves the
// longest existing ancestor and keeps the rest, so /tmp/x/missing still compares
// equal to /private/tmp/x/missing.
func realPath(p string) string {
	p = filepath.Clean(p)
	if r, err := filepath.EvalSymlinks(p); err == nil {
		return r
	}
	parent := filepath.Dir(p)
	if parent == p {
		return p
	}
	return filepath.Join(realPath(parent), filepath.Base(p))
}

// idPattern is the shape of a workspace id; a name may not have it (ResolveWorkspace
// tries ids first).
var idPattern = regexp.MustCompile(`^w-[0-9a-fA-F]{12}$`)

// cleanName trims, NFC-normalises (two spellings of "café" are one name) and validates
// a workspace name.
func cleanName(name string) (string, error) {
	name = norm.NFC.String(strings.TrimSpace(name))
	switch {
	case name == "":
		return "", fmt.Errorf("%w: a workspace name is required", ErrInvalidArgument)
	case len(name) > 100 || strings.IndexFunc(name, unicode.IsControl) >= 0:
		return "", fmt.Errorf("%w: name must be one line of at most 100 bytes", ErrInvalidArgument)
	case strings.EqualFold(name, PrimaryWorkspace):
		return "", fmt.Errorf("%w: %q is reserved (it names a workspace as a thread's primary)", ErrInvalidArgument, name)
	case idPattern.MatchString(name):
		return "", fmt.Errorf("%w: %q looks like a workspace id; pick another name", ErrInvalidArgument, name)
	}
	return name, nil
}

// nameFree refuses a name another workspace in snap has (case-insensitively); except is
// the workspace being renamed.
// A name equal to any workspace's id is refused too.
func nameFree(snap *Snapshot, name, except string) error {
	for _, w := range snap.Workspaces {
		if strings.EqualFold(w.ID, name) {
			return fmt.Errorf("%w: %q is the id of workspace %s; pick another name", ErrInvalidArgument, name, w.Name)
		}
	}
	if w, ok := snap.Named(name); ok && w.ID != except {
		return fmt.Errorf("%w: a workspace named %q exists (%s)", ErrFailedPrecondition, w.Name, w.ID)
	}
	return nil
}

var slugJunk = regexp.MustCompile(`[^a-z0-9]+`)

// Slug turns a name into a branch component: lowercase ASCII letters and digits
// joined by single dashes, at most 60 bytes.
func Slug(name string) string {
	s := strings.Trim(slugJunk.ReplaceAllString(strings.ToLower(name), "-"), "-")
	if len(s) > 60 {
		s = strings.TrimRight(s[:60], "-")
	}
	return s
}

// newID returns a workspace id ("w-" + 12 hex digits).
func newID() (string, error) {
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("workspace id: %w", err)
	}
	return "w-" + hex.EncodeToString(b[:]), nil
}

// sortWorkspaces orders a snapshot: by name (case-insensitively), then id.
func sortWorkspaces(ws []Workspace) {
	slices.SortFunc(ws, func(a, b Workspace) int {
		return cmp.Or(strings.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name)), strings.Compare(a.ID, b.ID))
	})
}

// sortedMembers is ids sorted, without blanks and duplicates.
func sortedMembers(ids []string) []string {
	out := slices.DeleteFunc(slices.Clone(ids), func(s string) bool { return s == "" })
	slices.Sort(out)
	return slices.Compact(out)
}
