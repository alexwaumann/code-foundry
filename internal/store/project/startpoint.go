package project

import (
	"cmp"
	"context"
	"errors"
	"slices"
	"strings"
)

// Where a new worktree's branch starts (CreateWorktreeOptions.BaseFromOrigin, the
// projects.base_from_origin setting). Every caller of CreateWorktree gets the same
// resolution: the thread store's new worktrees and workspaces, the workspace store's
// members, a recreated worktree and project.worktree.create.

// baseKind is how startPoint treats a typed base.
type baseKind int

const (
	// baseAsTyped: a tag, a sha, an expression ("HEAD~2", "@{u}", "refs/…"): used as
	// typed, never fetched.
	baseAsTyped baseKind = iota
	// baseRemote: "<remote>/<branch>" for a configured remote: used as typed, its
	// branch fetched first (with Fetch and BaseFromOrigin).
	baseRemote
	// baseBranch: a bare branch name ("main", "release/2.3"), local or not: origin's
	// copy when origin has it (with BaseFromOrigin), else as typed.
	baseBranch
)

// classifyBase says what base names. remotes are the configured remotes; has reports
// whether a ref resolves (rev-parse --verify). A local branch wins over a tag of the
// same name (the user picked it from the branch list); a name that is neither a local
// branch, a tag nor a commit is taken for a branch only origin has.
func classifyBase(base string, remotes []string, has func(ref string) bool) baseKind {
	if remote, _ := splitRemoteRef(remotes, base); remote != "" {
		return baseRemote
	}
	if !plainBranchName(base) {
		return baseAsTyped
	}
	if has("refs/heads/" + base) {
		return baseBranch
	}
	if has("refs/tags/"+base) || (looksLikeSHA(base) && has(base+"^{commit}")) {
		return baseAsTyped
	}
	return baseBranch
}

// plainBranchName reports whether name could be a branch's short name rather than a
// revision expression or a full ref. It is not git's full check: a name that passes
// here but is not a branch fails the fetch and the existence check, and is then used
// as typed, which is where git reports it.
func plainBranchName(name string) bool {
	switch {
	case name == "", name == "HEAD", name == "@",
		strings.HasPrefix(name, "refs/"), strings.HasPrefix(name, "-"), strings.HasPrefix(name, "/"),
		strings.ContainsAny(name, "~^:?*[\\ \t"), strings.Contains(name, "@{"), strings.Contains(name, ".."):
		return false
	}
	return true
}

// looksLikeSHA reports whether s could be an abbreviated or full commit id.
func looksLikeSHA(s string) bool {
	if len(s) < 4 || len(s) > 64 {
		return false
	}
	for _, c := range s {
		if !strings.ContainsRune("0123456789abcdefABCDEF", c) {
			return false
		}
	}
	return true
}

// startPoint is the ref a new branch starts from for opts (see
// CreateWorktreeOptions.BaseFromOrigin), fetched first when opts.Fetch says so.
func (g *Git) startPoint(ctx context.Context, m *projectMeta, opts CreateWorktreeOptions) string {
	typed := opts.BaseRef
	def := cmp.Or(m.DefaultBranch, "main")
	if !opts.BaseFromOrigin {
		if typed != "" {
			return typed
		}
		// The local default branch; origin's (not fetched) only when there is no
		// local one, rather than failing.
		if !g.refExists(ctx, m.Path, "refs/heads/"+def) && g.refExists(ctx, m.Path, "refs/remotes/origin/"+def) {
			return "origin/" + def
		}
		return def
	}
	remotes, err := g.remoteNames(ctx, m)
	if err != nil {
		g.log.Warn("fetch before worktree: listing remotes failed", "project", m.ID, "base", typed, "err", err)
	}
	name, kind := def, baseBranch
	if typed != "" {
		name = typed
		kind = classifyBase(typed, remotes, func(ref string) bool { return g.refExists(ctx, m.Path, ref) })
	}
	switch kind {
	case baseRemote:
		if opts.Fetch {
			remote, branch := splitRemoteRef(remotes, typed)
			if err := g.fetchRemoteBranch(ctx, m, remote, branch); err != nil {
				g.log.Warn("fetch before worktree failed; using the existing ref", "project", m.ID, "ref", typed, "err", err)
			}
		}
		return typed
	case baseAsTyped:
		return typed
	}
	if !slices.Contains(remotes, "origin") {
		return name
	}
	if opts.Fetch {
		if err := g.fetchRemoteBranch(ctx, m, "origin", name); err != nil {
			if missingRemoteRef(err) {
				g.log.Debug("origin has no such branch; using the local one", "project", m.ID, "branch", name)
			} else {
				g.log.Warn("fetch before worktree failed; using the existing ref", "project", m.ID, "ref", "origin/"+name, "err", err)
			}
		}
	}
	if !g.refExists(ctx, m.Path, "refs/remotes/origin/"+name) {
		return name
	}
	if typed != "" {
		g.log.Info("base resolved to origin's branch", "project", m.ID, "base", typed, "start_point", "origin/"+name)
	}
	return "origin/" + name
}

// missingRemoteRef reports whether a fetch failed because the remote has no such
// branch (rather than being unreachable).
func missingRemoteRef(err error) bool {
	var ge *GitError
	return errors.As(err, &ge) && strings.Contains(ge.Stderr, "couldn't find remote ref")
}
