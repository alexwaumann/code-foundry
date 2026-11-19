package command

import (
	"context"
	"fmt"
	"path/filepath"
	"slices"
	"strings"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/fsx"
	"github.com/alexwaumann/code-foundry/internal/paths"
)

// view.open.page (view.panel.page): an HTML page in a tab beside a thread only, with no card in its
// conversation (docs/notes/page-verbs.md). It takes view.inline --panel's panel half
// alone: the File tab (view.open.file's check and the same frame, reloaded on
// every edit), with params page=1 and the title, which tell the GUI the tab is the thread's
// page. The daemon also records the thread as the page's owner (PageShown,
// docs/notes/page-ownership-daemon.md), so the page keeps its bridge without a card in the
// log or the flag (components/files/usePageThread.ts). So, as for view.inline, the file must be under
// home: view.open.file also shows the temp folders, as plain pages without the bridge.

// panelPageCommand is view.open.page.
func (d ViewDeps) panelPageCommand() Command {
	return Command{
		Name:      "view.open.page",
		Page:      PageState,
		NoPalette: true,
		Title:     "Open HTML Page Tab",
		Description: "Open an HTML page in a File tab " + openLead +
			"the page alone, no card in the conversation, run with the thread's /cf/bridge.js as view.inline --panel's is.",
		Category:     "View",
		NoKeybinding: true,
		When:         hasThread,
		Args: []ArgSpec{
			{Name: "path", Type: Path, Required: true, Positional: true,
				Description: "The .html or .htm file: absolute, ~/…, or relative to the current directory; under the home directory"},
			{Name: "title", Type: String, Description: fmt.Sprintf("The tab's title (default: the file's name), at most %d characters", maxDiffTitle)},
			openThreadArg, openFocusArg, openPaneArg,
		},
		Run: d.runPanelPage,
	}
}

func (d ViewDeps) runPanelPage(ctx context.Context, uctx Context, a Args) (Result, error) {
	id := a.String("thread")
	if id == "" {
		return Result{}, InvalidArg("thread", "needs a thread whose tab to open (--thread, or run it inside a thread)")
	}
	var base string
	res, err := d.showItem(ctx, uctx, a, id, tabFile, func(ctx context.Context, t *v1.Thread, a Args) (map[string]string, error) {
		base = t.GetWorktreePath()
		return d.pageCheck(ctx, t, a)
	})
	if err != nil {
		return Result{}, err
	}
	if d.PageShown != nil {
		d.PageShown(ctx, id, a.Path("path"))
	}
	// The tab's frame fills it, so a page without the bridge is not cut short there.
	res.Warnings = slices.DeleteFunc(d.pageWarnings(ctx, base, a.Path("path")), func(w string) bool { return w == WarnNoResize })
	return res, nil
}

// inPagesRoot reports whether the file at p (symlinks followed) is in the threads' pages
// directories' folder (PagesRoot), which may be outside home.
func (d ViewDeps) inPagesRoot(p string) bool {
	if d.PagesRoot == "" || p == "" {
		return false
	}
	real, err := filepath.EvalSymlinks(p)
	if err != nil {
		return false
	}
	for _, root := range []string{d.PagesRoot, evalOr(d.PagesRoot)} {
		if fsx.Within(filepath.Clean(root), real) {
			return true
		}
	}
	return false
}

// evalOr is p with its symlinks resolved, or p when that fails.
func evalOr(p string) string {
	if real, err := filepath.EvalSymlinks(p); err == nil {
		return real
	}
	return p
}

// pageCheck is view.open.page's check: an .html or .htm file (as view.inline's), then
// view.open.file's, plus home only (a temp folder is everyone's, and the bridge acts as the
// thread) and the params that make the tab the thread's page.
func (d ViewDeps) pageCheck(ctx context.Context, t *v1.Thread, a Args) (map[string]string, error) {
	switch strings.ToLower(filepath.Ext(a.Path("path"))) {
	case ".html", ".htm":
	default:
		return nil, InvalidArg("path", "%s is not an .html or .htm file (view.open.file shows any file)", a.Path("path"))
	}
	params, outsideHome, err := d.readCheck(ctx, t, a)
	if err != nil {
		return nil, err
	}
	if outsideHome && !d.inPagesRoot(params["path"]) {
		return nil, InvalidArg("path", "%s is outside your home directory, and a page with the thread's bridge must be under it: "+
			"move it to your pages directory ($%s) or elsewhere under home, or show it without the bridge with view.open.file",
			a.Path("path"), paths.EnvPages)
	}
	params["page"] = "1"
	title, err := diffText(a, "title", maxDiffTitle)
	if err != nil {
		return nil, err
	}
	if title != "" {
		params["title"] = title
	}
	return params, nil
}
