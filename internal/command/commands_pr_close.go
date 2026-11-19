package command

import (
	"context"
	"fmt"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// closeCommand is pr.close (closed true: confirmed, naming the pull request) or
// pr.reopen (GhService.SetPullRequestClosed, docs/notes/pr-close-reopen.md). The daemon
// refuses closing what is not open, reopening what is open or merged, and a viewer
// GitHub does not let do it; these only shape the request.
func closeCommand(b GhBackend, slug, number ArgSpec, closed bool) Command {
	c := Command{
		Name:        "pr.reopen",
		Page:        PageState,
		NoPalette:   true,
		Title:       "Reopen Pull Request",
		Description: "Reopen a closed pull request that was not merged (GitHub's Reopen pull request button).",
		Category:    "Pull Request",
		Args:        []ArgSpec{slug, number},
	}
	if closed {
		c.Name, c.Title = "pr.close", "Close Pull Request"
		c.Description = "Close an open pull request without merging it (GitHub's Close pull request button); pr.reopen reopens it."
		c.Confirm = "Close #{number} in {repo-slug} without merging it?"
		c.ConfirmLabel = "Close pull request"
		// A request Run would refuse for its args is refused without a question.
		c.ConfirmIf = func(_ context.Context, _ Context, a Args) bool { return checkPullRequestArgs(a) == nil }
		c.DynamicConfirm = func(ctx context.Context, _ Context, a Args) string { return closeConfirm(ctx, b, a) }
	}
	c.Run = func(ctx context.Context, _ Context, a Args) (Result, error) {
		if err := checkPullRequestArgs(a); err != nil {
			return Result{}, err
		}
		res, err := b.SetPullRequestClosed(ctx, connect.NewRequest(&v1.SetPullRequestClosedRequest{
			RepoSlug: a.String("repo-slug"), Number: int32(a.Int("number")), Closed: closed,
		}))
		if err != nil {
			return Result{}, err
		}
		return Result{Message: res.Msg.GetMessage(), JSON: res.Msg}, nil
	}
	return c
}

// closeConfirm is "Close #N “<title>” in <owner/name> without merging it? It can be
// reopened later.", the title read from the daemon's cached detail (it only names the
// pull request; the daemon checks the state when it runs). Empty (the static Confirm
// instead) when the args are bad or the detail cannot be read.
func closeConfirm(ctx context.Context, b GhBackend, a Args) string {
	if checkPullRequestArgs(a) != nil {
		return ""
	}
	n := a.Int("number")
	res, err := b.GetPullRequestDetail(ctx, connect.NewRequest(&v1.GetPullRequestDetailRequest{
		RepoSlug: a.String("repo-slug"), Number: int32(n),
	}))
	if err != nil {
		return ""
	}
	what := fmt.Sprintf("#%d", n)
	if t := strings.TrimSpace(res.Msg.GetDetail().GetPullRequest().GetTitle()); t != "" {
		what += " “" + truncateRunes(t, mergeTitleMax) + "”"
	}
	return fmt.Sprintf("Close %s in %s without merging it? It can be reopened later.", what, a.String("repo-slug"))
}
