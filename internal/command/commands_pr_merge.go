package command

import (
	"context"
	"fmt"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// mergeMethods maps pr.merge's method arg to GhService's enum, and mergeMethodWords
// says it the way the confirmation does ("with squash").
var (
	mergeMethods = map[string]v1.PullRequestMergeMethod{
		"merge":  v1.PullRequestMergeMethod_PULL_REQUEST_MERGE_METHOD_MERGE,
		"squash": v1.PullRequestMergeMethod_PULL_REQUEST_MERGE_METHOD_SQUASH,
		"rebase": v1.PullRequestMergeMethod_PULL_REQUEST_MERGE_METHOD_REBASE,
	}
	mergeMethodWords = map[string]string{"merge": "a merge commit", "squash": "squash", "rebase": "rebase"}
)

// mergeCommand is pr.merge: GhService.MergePullRequest, confirmed. The confirmation
// names the base branch, read from the daemon's cached detail, and, without --head-sha,
// the commits that will merge (the daemon merges the head it has then).
func mergeCommand(b GhBackend, slug, number ArgSpec) Command {
	return Command{
		Name:        "pr.merge",
		Title:       "Merge Pull Request",
		Description: "Merge an open pull request with a merge commit, squash, or rebase (GitHub's merge button); --delete-branch deletes its branch on GitHub afterwards (never local branches or worktrees).",
		Category:    "Pull Request",
		Args: []ArgSpec{slug, number,
			{Name: "method", Type: Enum, Enum: []string{"merge", "squash", "rebase"}, Required: true, Description: "How to merge: a merge commit, squash, or rebase"},
			{Name: "delete-branch", Type: Bool, Description: "Delete the head branch on GitHub (origin) after the merge; never a fork's, the default or the base branch, nor local branches or worktrees"},
			{Name: "head-sha", Type: String, Description: "Merge only if the head is still this commit (full SHA): refused when the pull request changed since you looked"},
		},
		When:    hasPullRequest,
		Confirm: "Merge #{number} with {method}?",
		DynamicConfirm: func(ctx context.Context, _ Context, a Args) string {
			return mergeConfirm(ctx, b, a)
		},
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			if err := checkPullRequestArgs(a); err != nil {
				return Result{}, err
			}
			method, ok := mergeMethods[a.String("method")]
			if !ok {
				return Result{}, InvalidArg("method", "method must be merge, squash, or rebase")
			}
			n := a.Int("number")
			res, err := b.MergePullRequest(ctx, connect.NewRequest(&v1.MergePullRequestRequest{
				RepoSlug: a.String("repo-slug"), Number: int32(n), Method: method, DeleteBranch: a.Bool("delete-branch"),
				ExpectedHeadSha: a.String("head-sha"),
			}))
			if err != nil {
				return Result{}, err
			}
			msg := res.Msg.GetMessage()
			if msg == "" {
				msg = fmt.Sprintf("Merged #%d", n)
				if sha := res.Msg.GetSha(); sha != "" {
					msg += fmt.Sprintf(" (%s)", sha[:min(7, len(sha))])
				}
			}
			return Result{Message: msg, JSON: res.Msg}, nil
		},
	}
}

// mergeConfirm is "Merge #N into <base> with <method>?", plus the branch it deletes.
// Without head-sha it also names what merges ("#N (3 commits, head e2e0142)"): the
// daemon merges its head at the time, and this is the user's look at it. Empty (the
// static Confirm instead) when the args are bad or the detail cannot be read.
func mergeConfirm(ctx context.Context, b GhBackend, a Args) string {
	words, ok := mergeMethodWords[a.String("method")]
	if !ok || checkPullRequestArgs(a) != nil {
		return ""
	}
	n := a.Int("number")
	res, err := b.GetPullRequestDetail(ctx, connect.NewRequest(&v1.GetPullRequestDetailRequest{
		RepoSlug: a.String("repo-slug"), Number: int32(n),
	}))
	if err != nil {
		return ""
	}
	d := res.Msg.GetDetail()
	pr := d.GetPullRequest()
	if pr.GetBaseRef() == "" {
		return ""
	}
	what := fmt.Sprintf("#%d", n)
	if sha := pr.GetHeadSha(); a.String("head-sha") == "" && sha != "" {
		commits := "1 commit"
		if c := d.GetCommitCount(); c != 1 {
			commits = fmt.Sprintf("%d commits", c)
		}
		what += fmt.Sprintf(" (%s, head %s)", commits, sha[:min(7, len(sha))])
	}
	msg := fmt.Sprintf("Merge %s into %s with %s?", what, pr.GetBaseRef(), words)
	if a.Bool("delete-branch") && deletableBranch(d) {
		msg += fmt.Sprintf(" Branch origin/%s is deleted afterwards.", pr.GetHeadRef())
	}
	return msg
}

// deletableBranch reports whether a merge would delete d's head branch when asked: not
// a fork's, not the default branch (when known), not the base branch.
func deletableBranch(d *v1.PullRequestDetail) bool {
	pr := d.GetPullRequest()
	head := pr.GetHeadRef()
	return head != "" && !pr.GetIsCrossRepository() && head != d.GetDefaultBranch() && head != pr.GetBaseRef()
}
