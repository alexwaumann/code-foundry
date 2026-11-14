package command

import "context"

// ViewPaneFullscreen is the ShowView name of pane.fullscreen: the shell window shows one pane
// over its whole pane area (the top bar and the sidebar stay), or every pane again
// (docs/notes/shell-model.md, "Full screen"; docs/notes/shell-19-rails-fullscreen.md). Window
// state, like view.thread-info: nothing in the layout changes, and each window keeps its own.
// Params: "mode" is "on", "off" or "toggle"; "pane", when given, is the pane to show (the
// window focuses it first).
const ViewPaneFullscreen = "pane.fullscreen"

// paneFullscreenCommand is pane.fullscreen. The GUI presents it in the window (keys/bindings.ts:
// the focused pane, toggled); the CLI's reaches every window through ShowView.
func (d ViewDeps) paneFullscreenCommand() Command {
	return Command{
		Name:  "pane.fullscreen",
		Page:  PageState,
		Title: "Toggle Full Screen Pane",
		Description: "Show one pane over the whole pane area of the window, the top bar and the sidebar staying, or every pane again. " +
			"Window state: the stored layout does not change. Default: the focused pane, toggled.",
		Category: "View",
		Args: []ArgSpec{
			paneIDArg("pane", "The pane to show full screen (default: the focused one)"),
			{Name: "on", Type: Bool, Description: "Turn full screen on (default: toggle)"},
			{Name: "off", Type: Bool, Description: "Turn full screen off (default: toggle)"},
			focusArg,
		},
		Keybindings: []string{"cmd+shift+enter"},
		// The user's view: a model arranges panes with pane.move and pane.resize.
		NoIndex: true,
		Run: func(_ context.Context, uctx Context, a Args) (Result, error) {
			if err := onlyFocus(uctx, a, "pane.fullscreen"); err != nil {
				return Result{}, err
			}
			mode := "toggle"
			switch {
			case a.Bool("on") && a.Bool("off"):
				return Result{}, InvalidArg("on", "--on and --off together")
			case a.Bool("on"):
				mode = "on"
			case a.Bool("off"):
				mode = "off"
			}
			params := map[string]string{"mode": mode}
			if p := a.String("pane"); p != "" {
				if mode == "off" {
					return Result{}, InvalidArg("pane", "--pane with --off: full screen ends for the whole window")
				}
				params["pane"] = p
			}
			return EmitTo(d.Emitter, showViewIntent(ViewPaneFullscreen, params)).CLIResult(uctx), nil
		},
	}
}
