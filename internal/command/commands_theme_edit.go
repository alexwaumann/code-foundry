package command

import (
	"context"
	"errors"
	"fmt"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/theme"
)

// ViewThemeEditPrefix is the ShowView name of the Themes page editing one of the user's
// themes: "themes.edit.<id>" (docs/notes/theme-editor.md). The page opens on the
// theme's scheme with the editor beside the gallery.
const ViewThemeEditPrefix = ViewThemes + ".edit."

// RegisterThemeEdit registers theme.edit, which opens the GUI's Themes page in edit mode
// on one of the user's themes (emitted as UiIntent.ShowView). The editor derives and
// checks contrast in the GUI; saving is theme.save. A curated theme is copied first
// (theme.duplicate, or Customise on the page, which then edits the copy).
func RegisterThemeEdit(r *Registry, e Emitter, themes ThemeBackend) error {
	userIDs := func() []string {
		if themes == nil {
			return nil
		}
		snap := themes.Snapshot()
		ids := make([]string, len(snap.Themes))
		for i, f := range snap.Themes {
			ids[i] = f.ID
		}
		return ids
	}
	return r.Register(Command{
		Name:  "theme.edit",
		Title: "Edit Theme…",
		Description: "Open one of your themes in the Themes page's editor: change its base colours or pin single slots, with the gallery previewing " +
			"every change and the contrast checked as you go; Save writes the file. A curated theme is copied first (theme duplicate <id>).",
		Category: "Settings",
		Args: []ArgSpec{{Name: "theme", Type: Enum, EnumFunc: userIDs, Required: true, Positional: true,
			EnumMiss: func(v string) error {
				if f, ok := theme.Curated(v); ok {
					return fmt.Errorf("%s (%q) is a curated theme; copy it first (theme duplicate %s) and edit the copy", f.Name, v, v)
				}
				return fmt.Errorf("no theme %q among yours (theme list marks them)", v)
			},
			Description: "One of your themes' ids (theme list marks them)"}},
		Run: func(_ context.Context, uctx Context, a Args) (Result, error) {
			if themes == nil {
				return Result{}, connect.NewError(connect.CodeUnimplemented, errors.New("this daemon has no user themes"))
			}
			id := a.String("theme")
			if _, user, err := themes.Get(id); err != nil {
				return Result{}, themeErr("theme", err)
			} else if !user {
				return Result{}, InvalidArg("theme", "%q is a curated theme; copy it first (theme duplicate %s) and edit the copy", id, id)
			}
			res := EmitTo(e, &v1.UiIntent{Intent: &v1.UiIntent_ShowView_{ShowView: &v1.UiIntent_ShowView{Name: ViewThemeEditPrefix + id}}})
			if uctx.ActiveView == "" && res.Windows > 0 {
				return Result{Message: fmt.Sprintf("editing %s in the Themes page (windows=%d)", id, res.Windows), JSON: res}, nil
			}
			return res.CLIResult(uctx), nil
		},
	})
}
