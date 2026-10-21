package project

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// Deleting a branch whose worktree is gone (docs/notes/orch-cli-batch.md, W4 finding 3):
// once `project worktree remove` ran, --delete-branch had nothing to point at, and an
// orchestrator told to discard a child's work deleted the branch (and origin's) with raw
// git behind the daemon's back.

// DeleteBranchOptions configures Store.DeleteBranch.
type DeleteBranchOptions struct {
	ProjectID string
	Branch    string
	// Force deletes the branch whatever it holds (unmerged commits are lost). Without
	// it the branch, and with Remote origin's copy, must be merged into the project's
	// default branch (unmergedTip: origin/<default>, else the local one); else nothing
	// is deleted and the error names the commits that are not.
	Force bool
	// Remote also deletes origin's branch (`git push origin --delete <branch>`, leased
	// on the tip that was checked); a branch origin does not have is not an error.
	Remote bool
}

// DeleteBranchResult says what DeleteBranch deleted.
type DeleteBranchResult struct {
	Local, Remote bool
}

// DeleteBranch implements Store. The default branch is refused, and so (by git) is a
// branch a worktree has checked out. Neither a local nor (with Remote) an origin branch
// of that name is ErrNotFound. Without Force both tips are checked before anything is
// deleted (fuzz finding git 1: `git branch -d` alone passed a pushed branch, which is
// merged into its own upstream, and origin's copy was never checked at all).
func (g *Git) DeleteBranch(ctx context.Context, o DeleteBranchOptions) (DeleteBranchResult, error) {
	var res DeleteBranchResult
	st := g.project(o.ProjectID)
	if st == nil {
		return res, fmt.Errorf("%w: project %q", ErrNotFound, o.ProjectID)
	}
	m := st.meta.Load()
	if err := requireGit(m); err != nil {
		return res, err
	}
	if o.Branch == "" || strings.HasPrefix(o.Branch, "-") {
		return res, fmt.Errorf("%w: invalid branch name %q", ErrInvalidArgument, o.Branch)
	}
	if _, err := g.runner.Run(ctx, m.Path, "check-ref-format", "--branch", o.Branch); err != nil {
		return res, fmt.Errorf("%w: invalid branch name %q", ErrInvalidArgument, o.Branch)
	}
	if o.Branch == m.DefaultBranch {
		return res, fmt.Errorf("%w: %s is the default branch of %s", ErrInvalidArgument, o.Branch, m.Name)
	}
	localTip := g.revParse(ctx, m.Path, "refs/heads/"+o.Branch)
	remoteTip := ""
	if o.Remote {
		if _, err := g.runner.Run(ctx, m.Path, "remote", "get-url", "origin"); err != nil {
			return res, fmt.Errorf("%w: %s has no origin remote", ErrFailedPrecondition, m.Name)
		}
		if !o.Force {
			// Origin's copy may hold commits the remote-tracking ref has not seen:
			// read its tip now. A failed fetch keeps the ref we have; the push is
			// leased on it, so a copy that moved since is not deleted.
			err := g.fetchRemoteBranch(ctx, m, "origin", o.Branch)
			var ge *GitError
			if err != nil && errors.As(err, &ge) && strings.Contains(ge.Stderr, "couldn't find remote ref") {
				_, _ = g.runner.Run(ctx, m.Path, "update-ref", "-d", "refs/remotes/origin/"+o.Branch)
			}
			remoteTip = g.revParse(ctx, m.Path, "refs/remotes/origin/"+o.Branch)
			if err != nil && remoteTip == "" && (ge == nil || !strings.Contains(ge.Stderr, "couldn't find remote ref")) {
				return res, fmt.Errorf("%w: could not read origin's %s (--force deletes it unchecked): %w", ErrFailedPrecondition, o.Branch, err)
			}
		}
	}
	if !o.Force {
		for _, tip := range []struct{ label, sha string }{{"branch " + o.Branch, localTip}, {"origin's " + o.Branch, remoteTip}} {
			if tip.sha == "" {
				continue
			}
			if err := g.requireMerged(ctx, m, tip.label, tip.sha); err != nil {
				return res, err
			}
		}
	}
	if localTip != "" {
		// Checked above (or Force): -D, since -d would refuse a squash-merged branch
		// whose upstream is gone. git still refuses a branch a worktree has.
		if _, err := g.runner.Run(ctx, m.Path, "branch", "-D", o.Branch); err != nil {
			return res, fmt.Errorf("%w: %w", ErrFailedPrecondition, err)
		}
		res.Local = true
		g.log.Info("branch deleted", "project", m.ID, "branch", o.Branch, "force", o.Force)
	}
	if o.Remote && (o.Force || remoteTip != "") {
		pctx, cancel := context.WithTimeout(ctx, fetchTimeout)
		defer cancel()
		args := []string{"push", "origin", "--delete", o.Branch}
		if !o.Force {
			args = []string{"push", "--force-with-lease=refs/heads/" + o.Branch + ":" + remoteTip, "origin", "--delete", o.Branch}
		}
		_, err := g.runner.Run(pctx, m.Path, args...)
		var ge *GitError
		switch {
		case err == nil:
			res.Remote = true
			g.log.Info("branch deleted on origin", "project", m.ID, "branch", o.Branch)
		case errors.As(err, &ge) && strings.Contains(ge.Stderr, "remote ref does not exist"):
		case errors.As(err, &ge) && strings.Contains(ge.Stderr, "stale info"):
			return res, fmt.Errorf("%w: origin's %s moved while it was checked; nothing deleted there", ErrFailedPrecondition, o.Branch)
		default:
			return res, fmt.Errorf("%w: %w", ErrFailedPrecondition, err)
		}
	}
	if !res.Local && !res.Remote {
		where := "locally"
		if o.Remote {
			where = "locally or on origin"
		}
		return res, fmt.Errorf("%w: no branch %s in %s %s", ErrNotFound, o.Branch, m.Name, where)
	}
	return res, nil
}

// revParse is ref's commit, or "" when there is none.
func (g *Git) revParse(ctx context.Context, dir, ref string) string {
	out, err := g.runner.Run(ctx, dir, "rev-parse", "--verify", "--quiet", ref+"^{commit}")
	if err != nil {
		return ""
	}
	return string(trimNL(out))
}

// mergeBase is the ref a branch must be merged into before it is deleted without force:
// origin/<default>, else the local default branch, else "" (nothing to compare with).
func (g *Git) mergeBase(ctx context.Context, m *projectMeta) string {
	def := m.DefaultBranch
	if def == "" {
		_, err := g.runner.Run(ctx, m.Path, "remote", "get-url", "origin")
		def = g.defaultBranch(ctx, m.Path, "", err == nil)
	}
	for _, ref := range []string{"refs/remotes/origin/" + def, "refs/heads/" + def} {
		if g.refExists(ctx, m.Path, ref) {
			return ref
		}
	}
	return ""
}

// unmerged counts tip's commits that are not in base: 0 when tip is reachable from
// base or its changes landed there as a rebased or squash-merged copy
// (mergedByContent), the rule worktree cleanup uses.
func (g *Git) unmerged(ctx context.Context, dir, tip, base string) (int, error) {
	_, err := g.runner.Run(ctx, dir, "merge-base", "--is-ancestor", tip, base)
	switch {
	case err == nil:
		return 0, nil
	case !isExit(err, 1):
		return 0, err
	case g.mergedByContent(ctx, dir, tip, base):
		return 0, nil
	}
	out, err := g.runner.Run(ctx, dir, "rev-list", "--count", base+".."+tip)
	if err != nil {
		return 0, err
	}
	n, err := strconv.Atoi(string(trimNL(out)))
	if err != nil {
		return 0, fmt.Errorf("rev-list --count: %w", err)
	}
	return n, nil
}

// unmergedTip counts tip's commits not in the project's default branch (mergeBase,
// unmerged), and names that branch ("origin/main"). A tip compared with
// origin/<default> is counted once more after fetching that branch when it is not
// merged, so a branch just merged on GitHub is not refused for a stale ref. No default
// branch to compare with is an error.
func (g *Git) unmergedTip(ctx context.Context, m *projectMeta, tip string) (n int, base string, err error) {
	ref := g.mergeBase(ctx, m)
	if ref == "" {
		return 0, "", fmt.Errorf("%s has no default branch to compare with", m.Name)
	}
	base = shortRef(ref)
	n, err = g.unmerged(ctx, m.Path, tip, ref)
	if err == nil && n > 0 {
		if def, ok := strings.CutPrefix(ref, "refs/remotes/origin/"); ok && g.fetchRemoteBranch(ctx, m, "origin", def) == nil {
			n, err = g.unmerged(ctx, m.Path, tip, ref)
		}
	}
	if err != nil {
		return 0, base, fmt.Errorf("compare with %s: %w", base, err)
	}
	return n, base, nil
}

// requireMerged is nil when tip (what label names: "branch x", "origin's x") is in the
// project's default branch (unmergedTip), else a FailedPrecondition naming the commits
// that are not and pointing at --force.
func (g *Git) requireMerged(ctx context.Context, m *projectMeta, label, tip string) error {
	n, base, err := g.unmergedTip(ctx, m, tip)
	switch {
	case err != nil:
		return fmt.Errorf("%w: %s: %w; --force deletes it unchecked", ErrFailedPrecondition, label, err)
	case n > 0:
		return fmt.Errorf("%w: %s has %s not in %s; --force deletes it anyway", ErrFailedPrecondition, label, commits(n), base)
	}
	return nil
}

// commits is "1 commit" or "n commits".
func commits(n int) string {
	if n == 1 {
		return "1 commit"
	}
	return strconv.Itoa(n) + " commits"
}

// shortRef drops refs/remotes/ or refs/heads/ from ref.
func shortRef(ref string) string {
	if s, ok := strings.CutPrefix(ref, "refs/remotes/"); ok {
		return s
	}
	return strings.TrimPrefix(ref, "refs/heads/")
}
