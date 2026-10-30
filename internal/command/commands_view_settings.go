package command

import (
	"context"
	"slices"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// ViewSettingsPagePrefix starts the ShowView name of the settings page open on one of its
// pages: "settings.memory" (view.settings --page memory). Plain ViewSettings opens it on
// the page it shows, General the first time.
const ViewSettingsPagePrefix = ViewSettings + "."

// SettingsGUIPages are the settings pages the GUI draws on its own, after the schema's
// pages (gui/frontend/src/components/settings/guiPages.ts; a test keeps the two in step).
// One may be a schema page too (plugins).
var SettingsGUIPages = []string{"plugins", "skills", "memory"}

// settingsPageIDs are the ids view.settings --page takes: the schema's pages in display
// order, then the GUI's own. Without a schema reader, the GUI's own only.
func (d ViewDeps) settingsPageIDs(ctx context.Context) ([]string, error) {
	var ids []string
	if d.Settings != nil {
		res, err := d.Settings.GetSchema(ctx, connect.NewRequest(&v1.GetSettingsSchemaRequest{}))
		if err != nil {
			return nil, err
		}
		for _, p := range res.Msg.GetPages() {
			ids = append(ids, p.GetId())
		}
	}
	for _, id := range SettingsGUIPages {
		if !slices.Contains(ids, id) {
			ids = append(ids, id)
		}
	}
	return ids, nil
}

// settingsCommand is view.settings: the settings page, on one of its pages with --page.
func (d ViewDeps) settingsCommand() Command {
	return Command{
		Name:        "view.settings",
		Title:       "Settings",
		Description: "Show the settings page in every app window; --page opens it on one page (memory, plugins, skills, appearance, …).",
		Category:    "View",
		// The GUI presents cmd+, locally (keys/bindings.ts): there it toggles, in that
		// window only.
		Keybindings: []string{"cmd+,"},
		Args: []ArgSpec{
			pageFocusArg,
			{Name: "page", Type: String, Description: "The page to open it on: general, appearance, memory, plugins, skills, … (default: the page it shows)"},
		},
		Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
			page := a.String("page")
			if page == "" {
				return d.showPage(uctx, a, ViewSettings)
			}
			ids, err := d.settingsPageIDs(ctx)
			if err != nil {
				return Result{}, err
			}
			if !slices.Contains(ids, page) {
				return Result{}, InvalidArg("page", "no settings page %q; the pages are %s", page, strings.Join(ids, ", "))
			}
			return d.showPage(uctx, a, ViewSettingsPagePrefix+page)
		},
	}
}
