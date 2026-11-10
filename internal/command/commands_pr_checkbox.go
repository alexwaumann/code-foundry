package command

import (
	"context"
	"math"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// checkboxCommand is pr.checkbox: ticks or unticks one task-list item of a pull
// request's description (GhService.SetPullRequestCheckbox). The panel's boxes run it. It
// names the item by its place and its text as shown; the daemon checks both against
// GitHub's copy before it changes anything, so no confirmation is asked.
func checkboxCommand(b GhBackend, slug, number ArgSpec) Command {
	return Command{
		Name:        "pr.checkbox",
		NoPalette:   true,
		Title:       "Set Pull Request Task",
		Description: "Tick or untick one task-list item of a pull request's description, as on GitHub. Refused if the item moved or changed since it was read.",
		Category:    "Pull Request",
		Args: []ArgSpec{slug, number,
			{Name: "index", Type: Int, Required: true, Description: "Which task-list item, counted from 0 in the order they are written (nested ones too)"},
			{Name: "checked", Type: Bool, Required: true, Description: "Tick it (--checked=false: untick it)"},
			{Name: "text", Type: String, Description: "The item's text as shown: its source line after the box. Refused unless it still reads the same"},
		},
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			if err := checkPullRequestArgs(a); err != nil {
				return Result{}, err
			}
			index := a.Int("index")
			if index < 0 || index > math.MaxInt32 {
				return Result{}, InvalidArg("index", "index must be 0 or more")
			}
			res, err := b.SetPullRequestCheckbox(ctx, connect.NewRequest(&v1.SetPullRequestCheckboxRequest{
				RepoSlug: a.String("repo-slug"), Number: int32(a.Int("number")),
				Index: int32(index), Text: a.String("text"), Checked: a.Bool("checked"),
			}))
			if err != nil {
				return Result{}, err
			}
			return Result{Message: res.Msg.GetMessage(), JSON: res.Msg}, nil
		},
	}
}
