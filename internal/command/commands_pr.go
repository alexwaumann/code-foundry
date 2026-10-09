package command

import (
	"context"
	"fmt"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
)

// GhBackend is the slice of GhService the pull request detail panel's commands need
// (pr.revert, pr.merge, pr.review.request, pr.refresh), in generated Connect signatures (see
// TerminalBackend). Reads the panel shows (GetPullRequestDetail without refresh,
// ListReviewerCandidates) stay RPCs.
type GhBackend interface {
	GetPullRequestDetail(context.Context, *connect.Request[v1.GetPullRequestDetailRequest]) (*connect.Response[v1.GetPullRequestDetailResponse], error)
	SetReviewRequest(context.Context, *connect.Request[v1.SetReviewRequestRequest]) (*connect.Response[v1.SetReviewRequestResponse], error)
	RevertPullRequest(context.Context, *connect.Request[v1.RevertPullRequestRequest]) (*connect.Response[v1.RevertPullRequestResponse], error)
	MergePullRequest(context.Context, *connect.Request[v1.MergePullRequestRequest]) (*connect.Response[v1.MergePullRequestResponse], error)
}

var (
	_ GhBackend = codefoundryv1connect.GhServiceHandler(nil)
	_ GhBackend = codefoundryv1connect.GhServiceClient(nil)
)

// hasPullRequest is the pull request commands' When: the pull request is named by its
// args (the GUI's detail panel passes them, the CLI takes them as flags or words), so
// it holds in any context once they are given. Without them Invoke fails with
// ErrInvalidArgs, not ErrUnavailable.
func hasPullRequest(Context) bool { return true }

// RegisterPullRequest registers pr.revert, pr.merge (commands_pr_merge.go),
// pr.review.request, and pr.refresh: the pull request detail panel's actions. b nil registers them against
// UnimplementedGhServiceHandler.
func RegisterPullRequest(r *Registry, b GhBackend) error {
	if b == nil {
		b = codefoundryv1connect.UnimplementedGhServiceHandler{}
	}
	slug := ArgSpec{Name: "repo-slug", Type: String, Required: true, Positional: true, Description: `GitHub repository, "owner/name"`}
	number := ArgSpec{Name: "number", Type: Int, Required: true, Positional: true, Description: "Pull request number"}
	return r.RegisterAll(
		mergeCommand(b, slug, number),
		Command{
			Name:        "pr.revert",
			Title:       "Revert Pull Request",
			Description: "Open a pull request that reverses a merged one (GitHub's Revert button).",
			Category:    "Pull Request",
			Args:        []ArgSpec{slug, number},
			When:        hasPullRequest,
			Confirm:     "This opens a new pull request that reverses the changes merged by #{number}.",
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				if err := checkPullRequestArgs(a); err != nil {
					return Result{}, err
				}
				res, err := b.RevertPullRequest(ctx, connect.NewRequest(&v1.RevertPullRequestRequest{
					RepoSlug: a.String("repo-slug"), Number: int32(a.Int("number")),
				}))
				if err != nil {
					return Result{}, err
				}
				return Result{
					Message: fmt.Sprintf("Opened #%d to revert #%d: %s", res.Msg.GetNumber(), a.Int("number"), res.Msg.GetUrl()),
					JSON:    res.Msg,
				}, nil
			},
		},
		Command{
			Name:        "pr.review.request",
			Title:       "Request Review",
			Description: "Request a review on a pull request from a user or team, or withdraw the request (--requested=false).",
			Category:    "Pull Request",
			Args: []ArgSpec{slug, number,
				{Name: "login", Type: String, Required: true, Positional: true, Description: `User login, or a team as "org/team" (or its slug)`},
				{Name: "kind", Type: Enum, Enum: []string{"user", "team"}, Default: "user", Description: "Whether login is a user or a team"},
				{Name: "requested", Type: Bool, Default: "true", Description: "Request the review (false withdraws the request)"},
			},
			When: hasPullRequest,
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				if err := checkPullRequestArgs(a); err != nil {
					return Result{}, err
				}
				login := strings.TrimSpace(a.String("login"))
				if login == "" {
					return Result{}, InvalidArg("login", "login is required")
				}
				kind := v1.ReviewerKind_REVIEWER_KIND_USER
				if a.String("kind") == "team" {
					kind = v1.ReviewerKind_REVIEWER_KIND_TEAM
				}
				n, requested := a.Int("number"), a.Bool("requested")
				res, err := b.SetReviewRequest(ctx, connect.NewRequest(&v1.SetReviewRequestRequest{
					RepoSlug: a.String("repo-slug"), Number: int32(n), Login: login, Kind: kind, Requested: requested,
				}))
				if err != nil {
					return Result{}, err
				}
				msg := fmt.Sprintf("Requested a review from %s on #%d", login, n)
				if !requested {
					msg = fmt.Sprintf("Withdrew the review request for %s on #%d", login, n)
				}
				return Result{Message: msg, JSON: res.Msg}, nil
			},
		},
		Command{
			Name:        "pr.refresh",
			Title:       "Refresh Pull Request",
			Description: "Fetch a pull request's detail from GitHub now instead of from the daemon's cache.",
			Category:    "Pull Request",
			Args:        []ArgSpec{slug, number},
			When:        hasPullRequest,
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				if err := checkPullRequestArgs(a); err != nil {
					return Result{}, err
				}
				n := a.Int("number")
				res, err := b.GetPullRequestDetail(ctx, connect.NewRequest(&v1.GetPullRequestDetailRequest{
					RepoSlug: a.String("repo-slug"), Number: int32(n), Refresh: true,
				}))
				if err != nil {
					return Result{}, err
				}
				d := res.Msg.GetDetail()
				if e := d.GetLastError(); e != "" {
					// The daemon answered with its cached copy: the refresh itself failed.
					return Result{}, connect.NewError(connect.CodeUnavailable,
						fmt.Errorf("refresh #%d failed, the cached copy is unchanged: %s", n, e))
				}
				return Result{Message: fmt.Sprintf("Refreshed #%d: %s", n, d.GetPullRequest().GetTitle()), JSON: d}, nil
			},
		},
	)
}

// checkPullRequestArgs rejects a non-positive number before it reaches the daemon (the
// slug is validated there, with the store's rules).
func checkPullRequestArgs(a Args) error {
	if a.Int("number") <= 0 {
		return InvalidArg("number", "number must be a positive pull request number")
	}
	if strings.TrimSpace(a.String("repo-slug")) == "" {
		return InvalidArg("repo-slug", "repo-slug is required")
	}
	return nil
}
