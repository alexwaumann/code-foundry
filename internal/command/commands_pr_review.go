package command

import (
	"context"
	"fmt"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// reviewVerdicts maps pr.review's verdict arg to GhService's event, and says what
// happened ("Approved #N").
var reviewVerdicts = map[string]struct {
	event v1.PullRequestReviewEvent
	done  string
}{
	"approve":         {v1.PullRequestReviewEvent_PULL_REQUEST_REVIEW_EVENT_APPROVE, "Approved #%d"},
	"request-changes": {v1.PullRequestReviewEvent_PULL_REQUEST_REVIEW_EVENT_REQUEST_CHANGES, "Requested changes on #%d"},
	"comment":         {v1.PullRequestReviewEvent_PULL_REQUEST_REVIEW_EVENT_COMMENT, "Commented on #%d (review)"},
}

// reviewCommands are pr.review (GhService.SubmitPullRequestReview) and pr.comment
// (GhService.AddPullRequestComment). Neither asks for confirmation. Who may review is
// GitHub's call: the daemon relays its refusal (FAILED_PRECONDITION with GitHub's
// message), so the commands do not check authorship.
func reviewCommands(b GhBackend, slug, number ArgSpec) []Command {
	return []Command{
		{
			Name:        "pr.review",
			Title:       "Review Pull Request",
			Description: "Submit a review on a pull request: approve, request changes, or comment (a body is required for the last two).",
			Category:    "Pull Request",
			Args: []ArgSpec{slug, number,
				{Name: "verdict", Type: Enum, Enum: []string{"approve", "request-changes", "comment"}, Required: true,
					Description: "The review: approve, request-changes, or comment"},
				{Name: "body", Type: String, Positional: true,
					Description: "The review's text (Markdown); required for request-changes and comment"},
			},
			When: hasPullRequest,
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				if err := checkPullRequestArgs(a); err != nil {
					return Result{}, err
				}
				v, ok := reviewVerdicts[a.String("verdict")]
				if !ok {
					return Result{}, InvalidArg("verdict", "verdict must be approve, request-changes, or comment")
				}
				body := strings.TrimSpace(a.String("body"))
				if body == "" && v.event != v1.PullRequestReviewEvent_PULL_REQUEST_REVIEW_EVENT_APPROVE {
					return Result{}, InvalidArg("body", "body is required to %s", strings.ReplaceAll(a.String("verdict"), "-", " "))
				}
				n := a.Int("number")
				res, err := b.SubmitPullRequestReview(ctx, connect.NewRequest(&v1.SubmitPullRequestReviewRequest{
					RepoSlug: a.String("repo-slug"), Number: int32(n), Event: v.event, Body: body,
				}))
				if err != nil {
					return Result{}, err
				}
				return Result{Message: fmt.Sprintf(v.done, n), JSON: res.Msg}, nil
			},
		},
		{
			Name:        "pr.comment",
			Title:       "Comment on Pull Request",
			Description: "Post a comment on a pull request's conversation (not a review).",
			Category:    "Pull Request",
			Args: []ArgSpec{slug, number,
				{Name: "body", Type: String, Required: true, Positional: true, Description: "The comment's text (Markdown)"},
			},
			When: hasPullRequest,
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				if err := checkPullRequestArgs(a); err != nil {
					return Result{}, err
				}
				body := strings.TrimSpace(a.String("body"))
				if body == "" {
					return Result{}, InvalidArg("body", "body is required")
				}
				n := a.Int("number")
				res, err := b.AddPullRequestComment(ctx, connect.NewRequest(&v1.AddPullRequestCommentRequest{
					RepoSlug: a.String("repo-slug"), Number: int32(n), Body: body,
				}))
				if err != nil {
					return Result{}, err
				}
				return Result{Message: fmt.Sprintf("Commented on #%d", n), JSON: res.Msg}, nil
			},
		},
	}
}
