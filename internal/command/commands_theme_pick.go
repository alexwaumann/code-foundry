package command

import (
	"context"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/theme"
)

// ViewThemes is the ShowView name of the Themes page: the theme list for one scheme's
// slot, a gallery that previews the picked theme, and Apply. "themes.dark" and
// "themes.light" open it editing that slot; plain "themes" edits the slot in use.
const ViewThemes = "themes"

// RegisterThemePick registers theme.pick, which opens the GUI's Themes page (emitted as
// UiIntent.ShowView). The page previews a theme before writing appearance.theme_dark or
// appearance.theme_light through theme.set-dark / theme.set-light (RegisterTheme).
func RegisterThemePick(r *Registry, e Emitter) error {
	return r.Register(Command{
		Name:        "theme.pick",
		Title:       "Choose Theme…",
		Description: "Open the Themes page: preview each theme in a gallery of the app's controls, then apply it to the dark or light slot.",
		Category:    "Settings",
		Args: []ArgSpec{{Name: "slot", Type: Enum, Enum: []string{theme.SchemeDark, theme.SchemeLight}, Positional: true,
			Description: "The slot to edit first (default: the one in use)"}},
		// No default chord; bindable in settings. The GUI presents it locally
		// (gui/frontend/src/keys/bindings.ts), so only that window opens the page.
		Run: func(_ context.Context, uctx Context, a Args) (Result, error) {
			name := ViewThemes
			if s := a.String("slot"); s != "" {
				name += "." + s
			}
			// Like the view commands: in the app the page opening is the feedback; the
			// CLI says how many windows it went to.
			return EmitTo(e, &v1.UiIntent{Intent: &v1.UiIntent_ShowView_{ShowView: &v1.UiIntent_ShowView{Name: name}}}).CLIResult(uctx), nil
		},
	})
}
