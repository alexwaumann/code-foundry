package command

import (
	"context"
	"fmt"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// EmitResult is the JSON result of every command that sends the app windows an intent
// (the ui.* and view.* commands, thread.focus, theme.pick, ...).
type EmitResult struct {
	// Windows is the number of app windows connected when the intent went out: the ones
	// it can show something in. 0: nobody saw anything.
	Windows int `json:"windows"`
	// Receivers is how many streams received the intent: windows, but also CLI events
	// streams (several of them share one subscription) and plugins. Not a window count.
	Receivers int `json:"receivers"`
}

// NoWindowMessage is what a command that shows something in the app says when no app
// window is open (exit 0: there was nothing wrong with the call).
const NoWindowMessage = "no app window is open: nothing was shown"

// EmitTo sends intent through e and reports the windows and receivers.
func EmitTo(e Emitter, intent *v1.UiIntent) EmitResult {
	n := e.Emit(intent)
	return EmitResult{Windows: e.Windows(), Receivers: n}
}

// Message is the text result: "windows=N", or NoWindowMessage with none.
func (r EmitResult) Message() string {
	if r.Windows == 0 {
		return NoWindowMessage
	}
	return fmt.Sprintf("windows=%d", r.Windows)
}

// Result is r as a command result with its Message.
func (r EmitResult) Result() Result { return Result{Message: r.Message(), JSON: r} }

// CLIResult is r as a command result, with its Message only from the CLI (ActiveView
// empty): the GUI toasts non-empty messages, and there the change on screen is the
// feedback.
func (r EmitResult) CLIResult(uctx Context) Result {
	if uctx.ActiveView != "" {
		return Result{JSON: r}
	}
	return r.Result()
}

var notifyLevels = map[string]v1.UiIntent_Notify_Level{
	"info":    v1.UiIntent_Notify_LEVEL_INFO,
	"warning": v1.UiIntent_Notify_LEVEL_WARNING,
	"error":   v1.UiIntent_Notify_LEVEL_ERROR,
}

// RegisterUI registers the ui.* commands, which steer connected GUIs through e. They
// need no store and are always available; with no app window open they say so.
func RegisterUI(r *Registry, e Emitter) error {
	emit := func(intent *v1.UiIntent) Result { return EmitTo(e, intent).Result() }
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
