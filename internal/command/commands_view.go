package command

import (
	"context"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// ViewPullRequests is the ShowView name of the Pull Requests page.
const ViewPullRequests = "pullrequests"

// ViewPanelToggle is the ShowView name that toggles the side panel of whatever the
// window has selected. It is an action, not a page: the GUI toggles its per-selection
// panel state (gui/frontend/src/stores/panel.ts) and stays on the current selection.
const ViewPanelToggle = "panel.toggle"

// RegisterView registers view.pullrequests, which shows the Pull Requests page, and
// view.panel.toggle, which shows or hides the side panel (both emitted as
// UiIntent.ShowView). Links open through view.open.url (RegisterGitOps).
func RegisterView(r *Registry, e Emitter) error {
	show := func(name string) Result {
		n := e.Emit(&v1.UiIntent{Intent: &v1.UiIntent_ShowView_{ShowView: &v1.UiIntent_ShowView{Name: name}}})
		// No Message: the GUI toasts non-empty messages, and the view change is
		// feedback enough. The CLI's --json still reports delivery.
		return Result{JSON: EmitResult{Delivered: n}}
	}
	return r.RegisterAll(
		Command{
			Name:        "view.pullrequests",
			Title:       "Show Pull Requests",
			Description: "Show the Pull Requests page: your open pull requests, reviews requested from you, and recent merges across registered repositories.",
			Category:    "View",
			Keybindings: []string{"cmd+shift+d"},
			Run: func(context.Context, Context, Args) (Result, error) {
				return show(ViewPullRequests), nil
			},
		},
		Command{
			Name:        "view.panel.toggle",
			Title:       "Toggle Side Panel",
			Description: "Show or hide the side panel next to the selected session, terminal, worktree, or page.",
			Category:    "View",
			Keybindings: []string{"cmd+shift+e"},
			Run: func(context.Context, Context, Args) (Result, error) {
				return show(ViewPanelToggle), nil
			},
		},
	)
}
