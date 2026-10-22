package plugin

import (
	"encoding/json"
	"errors"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// askUser handles host/invoke with confirm "ask" of a command that asks the user first:
// it hands the command to the GUI as UiIntent.InvokeCommand (the GUI runs it through its
// own confirm dialog, with the daemon's text) and answers the plugin at once. It does
// nothing (false) for any other error, without confirm "ask", or with no GUI watching.
// The plugin never confirms on the user's behalf; it learns the outcome from events.
func (a *actor) askUser(err error, p pluginsdk.InvokeParams) (pluginsdk.CommandResult, bool) {
	var ce *command.ConfirmError
	if p.Confirm != pluginsdk.ConfirmAsk || !errors.As(err, &ce) || a.m.opts.Emitter == nil {
		return pluginsdk.CommandResult{}, false
	}
	// Only a window can show the dialog: a CLI events stream or a plugin receives the
	// intent too, so the emit's count says nothing about windows (control-5-fixes).
	windows := a.m.opts.Emitter.Windows()
	if windows == 0 {
		a.hostLog("host/invoke %s: asks the user first and no app window is open", p.Command)
		return pluginsdk.CommandResult{}, false
	}
	n := a.m.opts.Emitter.Emit(&v1.UiIntent{Intent: &v1.UiIntent_InvokeCommand_{InvokeCommand: &v1.UiIntent_InvokeCommand{
		Name: p.Command, Args: p.Args, Caller: "plugin:" + a.name,
		Context: &v1.UiContext{
			ActiveThreadId: p.Context.ThreadID, ActiveProjectId: p.Context.ProjectID, ActiveWorktreePath: p.Context.WorktreePath,
			ActiveTerminalId: p.Context.TerminalID, ActiveWorkspaceId: p.Context.WorkspaceID, ActiveView: p.Context.View,
		},
	}}})
	a.hostLog("host/invoke %s: handed to the GUI to confirm (%d window(s))", p.Command, windows)
	js, _ := json.Marshal(pluginsdk.AskedResult{Asked: true, Windows: windows, Receivers: n, Delivered: n})
	return pluginsdk.CommandResult{Message: "asked the user to confirm " + p.Command, JSON: js}, true
}
