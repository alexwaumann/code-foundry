package project

import (
	"cmp"
	"context"
	"errors"
	"slices"
	"strconv"
	"strings"
)

// Where a new worktree's branch starts (CreateWorktreeOptions.BaseFromOrigin, the
// projects.base_from_origin setting). Every caller of CreateWorktree gets the same
// resolution: the thread store's new worktrees and workspaces, the workspace store's
// members, a recreated worktree and project.worktree.create.
//
// The rule, per repository: a bare branch name (or the default branch when no base is
// given) is origin's copy, fetched first, unless the local branch is ahead of it
// (rev-list --count origin/<b>..<b> > 0, so a diverged branch counts as ahead), in
// which case it is the local branch. Without origin, or when origin has no such branch,
// it is the local branch. BaseFromOrigin off is the kill switch: always the local
// branch, and new branches are not fetched from origin; checking out a branch only
// origin has (CreateWorktree's DWIM case) still fetches it.

// baseKind is how startPoint treats a typed base.
type baseKind int

const (
	// baseAsTyped: a tag, a sha, an expression ("HEAD~2", "@{u}", "refs/…"): used as
	// typed, never fetched.
	baseAsTyped baseKind = iota
	// baseRemote: "<remote>/<branch>" for a configured remote: used as typed, its
	// branch fetched first (with Fetch and BaseFromOrigin).
	baseRemote
	// baseBranch: a bare branch name ("main", "release/2.3"), local or not: with
	// BaseFromOrigin, origin's copy when origin has it and the local branch is not
	// ahead of it, else the local branch (as typed).
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

// basePlan is how a typed (or default) base resolves in one repository, before anything
// is fetched: what it names and which remote branch it follows.
type basePlan struct {
	typed, name string
	kind        baseKind
	remotes     []string
}

// planBase classifies opts' base (opts.BaseFromOrigin only).
func (g *Git) planBase(ctx context.Context, m *projectMeta, opts CreateWorktreeOptions) basePlan {
	remotes, err := g.remoteNames(ctx, m)
	if err != nil {
		g.log.Warn("fetch before worktree: listing remotes failed", "project", m.ID, "base", opts.BaseRef, "err", err)
	}
	p := basePlan{typed: opts.BaseRef, name: cmp.Or(m.DefaultBranch, "main"), kind: baseBranch, remotes: remotes}
	if p.typed != "" {
		p.name = p.typed
		p.kind = classifyBase(p.typed, remotes, func(ref string) bool { return g.refExists(ctx, m.Path, ref) })
	}
	return p
}

// remoteBranch is the remote branch p follows, the one a fetch refreshes; "" when it
// follows none (a tag, a sha, an expression, a repository without origin).
func (p basePlan) remoteBranch() (remote, branch string) {
	switch {
	case p.kind == baseRemote:
		return splitRemoteRef(p.remotes, p.typed)
	case p.kind == baseBranch && slices.Contains(p.remotes, "origin"):
		return "origin", p.name
	}
	return "", ""
}

// fetchPlanned fetches the remote branch p follows, if any. A failure is not an error:
// the existing ref is used, and opts.Progress is told so.
func (g *Git) fetchPlanned(ctx context.Context, m *projectMeta, p basePlan, opts CreateWorktreeOptions) {
	remote, branch := p.remoteBranch()
	if remote == "" {
		return
	}
	g.fetchReported(ctx, m, remote, branch, opts, func(err error) {
		if p.kind == baseBranch && missingRemoteRef(err) {
			g.log.Debug("origin has no such branch; using the local one", "project", m.ID, "branch", branch)
			return
		}
		g.log.Warn("fetch before worktree failed; using the existing ref", "project", m.ID, "ref", remote+"/"+branch, "err", err)
	})
}

// FetchBase runs the fetch CreateWorktree's opts.Fetch would run for a new branch from
// opts.BaseRef, on its own: the fetch does not depend on the branch's name, so a caller
// still waiting for the name runs it meanwhile and then calls CreateWorktree without
// Fetch, which resolves the same start point from the refs fetched here. Nothing is
// fetched with opts.BaseFromOrigin off. Failures are told through opts.Progress, never
// returned: as in CreateWorktree, a stale start point is better than no worktree.
func (g *Git) FetchBase(ctx context.Context, opts CreateWorktreeOptions) {
	st := g.project(opts.ProjectID)
	if st == nil || !opts.BaseFromOrigin {
		return
	}
	m := st.meta.Load()
	if requireGit(m) != nil {
		return
	}
	g.fetchPlanned(ctx, m, g.planBase(ctx, m, opts), opts)
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
	p := g.planBase(ctx, m, opts)
	if opts.Fetch {
		g.fetchPlanned(ctx, m, p, opts)
	}
	if p.kind != baseBranch {
		return typed
	}
	name := p.name
	if !slices.Contains(p.remotes, "origin") {
		return name
	}
	if !g.refExists(ctx, m.Path, "refs/remotes/origin/"+name) {
		return name
	}
	if ahead := g.localAhead(ctx, m, name); ahead > 0 {
		g.log.Info("base resolved to the local branch, ahead of origin's", "project", m.ID, "base", cmp.Or(typed, name),
			"start_point", name, "ahead", ahead)
		return name
	}
	if typed != "" {
		g.log.Info("base resolved to origin's branch", "project", m.ID, "base", typed, "start_point", "origin/"+name)
	}
	return "origin/" + name
}

// localAhead counts the commits the local branch has that origin's copy has not
// (rev-list --count origin/<branch>..<branch>; a diverged branch counts). 0 when there
// is no local branch, or when the count fails (logged), so origin's copy is used.
func (g *Git) localAhead(ctx context.Context, m *projectMeta, branch string) int {
	if !g.refExists(ctx, m.Path, "refs/heads/"+branch) {
		return 0
	}
	out, err := g.runner.Run(ctx, m.Path, "rev-list", "--count", "refs/remotes/origin/"+branch+"..refs/heads/"+branch)
	if err == nil {
		var n int
		if n, err = strconv.Atoi(strings.TrimSpace(string(out))); err == nil {
			return n
		}
	}
	g.log.Warn("comparing the local branch with origin's failed; using origin's", "project", m.ID, "branch", branch, "err", err)
	return 0
}

// missingRemoteRef reports whether a fetch failed because the remote has no such
// branch (rather than being unreachable).
func missingRemoteRef(err error) bool {
	var ge *GitError
	return errors.As(err, &ge) && strings.Contains(ge.Stderr, "couldn't find remote ref")
}
