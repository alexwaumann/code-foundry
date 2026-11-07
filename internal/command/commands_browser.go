package command

import (
	"context"
	"fmt"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/browser"
)

// The experimental Chrome surface's commands (docs/notes/chrome-surface.md). None of them are
// in the static registry: the daemon registers them while experimental.chrome_surface is on and
// removes them when it goes off, so off they do not exist, for the palette, the CLI or
// `--help`. Nothing in internal/command/all names them.
//
// An agent has one verb: view.panel.browser asks a window to show a URL. It cannot read,
// click or script a page, and the surface's own controls below are the window's. They exist
// for the palette and answer every other caller with a refusal, like file.save, because the
// page behind them can be logged in as the user.
//
// To a page shown in the app (docs/notes/page-verb-gate.md): --url aims a browser that may be
// signed in as the user, so it asks; showing the tab alone does not. The controls ask too, which
// fails closed: they refuse every caller but the window anyway.

// ViewPanelBrowser is the ShowView name that opens the Browser surface in a side panel, with
// the param "url" when it names where to go.
const ViewPanelBrowser = "panel.browser"

// ViewPanelBrowserVerb is the command that sends it.
const ViewPanelBrowserVerb = "view.panel.browser"

// browserWindowVerbs are the surface's controls, run by the window itself.
var browserWindowVerbs = []struct{ name, title, what string }{
	{"browser.back", "Browser: Back", "Go back in the Browser tab in front."},
	{"browser.forward", "Browser: Forward", "Go forward in the Browser tab in front."},
	{"browser.reload", "Browser: Reload", "Reload the Browser tab in front."},
	{"browser.relaunch", "Browser: Relaunch Chrome", "Start Chrome again after it stopped."},
}

// BrowserCommands are the commands the setting adds.
func BrowserCommands(t ThreadGetter, e Emitter) []Command {
	cmds := []Command{{
		Name:  ViewPanelBrowserVerb,
		Title: "Show Browser",
		Description: "Experimental: open the Browser tab in a thread's side panel (from a thread: its own; in the app: the selected one), " +
			"optionally at --url. It only shows the page to the user: there is no way to read, click or script it.",
		Category:     "View",
		NoKeybinding: true,
		NoIndex:      true,
		Page:         PageState,
		Args: append([]ArgSpec{
			{Name: "url", Type: String, PageAsks: true, Description: "Where to go: http or https only"},
		}, panelThreadArgs()...),
		Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
			var params map[string]string
			if raw := a.String("url"); raw != "" {
				u, err := browser.NormalizeURL(raw)
				if err != nil {
					return Result{}, InvalidArg("url", "%s", err)
				}
				params = map[string]string{"url": u}
			}
			id := panelThread(uctx, a)
			if id == "" {
				if a.Bool("focus") && uctx.ActiveView == "" {
					return Result{}, InvalidArg("focus", "needs a thread to select (--thread, or run it inside a thread)")
				}
				return EmitTo(e, showViewIntent(ViewPanelBrowser, "", params)).CLIResult(uctx), nil
			}
			return showScoped(ctx, t, e, uctx, a, id, ViewPanelBrowser, func(context.Context, *v1.Thread, Args) (map[string]string, error) {
				return params, nil
			})
		},
	}}
	for _, v := range browserWindowVerbs {
		cmds = append(cmds, Command{
			Name: v.name, Title: v.title, Description: v.what + " Only from the window: refused from the CLI.",
			Category: "Browser", NoKeybinding: true, NoIndex: true, Page: PageRuns,
			Run: func(context.Context, Context, Args) (Result, error) {
				return Result{}, fmt.Errorf("%s: %w: only the user can do this, from the window", v.name, ErrUnavailable)
			},
		})
	}
	return cmds
}

// Toggle adds cmds when on and removes them when off, leaving a command already as asked. For
// a setting that makes commands exist, which Register alone cannot undo.
func (r *Registry) Toggle(on bool, cmds ...Command) error {
	for i := range cmds {
		if err := cmds[i].validate(); err != nil {
			return err
		}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, c := range cmds {
		if !on {
			delete(r.cmds, c.Name)
		} else if _, ok := r.cmds[c.Name]; !ok {
			r.cmds[c.Name] = &c
		}
	}
	return nil
}
