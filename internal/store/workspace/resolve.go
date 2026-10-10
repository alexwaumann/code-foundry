package workspace

import (
	"cmp"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"unicode"

	"github.com/alexwaumann/code-foundry/internal/store/repo"
)

// Pure lookups and validation shared by the Manager and the fake.

// branchPrefix namespaces branches the app derives from a name (as new threads do).
const branchPrefix = "cf/"

// ResolveWorkspace finds the workspace ref names in snap: by id, then by name, else
// (with no Workspace given) the one with a member worktree containing ref.Cwd.
func ResolveWorkspace(snap *Snapshot, ref Ref) (Workspace, error) {
	if snap == nil {
		snap = &Snapshot{}
	}
	if key := strings.TrimSpace(ref.Workspace); key != "" {
		if w, ok := snap.Workspace(key); ok {
			return w, nil
		}
		for _, w := range snap.Workspaces {
			if w.Name == key {
				return w, nil
			}
		}
		return Workspace{}, fmt.Errorf("%w: workspace %q", ErrNotFound, key)
	}
	if ref.Cwd == "" {
		return Workspace{}, fmt.Errorf("%w: a workspace id or name, or a path inside a workspace worktree, is required", ErrInvalidArgument)
	}
	if !filepath.IsAbs(ref.Cwd) {
		return Workspace{}, fmt.Errorf("%w: path %q must be absolute", ErrInvalidArgument, ref.Cwd)
	}
	if w, _, ok := MemberAt(snap, ref.Cwd); ok {
		return w, nil
	}
	return Workspace{}, fmt.Errorf("%w: %s is not inside a workspace worktree", ErrNotFound, ref.Cwd)
}

// MemberAt returns the workspace and member whose worktree contains path. When
// worktrees nest, the deepest wins.
func MemberAt(snap *Snapshot, path string) (Workspace, Member, bool) {
	var (
		bw    Workspace
		bm    Member
		depth = -1
	)
	if snap == nil || path == "" {
		return bw, bm, false
	}
	for _, w := range snap.Workspaces {
		for _, m := range w.Members {
			if within(path, m.WorktreePath) && len(m.WorktreePath) > depth {
				bw, bm, depth = w, m, len(m.WorktreePath)
			}
		}
	}
	return bw, bm, depth >= 0
}

// within reports whether path is root or inside it, comparing both the cleaned paths
// and their symlink-resolved forms (/tmp and /private/tmp are the same place).
func within(path, root string) bool {
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

// realPath resolves symlinks, returning the cleaned input if that fails.
func realPath(p string) string {
	if r, err := filepath.EvalSymlinks(p); err == nil {
		return r
	}
	return filepath.Clean(p)
}

// resolveRepo finds a registered repository by id, by name when exactly one has it,
// or by an absolute path inside its main worktree or any of its worktrees.
func resolveRepo(snap *repo.Snapshot, ref string) (repo.Repo, error) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return repo.Repo{}, fmt.Errorf("%w: a repository is required", ErrInvalidArgument)
	}
	if snap == nil {
		snap = &repo.Snapshot{}
	}
	if r, ok := snap.Repo(ref); ok {
		return r, nil
	}
	var named []repo.Repo
	for _, r := range snap.Repos {
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
		return repo.Repo{}, fmt.Errorf("%w: more than one repository is named %q; use its id: %s",
			ErrInvalidArgument, ref, strings.Join(ids, ", "))
	}
	if filepath.IsAbs(ref) {
		var best repo.Repo
		depth := -1
		for _, r := range snap.Repos {
			roots := []string{r.Path}
			for _, w := range r.Worktrees {
				roots = append(roots, w.Path)
			}
			for _, root := range roots {
				if within(ref, root) && len(root) > depth {
					best, depth = r, len(root)
				}
			}
		}
		if depth >= 0 {
			return best, nil
		}
	}
	return repo.Repo{}, fmt.Errorf("%w: repository %q is not registered (register it with `code-foundry repo register <path>`)", ErrNotFound, ref)
}

// memberFor finds the member of w that ref names: a path inside its worktree, its
// repository's id or name, or a path inside its repository.
func memberFor(w Workspace, repos *repo.Snapshot, ref string) (Member, error) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return Member{}, fmt.Errorf("%w: a repository is required", ErrInvalidArgument)
	}
	if filepath.IsAbs(ref) {
		for _, m := range w.Members {
			if within(ref, m.WorktreePath) {
				return m, nil
			}
		}
	}
	if m, ok := w.Member(ref); ok {
		return m, nil
	}
	if repos != nil {
		for _, m := range w.Members {
			if r, ok := repos.Repo(m.RepoID); ok && r.Name == ref {
				return m, nil
			}
		}
	}
	r, err := resolveRepo(repos, ref)
	if err == nil {
		if m, ok := w.Member(r.ID); ok {
			return m, nil
		}
	}
	return Member{}, fmt.Errorf("%w: %q is not a member of workspace %s", ErrNotFound, ref, w.Name)
}

// Join lists w's members with the repo store's current state; the member containing
// cwd (if any) is Current.
func Join(w Workspace, repos *repo.Snapshot, cwd string) Membership {
	out := Membership{Workspace: w, Members: make([]MemberInfo, len(w.Members))}
	current := -1
	depth := -1
	for i, m := range w.Members {
		info := MemberInfo{Member: m, Branch: w.Branch, Missing: true}
		if r, ok := repos.Repo(m.RepoID); ok {
			info.RepoName = r.Name
			if wt, ok := repos.Worktree(r.ID, m.WorktreePath); ok {
				info.Missing = false
				if wt.Branch != "" {
					info.Branch = wt.Branch
				} else if wt.Detached {
					info.Branch = "(detached)"
				}
			}
		}
		if cwd != "" && within(cwd, m.WorktreePath) && len(m.WorktreePath) > depth {
			current, depth = i, len(m.WorktreePath)
		}
		out.Members[i] = info
	}
	if current >= 0 {
		out.Members[current].Current = true
	}
	return out
}

// threadsIn returns the threads running inside path.
func threadsIn(threads []Thread, path string) []Thread {
	var out []Thread
	for _, t := range threads {
		if within(t.Cwd, path) {
			out = append(out, t)
		}
	}
	return out
}

// describeThreads is "thread fix-login (s-1), thread s-2".
func describeThreads(ts []Thread) string {
	parts := make([]string, len(ts))
	for i, t := range ts {
		if t.Name != "" {
			parts[i] = "thread " + t.Name + " (" + t.ID + ")"
		} else {
			parts[i] = "thread " + t.ID
		}
	}
	return strings.Join(parts, ", ")
}

// cleanName trims and validates a workspace name.
func cleanName(name string) (string, error) {
	name = strings.TrimSpace(name)
	switch {
	case name == "":
		return "", fmt.Errorf("%w: a workspace name is required", ErrInvalidArgument)
	case len(name) > 100 || strings.IndexFunc(name, unicode.IsControl) >= 0:
		return "", fmt.Errorf("%w: name must be one line of at most 100 bytes", ErrInvalidArgument)
	}
	return name, nil
}

var slugJunk = regexp.MustCompile(`[^a-z0-9]+`)

// slug turns a name into a branch component: lowercase ASCII letters and digits
// joined by single dashes, at most 60 bytes.
func slug(name string) string {
	s := strings.Trim(slugJunk.ReplaceAllString(strings.ToLower(name), "-"), "-")
	if len(s) > 60 {
		s = strings.TrimRight(s[:60], "-")
	}
	return s
}

// branchFor is the branch a workspace gets: the given one, else cf/<slug of name>.
func branchFor(name, branch string) (string, error) {
	branch = strings.TrimSpace(branch)
	if branch == "" {
		s := slug(name)
		if s == "" {
			return "", fmt.Errorf("%w: cannot derive a branch from name %q; pass a branch", ErrInvalidArgument, name)
		}
		branch = branchPrefix + s
	}
	return branch, validateRef("branch", branch)
}

// validateRef rejects refs that could be read as a git option or are not one word.
// git validates the rest (repo.Store.CreateWorktree runs check-ref-format).
func validateRef(what, ref string) error {
	if ref == "" {
		return nil
	}
	if strings.HasPrefix(ref, "-") || len(ref) > 250 || strings.IndexFunc(ref, func(r rune) bool {
		return unicode.IsSpace(r) || unicode.IsControl(r)
	}) >= 0 {
		return fmt.Errorf("%w: %s %q", ErrInvalidArgument, what, ref)
	}
	return nil
}

// newID returns a workspace id ("w-" + 12 hex digits).
func newID() (string, error) {
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("workspace id: %w", err)
	}
	return "w-" + hex.EncodeToString(b[:]), nil
}

// exists reports whether path exists on disk.
func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// sortWorkspaces orders a snapshot: by name, then id.
func sortWorkspaces(ws []Workspace) {
	slices.SortFunc(ws, func(a, b Workspace) int {
		return cmp.Or(strings.Compare(a.Name, b.Name), strings.Compare(a.ID, b.ID))
	})
}
