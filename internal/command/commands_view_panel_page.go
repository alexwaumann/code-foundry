package command

import (
	"context"
	"path/filepath"
	"slices"
	"strings"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// view.panel.page: an HTML page in a thread's side panel only, with no card in its
// conversation (docs/notes/page-verbs.md). It takes view.inline --panel's panel half
// alone: the File tab's ShowView (view.panel.file's check, so the same home-directory rule
// and the same frame, reloaded on every edit), with params page=1 and the title, which tell
// the GUI the tab is the thread's page. Without a card in the log, that flag is what gives
// the page its thread's bridge and storage (components/files/usePageThread.ts).

// panelPageCommand is view.panel.page.
func (d ViewDeps) panelPageCommand() Command {
	return Command{
		Name:      "view.panel.page",
		NoPalette: true,
		Title:     "Show HTML Page in Side Panel",
		Description: "Open an HTML page in a File tab in a thread's side panel (from a thread: its own; in the app: the selected one): " +
			"the page alone, no card in the conversation, run with the thread's /cf/bridge.js as view.inline --panel's is.",
		Category:     "View",
		NoKeybinding: true,
		When:         hasThread,
		Args: []ArgSpec{
			{Name: "path", Type: Path, Required: true, Positional: true,
				Description: "The .html or .htm file: absolute, ~/…, or relative to the current directory; under the home directory"},
			{Name: "title", Type: String, Description: "The tab's title (default: the file's name)"},
			{Name: "thread", Type: String, Context: ContextThread, ID: ThreadID,
				Description: "Thread whose side panel it opens in, without changing what any window shows " +
					"(default: the thread this runs in, $CODE_FOUNDRY_THREAD; in the app: the selected thread)" + IDHelp},
			panelThreadArgs()[1],
		},
		Run: d.runPanelPage,
	}
}

func (d ViewDeps) runPanelPage(ctx context.Context, uctx Context, a Args) (Result, error) {
	id := a.String("thread")
	if id == "" {
		return Result{}, InvalidArg("thread", "needs a thread whose panel to open it in (--thread, or run it inside a thread)")
	}
	var base string
	res, err := showScoped(ctx, d.Thread, d.Emitter, uctx, a, id, ViewPanelFile, func(ctx context.Context, t *v1.Thread, a Args) (map[string]string, error) {
		base = t.GetWorktreePath()
		return d.pageCheck(ctx, t, a)
	})
	if err != nil {
		return Result{}, err
	}
	// The panel's frame fills its tab, so a page without the bridge is not cut short there.
	res.Warnings = slices.DeleteFunc(d.pageWarnings(ctx, base, a.Path("path")), func(w string) bool { return w == WarnNoResize })
	return res, nil
}

// pageCheck is view.panel.page's check: an .html or .htm file (as view.inline's), then
// view.panel.file's, plus the params that make the tab the thread's page.
func (d ViewDeps) pageCheck(ctx context.Context, t *v1.Thread, a Args) (map[string]string, error) {
	switch strings.ToLower(filepath.Ext(a.Path("path"))) {
	case ".html", ".htm":
	default:
		return nil, InvalidArg("path", "%s is not an .html or .htm file (view.panel.file shows any file)", a.Path("path"))
	}
	params, err := d.fileCheck(ctx, t, a)
	if err != nil {
		return nil, err
	}
	params["page"] = "1"
	if title := strings.TrimSpace(a.String("title")); title != "" {
		params["title"] = title
	}
	return params, nil
}
