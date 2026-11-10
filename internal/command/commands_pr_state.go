package command

import (
	"context"
	"fmt"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
)

// stateCommands are the pull request panel's direct state changes
// (docs/notes/pr-daemon-actions.md): pr.ready and pr.draft (GhService.SetPullRequestDraft),
// pr.auto-merge (GhService.SetPullRequestAutoMerge) and pr.checkbox
// (commands_pr_checkbox.go). The daemon refuses what the pull request's state rules out
// (not open, already so, auto-merge or the method disallowed) and relays GitHub's
// refusals; these only shape the request.
func stateCommands(b GhBackend, slug, number ArgSpec) []Command {
	return []Command{
		draftCommand(b, slug, number, false),
		draftCommand(b, slug, number, true),
		autoMergeCommand(b, slug, number),
		checkboxCommand(b, slug, number),
	}
}

// draftCommand is pr.ready (draft false) or pr.draft (draft true).
func draftCommand(b GhBackend, slug, number ArgSpec, draft bool) Command {
	c := Command{
		Name:        "pr.ready",
		Page:        PageState,
		NoPalette:   true,
		Title:       "Mark Pull Request Ready for Review",
		Description: "Mark a draft pull request ready for review (GitHub's Ready for review button).",
		Category:    "Pull Request",
		Args:        []ArgSpec{slug, number},
	}
	if draft {
		c.Name, c.Title = "pr.draft", "Convert Pull Request to Draft"
		c.Description = "Convert an open pull request to a draft; reviewers are not asked again until it is marked ready."
	}
	c.Run = func(ctx context.Context, _ Context, a Args) (Result, error) {
		if err := checkPullRequestArgs(a); err != nil {
			return Result{}, err
		}
		res, err := b.SetPullRequestDraft(ctx, connect.NewRequest(&v1.SetPullRequestDraftRequest{
			RepoSlug: a.String("repo-slug"), Number: int32(a.Int("number")), Draft: draft,
		}))
		if err != nil {
			return Result{}, err
		}
		return Result{Message: res.Msg.GetMessage(), JSON: res.Msg}, nil
	}
	return c
}

// autoMergeCommand is pr.auto-merge: --method turns GitHub's auto-merge on (confirmed:
// GitHub merges by itself once the requirements pass), --off turns it off.
func autoMergeCommand(b GhBackend, slug, number ArgSpec) Command {
	return Command{
		Name:        "pr.auto-merge",
		NoPalette:   true,
		Title:       "Auto-merge Pull Request",
		Description: "Turn on GitHub's auto-merge for an open pull request (--method: it merges by itself once its required checks and reviews pass; the repository must allow auto-merge), or turn it off (--off).",
		Category:    "Pull Request",
		Args: []ArgSpec{slug, number,
			{Name: "method", Type: Enum, Enum: []string{"merge", "squash", "rebase"}, Description: "How GitHub merges it once the requirements pass: a merge commit, squash, or rebase (required unless --off)"},
			{Name: "off", Type: Bool, Description: "Turn auto-merge off instead"},
			{Name: "head-sha", Type: String, Description: "Turn it on only if the head is still this commit (full SHA): refused when the pull request changed since you looked"},
		},
		Confirm: "Turn on auto-merge for #{number} in {repo-slug} with {method}?",
		// Only a request Run would send asks: a bad one is refused without a question.
		ConfirmIf: func(_ context.Context, _ Context, a Args) bool {
			_, ok := mergeMethods[a.String("method")]
			return ok && !a.Bool("off") && checkPullRequestArgs(a) == nil && checkHeadSHA(a) == nil
		},
		DynamicConfirm: func(_ context.Context, _ Context, a Args) string {
			words, ok := mergeMethodWords[a.String("method")]
			if !ok || checkPullRequestArgs(a) != nil {
				return ""
			}
			return fmt.Sprintf("Turn on auto-merge for #%d in %s? GitHub merges it with %s once its required checks and reviews pass.",
				a.Int("number"), a.String("repo-slug"), words)
		},
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			if err := checkPullRequestArgs(a); err != nil {
				return Result{}, err
			}
			req := &v1.SetPullRequestAutoMergeRequest{RepoSlug: a.String("repo-slug"), Number: int32(a.Int("number"))}
			switch m := a.String("method"); {
			case a.Bool("off") && (m != "" || strings.TrimSpace(a.String("head-sha")) != ""):
				return Result{}, InvalidArg("off", "--off takes no --method or --head-sha")
			case a.Bool("off"):
			case m == "":
				return Result{}, InvalidArg("method", "method is required to turn auto-merge on (merge, squash, or rebase), or --off to turn it off")
			default:
				method, ok := mergeMethods[m]
				if !ok {
					return Result{}, InvalidArg("method", "method must be merge, squash, or rebase")
				}
				if err := checkHeadSHA(a); err != nil {
					return Result{}, err
				}
				req.Enabled, req.Method, req.ExpectedHeadSha = true, method, a.String("head-sha")
			}
			res, err := b.SetPullRequestAutoMerge(ctx, connect.NewRequest(req))
			if err != nil {
				return Result{}, err
			}
			return Result{Message: res.Msg.GetMessage(), JSON: res.Msg}, nil
		},
	}
}

// checkHeadSHA refuses a --head-sha that is not a full commit SHA, as the daemon does
// (gh.IsCommitSHA), so a request it would refuse is neither confirmed nor sent.
func checkHeadSHA(a Args) error {
	if sha := a.String("head-sha"); sha != "" && !gh.IsCommitSHA(sha) {
		return InvalidArg("head-sha", "head-sha must be a full commit SHA")
	}
	return nil
}
