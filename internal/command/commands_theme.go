package command

import (
	"context"
	"fmt"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/theme"
)

// The theme settings (internal/store/settings, which imports this package, so the keys
// are repeated here): the scheme and the theme of each scheme.
const (
	keyThemeScheme = "appearance.theme"
	keyThemeDark   = "appearance.theme_dark"
	keyThemeLight  = "appearance.theme_light"
)

// ThemeListEntry is one theme in theme.list's JSON result.
type ThemeListEntry struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Scheme string `json:"scheme"`
	Pair   string `json:"pair,omitempty"`
	// Selected is true for the theme in its scheme's slot.
	Selected bool `json:"selected"`
}

// ThemeList is theme.list's JSON result.
type ThemeList struct {
	// Scheme is appearance.theme: system, dark, or light.
	Scheme string           `json:"scheme"`
	Dark   string           `json:"dark"`
	Light  string           `json:"light"`
	Themes []ThemeListEntry `json:"themes"`
}

// ThemeSet is theme.set-dark's and theme.set-light's JSON result.
type ThemeSet struct {
	Key    string `json:"key"`
	ID     string `json:"id"`
	Name   string `json:"name"`
	Scheme string `json:"scheme"`
}

// RegisterTheme registers theme.list, theme.set-dark and theme.set-light: the colour
// themes in the GUI's catalog (internal/theme) and the appearance.theme_dark /
// appearance.theme_light settings that pick one per scheme. The settings store validates
// a value against the catalog and the scheme; the args here are the scheme's ids, so the
// palette offers a pick list and the CLI refuses another scheme's theme before sending.
func RegisterTheme(r *Registry, b SettingsBackend) error {
	values := func(ctx context.Context) (map[string]string, error) {
		res, err := b.Get(ctx, connect.NewRequest(&v1.GetSettingsRequest{}))
		if err != nil {
			return nil, err
		}
		return res.Msg.GetSettings().GetValues(), nil
	}
	set := func(scheme, key string) Command {
		title := strings.ToUpper(scheme[:1]) + scheme[1:]
		return Command{
			Name:        "theme.set-" + scheme,
			Title:       "Set " + title + " Theme",
			Description: fmt.Sprintf("Choose the theme used when the scheme is %s (the %s setting). Run theme list for the ids.", scheme, key),
			Category:    "Settings",
			Args: []ArgSpec{{Name: "theme", Type: Enum, Enum: theme.IDs(scheme), Required: true, Positional: true,
				Description: "A " + scheme + " theme id, e.g. " + theme.Default(scheme)}},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				id := a.String("theme")
				res, err := b.Update(ctx, connect.NewRequest(&v1.UpdateSettingsRequest{Values: map[string]string{key: id}}))
				if err != nil {
					return Result{}, err
				}
				vals := res.Msg.GetSettings().GetValues()
				t, _ := theme.ByID(vals[key])
				msg := fmt.Sprintf("%s theme = %s (%s)", scheme, t.Name, t.ID)
				if s := vals[keyThemeScheme]; s != "system" && s != scheme {
					msg += fmt.Sprintf("; the scheme is %s, so it shows after `code-foundry settings set %s %s`", s, keyThemeScheme, scheme)
				}
				return Result{Message: msg, JSON: ThemeSet{Key: key, ID: t.ID, Name: t.Name, Scheme: t.Scheme}}, nil
			},
		}
	}
	return r.RegisterAll(
		Command{
			Name:        "theme.list",
			Title:       "List Themes",
			Description: "Print every colour theme by scheme, marking the dark and light themes in use.",
			Category:    "Settings",
			Run: func(ctx context.Context, _ Context, _ Args) (Result, error) {
				vals, err := values(ctx)
				if err != nil {
					return Result{}, err
				}
				out := ThemeList{Scheme: vals[keyThemeScheme], Dark: vals[keyThemeDark], Light: vals[keyThemeLight]}
				slot := map[string]string{theme.SchemeDark: out.Dark, theme.SchemeLight: out.Light}
				key := map[string]string{theme.SchemeDark: keyThemeDark, theme.SchemeLight: keyThemeLight}
				var sb strings.Builder
				fmt.Fprintf(&sb, "scheme: %s (%s)\n", out.Scheme, keyThemeScheme)
				for _, scheme := range []string{theme.SchemeDark, theme.SchemeLight} {
					fmt.Fprintf(&sb, "\n%s themes (%s):\n", scheme, key[scheme])
					ts := theme.For(scheme)
					w := 0
					for _, t := range ts {
						w = max(w, len(t.ID))
					}
					for _, t := range ts {
						sel := t.ID == slot[scheme]
						mark := " "
						if sel {
							mark = "*"
						}
						fmt.Fprintf(&sb, "%s %-*s  %s\n", mark, w, t.ID, t.Name)
						out.Themes = append(out.Themes, ThemeListEntry{ID: t.ID, Name: t.Name, Scheme: t.Scheme, Pair: t.Pair, Selected: sel})
					}
				}
				return Result{Message: strings.TrimRight(sb.String(), "\n"), JSON: out}, nil
			},
		},
		set(theme.SchemeDark, keyThemeDark),
		set(theme.SchemeLight, keyThemeLight),
	)
}
