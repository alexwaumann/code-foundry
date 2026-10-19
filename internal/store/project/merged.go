package project

import (
	"bytes"
	"context"
)

// mergedByContent reports whether head's changes are already in base although head is
// not an ancestor of it: merging head into base (`git merge-tree --write-tree`, which
// neither touches a checkout nor moves a ref) is clean and gives base's own tree. That
// is the state of a branch whose rebased copy was merged (a "rebase and merge", or an
// orchestrator that rebased a copy and merged that) or that was squash-merged, also
// after later merges, as long as those did not rewrite the same lines again. A branch
// whose copy was changed while landing (a resolved conflict) is not recognised. Any git
// failure is "not merged". An old git without `merge-tree --write-tree` (before 2.38)
// falls back to comparing the two trees. Called by the status job (base.go), memoized
// by (head, base).
func (g *Git) mergedByContent(ctx context.Context, dir, head, base string) bool {
	baseTree, err := g.runner.Run(ctx, dir, "rev-parse", "--verify", "--quiet", base+"^{tree}")
	if err != nil {
		return false
	}
	out, err := g.runner.Run(ctx, dir, "merge-tree", "--write-tree", "--no-messages", base, head)
	switch {
	case err == nil:
		tree, _, _ := bytes.Cut(out, []byte("\n"))
		return len(tree) > 0 && bytes.Equal(tree, trimNL(baseTree))
	case isExit(err, 1) || ctx.Err() != nil:
		return false // conflicts
	}
	_, err = g.runner.Run(ctx, dir, "diff", "--quiet", base, head)
	return err == nil
}
