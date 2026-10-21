package command

import (
	"context"
	"fmt"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// EmitResult is the JSON result of every ui.* command.
type EmitResult struct {
	Delivered int `json:"delivered"`
}

var notifyLevels = map[string]v1.UiIntent_Notify_Level{
	"info":    v1.UiIntent_Notify_LEVEL_INFO,
	"warning": v1.UiIntent_Notify_LEVEL_WARNING,
	"error":   v1.UiIntent_Notify_LEVEL_ERROR,
}

// RegisterUI registers the ui.* commands, which steer connected GUIs through e. They
// need no store and are always available; with no GUI watching they deliver to zero.
func RegisterUI(r *Registry, e Emitter) error {
	emit := func(intent *v1.UiIntent) Result {
		n := e.Emit(intent)
		return Result{Message: fmt.Sprintf("delivered=%d", n), JSON: EmitResult{Delivered: n}}
	}
	return r.RegisterAll(
		Command{
			Name:         "ui.palette.open",
			Title:        "Open Command Palette",
			Description:  "Open the command palette in every connected window.",
			Category:     "View",
			NoKeybinding: true,
			// No keybinding: in the GUI, cmd+k is a reserved view action that opens the
			// palette locally (gui/frontend/src/keys/bindings.ts).
			Args: []ArgSpec{
				{Name: "query", Type: String, Description: "Text to pre-fill"},
			},
			Run: func(_ context.Context, _ Context, a Args) (Result, error) {
				return emit(&v1.UiIntent{Intent: &v1.UiIntent_OpenPalette_{
					OpenPalette: &v1.UiIntent_OpenPalette{Query: a.String("query")},
				}}), nil
			},
		},
		Command{
			Name:         "ui.notify",
			Title:        "Show Notification",
			Description:  "Show a notification in every connected window.",
			Category:     "View",
			NoKeybinding: true,
			Args: []ArgSpec{
				{Name: "title", Type: String, Required: true, Description: "Notification title"},
				{Name: "body", Type: String, Description: "Notification body"},
				{Name: "level", Type: Enum, Enum: []string{"info", "warning", "error"}, Default: "info", Description: "Severity"},
			},
			Run: func(_ context.Context, _ Context, a Args) (Result, error) {
				return emit(&v1.UiIntent{Intent: &v1.UiIntent_Notify_{Notify: &v1.UiIntent_Notify{
					Level: notifyLevels[a.String("level")],
					Title: a.String("title"),
					Body:  a.String("body"),
				}}}), nil
			},
		},
		Command{
			Name:         "ui.focus.terminal",
			Title:        "Focus Terminal",
			Description:  "Show a terminal in every connected window.",
			Category:     "View",
			NoKeybinding: true,
			Args: []ArgSpec{
				{Name: "id", Type: String, Required: true, Context: ContextTerminal, ID: TerminalID, Description: "Terminal id" + IDHelp},
			},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				if err := r.known(ctx, TerminalID, a.String("id")); err != nil {
					return Result{}, err
				}
				return emit(&v1.UiIntent{Intent: &v1.UiIntent_FocusTerminal_{
					FocusTerminal: &v1.UiIntent_FocusTerminal{TerminalId: a.String("id")},
				}}), nil
			},
		},
		Command{
			Name:         "ui.focus.project",
			Title:        "Focus Project",
			Description:  "Show a project's worktree (default: its main one) in the Projects page's side panel in every connected window.",
			Category:     "View",
			NoKeybinding: true,
			Args: []ArgSpec{
				{Name: "project", Type: String, Required: true, Context: ContextProject, ID: ProjectID, Description: ProjectRefHelp},
				{Name: "worktree", Type: Path, Context: ContextWorktree, Description: "Worktree path"},
			},
			Run: func(_ context.Context, _ Context, a Args) (Result, error) {
				return emit(&v1.UiIntent{Intent: &v1.UiIntent_FocusProject_{FocusProject: &v1.UiIntent_FocusProject{
					ProjectId:    a.String("project"),
					WorktreePath: a.Path("worktree"),
				}}}), nil
			},
		},
	)
}
