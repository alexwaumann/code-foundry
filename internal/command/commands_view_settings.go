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

// SettingsGUIPages are the settings pages the GUI draws on its own
// (gui/frontend/src/components/settings/guiPages.ts; a test keeps the two in step). One may
// be a schema page too (plugins); the rest follow the one before them, so they sit after
// Plugins and before the schema's later pages (Ember, Advanced).
var SettingsGUIPages = []string{"plugins", "skills", "memory"}

// settingsPageIDs are the ids view.settings --page takes, in the settings nav's order: the
// schema's pages, with each of the GUI's own that the schema lacks right after the GUI page
// before it (the GUI's settingsPages). Without a schema reader, the GUI's own only.
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
	for i, id := range SettingsGUIPages {
		if slices.Contains(ids, id) {
			continue
		}
		at := len(ids)
		if i > 0 {
			if j := slices.Index(ids, SettingsGUIPages[i-1]); j >= 0 {
				at = j + 1
			}
		}
		ids = slices.Insert(ids, at, id)
	}
	return ids, nil
}

// ViewSettingParam is the ShowView param of view.settings --setting: the key of the row
// the settings page brings into view, on that setting's page.
const ViewSettingParam = "setting"

// settingPage is the page the settings page shows key on; "" when the schema has no such
// setting (or there is no schema reader).
func (d ViewDeps) settingPage(ctx context.Context, key string) (string, error) {
	if d.Settings == nil {
		return "", nil
	}
	res, err := d.Settings.GetSchema(ctx, connect.NewRequest(&v1.GetSettingsSchemaRequest{}))
	if err != nil {
		return "", err
	}
	for _, f := range res.Msg.GetFields() {
		if f.GetKey() == key {
			return f.GetPage(), nil
		}
	}
	return "", nil
}

// settingsCommand is view.settings: the settings page, on one of its pages with --page, or
// at one setting's row with --setting.
func (d ViewDeps) settingsCommand() Command {
	return Command{
		Name:  "view.settings",
		Page:  PageState,
		Title: "Settings",
		Description: "Show the settings page in every app window; --page opens it on one page (memory, plugins, skills, appearance, …), " +
			"--setting at one setting's row (layout.threads_open_as).",
		Category: "View",
		// The GUI presents cmd+, locally (keys/bindings.ts): there it toggles, in that
		// window only.
		Keybindings: []string{"cmd+,"},
		Args: []ArgSpec{
			pageFocusArg,
			{Name: "page", Type: String, Description: "The page to open it on: general, appearance, memory, plugins, skills, … (default: the page it shows)"},
			{Name: "setting", Type: String, Description: "A setting's key (settings list): open its page with its row in view and focused; leave out --page"},
		},
		Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
			page := a.String("page")
			if key := strings.TrimSpace(a.String("setting")); key != "" {
				if page != "" {
					return Result{}, InvalidArg("page", "give --page or --setting, not both: --setting opens the setting's own page")
				}
				on, err := d.settingPage(ctx, key)
				if err != nil {
					return Result{}, err
				}
				if on == "" {
					return Result{}, InvalidArg("setting", "no setting %q; settings list names them", key)
				}
				if err := d.refusePage(uctx, a); err != nil {
					return Result{}, err
				}
				return EmitTo(d.Emitter, showViewIntent(ViewSettingsPagePrefix+on, map[string]string{ViewSettingParam: key})).CLIResult(uctx), nil
			}
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
