package command

import (
	"context"
	"fmt"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// PullRequestLinkBackend backs thread.pr.link.
type PullRequestLinkBackend interface {
	LinkPullRequest(context.Context, *connect.Request[v1.LinkThreadPullRequestRequest]) (*connect.Response[v1.LinkThreadPullRequestResponse], error)
}

// threadPRLink is thread.pr.link: a pull request linked to a thread by hand, like the
// ones Claude and the daemon link (docs/notes/pr-daemon-actions.md). There is no unlink.
func threadPRLink(b ThreadBackend, idArg ArgSpec) Command {
	return Command{
		Name:        "thread.pr.link",
		NoPalette:   true,
		Title:       "Link Pull Request to Thread",
		Description: "Link a GitHub pull request to a thread by hand, like Claude's links (never removed).",
		Category:    "Thread",
		Args: []ArgSpec{
			idArg,
			{Name: "pr", Type: String, Required: true, Positional: true, Description: "The pull request: its GitHub URL or owner/name#123"},
		},
		When: hasThread,
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			res, err := b.LinkPullRequest(ctx, connect.NewRequest(&v1.LinkThreadPullRequestRequest{Id: a.String("id"), PullRequest: a.String("pr")}))
			if err != nil {
				return Result{}, err
			}
			l, s := res.Msg.GetLink(), res.Msg.GetThread()
			msg := fmt.Sprintf("linked %s#%d to thread %s", l.GetSlug(), l.GetNumber(), threadLabel(s))
			if !res.Msg.GetLinked() {
				msg = fmt.Sprintf("thread %s already has %s#%d linked", threadLabel(s), l.GetSlug(), l.GetNumber())
			}
			return Result{Message: msg, JSON: res.Msg}, nil
		},
	}
}
