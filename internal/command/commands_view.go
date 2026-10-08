package command

import (
	"context"

	v1 "github.com/awaumann/code-foundry/gen/go/codefoundry/v1"
)

// ViewPullRequests is the ShowView name of the Pull Requests page.
const ViewPullRequests = "pullrequests"

// RegisterView registers view.pullrequests, which shows the Pull Requests page
// (emitted as UiIntent.ShowView). Links open through view.open.url (RegisterGitOps).
func RegisterView(r *Registry, e Emitter) error {
	return r.RegisterAll(
		Command{
			Name:        "view.pullrequests",
			Title:       "Show Pull Requests",
			Description: "Show the Pull Requests page: your open pull requests, reviews requested from you, and recent merges across registered repositories.",
			Category:    "View",
			Keybindings: []string{"cmd+shift+d"},
			Run: func(context.Context, Context, Args) (Result, error) {
				n := e.Emit(&v1.UiIntent{Intent: &v1.UiIntent_ShowView_{ShowView: &v1.UiIntent_ShowView{Name: ViewPullRequests}}})
				// No Message: the GUI toasts non-empty messages, and the page switch is
				// feedback enough. The CLI's --json still reports delivery.
				return Result{JSON: EmitResult{Delivered: n}}, nil
			},
		},
	)
}
