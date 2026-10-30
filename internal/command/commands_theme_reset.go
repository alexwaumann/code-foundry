package command

import (
	"context"
	"fmt"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/theme"
)

// ThemeReset is theme.reset's JSON result: the slot's setting, the default theme it shows
// now, and the theme it showed before.
type ThemeReset struct {
	Key      string `json:"key"`
	ID       string `json:"id"`
	Name     string `json:"name"`
	Scheme   string `json:"scheme"`
	Previous string `json:"previous"`
}

// themeResetCommand is theme.reset: a scheme's slot back to the built-in default theme,
// by resetting its setting (appearance.theme_dark / theme_light), so the slot follows the
// default if it ever changes. No theme file is touched. Without --slot it resets the slot
// in use (the scheme the app shows, as theme.pick's page opens on); with the scheme on
// system and no window to say which the Mac shows, it asks for --slot.
func themeResetCommand(d ThemeDeps, values func(context.Context) (map[string]string, error), set func() theme.Set) Command {
	return Command{
		Name:  "theme.reset",
		Title: "Reset Theme to Default",
		Description: "Make the dark or light slot use the built-in default theme again (the slot in use without --slot). " +
			"Your own themes are kept.",
		Category: "Settings",
		Args: []ArgSpec{{Name: "slot", Type: Enum, Enum: []string{theme.SchemeDark, theme.SchemeLight},
			Description: "The slot to reset: dark or light (default: the one in use)"}},
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			vals, err := values(ctx)
			if err != nil {
				return Result{}, err
			}
			scheme := a.String("slot")
			if scheme == "" {
				if scheme = themeShowing(d, vals); scheme == "" {
					return Result{}, InvalidArg("slot", "the scheme is system and no app window says which the Mac shows: pass --slot dark or --slot light")
				}
			}
			key := themeSlotKey[scheme]
			was := vals[key]
			res, err := d.Settings.Update(ctx, connect.NewRequest(&v1.UpdateSettingsRequest{Values: map[string]string{key: ""}}))
			if err != nil {
				return Result{}, err
			}
			now := res.Msg.GetSettings().GetValues()
			t, _ := set().ByID(now[key])
			out := ThemeReset{Key: key, ID: t.ID, Name: t.Name, Scheme: scheme, Previous: was}
			msg := fmt.Sprintf("%s theme = %s (%s), the default", scheme, t.Name, t.ID)
			if was != "" && was != t.ID {
				msg += ", was " + themeName(set(), was)
			}
			return Result{Message: msg + themeSchemeNote(now[keyThemeScheme], themeShowing(d, now), scheme), JSON: out}, nil
		},
	}
}
