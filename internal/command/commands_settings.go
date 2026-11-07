package command

import (
	"context"
	"fmt"
	"os/exec"
	"slices"
	"strconv"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
)

// SettingsBackend is the slice of SettingsService the settings.* commands need, in
// generated Connect signatures (see TerminalBackend for why). The API handler and a
// SettingsServiceClient satisfy it.
type SettingsBackend interface {
	GetSchema(context.Context, *connect.Request[v1.GetSettingsSchemaRequest]) (*connect.Response[v1.GetSettingsSchemaResponse], error)
	Get(context.Context, *connect.Request[v1.GetSettingsRequest]) (*connect.Response[v1.GetSettingsResponse], error)
	Update(context.Context, *connect.Request[v1.UpdateSettingsRequest]) (*connect.Response[v1.UpdateSettingsResponse], error)
}

var (
	_ SettingsBackend = codefoundryv1connect.SettingsServiceHandler(nil)
	_ SettingsBackend = codefoundryv1connect.SettingsServiceClient(nil)
)

// RevealFunc shows a file in Finder.
type RevealFunc func(ctx context.Context, path string) error

// RevealInFinder runs `open -R path`.
func RevealInFinder(ctx context.Context, path string) error {
	if out, err := exec.CommandContext(ctx, "open", "-R", path).CombinedOutput(); err != nil {
		return fmt.Errorf("open -R %s: %w: %s", path, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// SettingValue is one entry of settings.get's JSON result (and settings.set's and
// settings.reset's): the value with what the schema says about the setting, so an
// agent can explain it without reading the settings page.
type SettingValue struct {
	Key         string `json:"key"`
	Value       string `json:"value"`
	Default     string `json:"default"`
	Title       string `json:"title"`
	Description string `json:"description"`
	// Type is the SettingType's lower-case name: string, int, bool, enum, path or
	// keybinding.
	Type string `json:"type"`
	// UserOnly: a page, a plugin or a thread cannot change it (SettingField.user_only).
	UserOnly bool `json:"userOnly,omitempty"`
}

// settingValue is f's SettingValue with value v.
func settingValue(f *v1.SettingField, v string) SettingValue {
	return SettingValue{
		Key: f.GetKey(), Value: v, Default: f.GetDefaultValue(), Title: f.GetTitle(), Description: f.GetDescription(),
		Type:     strings.ToLower(strings.TrimPrefix(f.GetType().String(), "SETTING_TYPE_")),
		UserOnly: f.GetUserOnly(),
	}
}

// pageAsks is the check for a command that changes a setting on a page's call: the user
// answers first, and `ask` says what the dialog shows. A page's script is not the user, and
// one click in it is not a yes to this. It is here, not Command.Confirm, because a thread's
// CLI has a page's context and must not start needing --yes; the ConfirmError comes back
// from Run like a second stage's, and the re-invoke's ConfirmedIn answers it.
func pageAsks(ctx context.Context, uctx Context, command, title, label, ask string) error {
	if uctx.Origin == OriginPage && !ConfirmedIn(ctx) {
		return &ConfirmError{Command: command, Title: title, Message: ask, Label: label}
	}
	return nil
}

// settingChange is whether uctx's caller may change f. A user-only setting refuses
// everyone but the user, confirmed or not; any other asks a page's user first (pageAsks).
func settingChange(ctx context.Context, uctx Context, f *v1.SettingField, command, title, label, ask string) error {
	if f.GetUserOnly() && !uctx.FromUser() {
		return Failed(fmt.Errorf("%s can only be changed by the user; they can change it in Settings", f.GetKey()))
	}
	return pageAsks(ctx, uctx, command, title, label, ask)
}

// askValueChars is the most of a value a dialog shows.
const askValueChars = 200

// askValue is a setting's value as a dialog shows it: quoted, so it cannot draw lines of
// its own, and past askValueChars cut with a marker, so what is not shown is not a surprise.
func askValue(v string) string {
	r := []rune(v)
	if len(r) <= askValueChars {
		return strconv.Quote(v)
	}
	return fmt.Sprintf("%s… (%d more characters not shown)", strconv.Quote(string(r[:askValueChars])), len(r)-askValueChars)
}

// settingsWarnings are the settings.* commands' warnings about the settings file: it
// does not parse (so it is not what is in effect), or it holds values the app ignores.
// With key set, only that key's issue is reported; else one line lists them all.
func settingsWarnings(snap *v1.SettingsSnapshot, key string) []string {
	var out []string
	if e := snap.GetLoadError(); e != "" {
		out = append(out, fmt.Sprintf("%s does not parse (%s); the last settings that loaded are in effect (the defaults if none have); fix the file by hand", snap.GetPath(), e))
	}
	var keys []string
	for _, is := range snap.GetIssues() {
		switch {
		case key == "":
			keys = append(keys, is.GetKey())
		case is.GetKey() == key:
			out = append(out, fmt.Sprintf("%s in %s is ignored: %s", key, snap.GetPath(), is.GetMessage()))
		}
	}
	if keys = slices.Compact(keys); len(keys) > 0 {
		noun := "values are"
		if len(keys) == 1 {
			noun = "value is"
		}
		out = append(out, fmt.Sprintf("%d %s ignored in %s (kept in the file until fixed; see the \"# Ignored:\" lines): %s", len(keys), noun, snap.GetPath(), strings.Join(keys, ", ")))
	}
	return out
}

// Views the GUI knows how to show (UiIntent.ShowView.name): the settings page and the
// help overlay (view.settings and view.help, RegisterView).
const (
	ViewHelp     = "help"
	ViewSettings = "settings"
)

// RegisterSettings registers settings.get, settings.set, settings.reset, settings.path
// and settings.reveal. reveal may be nil (RevealInFinder).
func RegisterSettings(r *Registry, b SettingsBackend, reveal RevealFunc) error {
	if reveal == nil {
		reveal = RevealInFinder
	}
	keyArg := ArgSpec{Name: "key", Type: String, Required: true, Positional: true, Description: `Setting key, e.g. "appearance.font_size"`}
	// field looks a key up in the schema so typos are reported as such.
	field := func(ctx context.Context, key string) (*v1.SettingField, []*v1.SettingField, error) {
		res, err := b.GetSchema(ctx, connect.NewRequest(&v1.GetSettingsSchemaRequest{}))
		if err != nil {
			return nil, nil, err
		}
		fields := res.Msg.GetFields()
		i := slices.IndexFunc(fields, func(f *v1.SettingField) bool { return f.GetKey() == key })
		if key != "" && i < 0 {
			return nil, fields, InvalidArg("key", "unknown setting %q (run `code-foundry settings get` to list them)", key)
		}
		if i < 0 {
			return nil, fields, nil
		}
		return fields[i], fields, nil
	}
	restartNote := func(f *v1.SettingField) string {
		if f.GetRestartRequired() {
			return " (applies after a daemon restart)"
		}
		return ""
	}
	return r.RegisterAll(
		Command{
			Name:         "settings.get",
			NoPalette:    true,
			ReadOnly:     true,
			Title:        "Show Settings",
			Description:  "Print every setting as key = value, or one setting's value.",
			Category:     "Settings",
			NoKeybinding: true,
			Args:         []ArgSpec{{Name: "key", Type: String, Positional: true, Description: "Setting key (default: all)"}},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				key := a.String("key")
				f, fields, err := field(ctx, key)
				if err != nil {
					return Result{}, err
				}
				res, err := b.Get(ctx, connect.NewRequest(&v1.GetSettingsRequest{}))
				if err != nil {
					return Result{}, err
				}
				snap := res.Msg.GetSettings()
				vals := snap.GetValues()
				warns := settingsWarnings(snap, key)
				if f != nil {
					v := vals[key]
					return Result{Message: v, JSON: settingValue(f, v), Warnings: warns}, nil
				}
				var sb strings.Builder
				out := make([]SettingValue, 0, len(fields))
				for _, f := range fields {
					v := vals[f.GetKey()]
					out = append(out, settingValue(f, v))
					fmt.Fprintf(&sb, "%s = %q\n", f.GetKey(), v)
				}
				return Result{Message: strings.TrimRight(sb.String(), "\n"), JSON: out, Warnings: warns}, nil
			},
		},
		Command{
			Name:         "settings.set",
			NoPalette:    true,
			Title:        "Change Setting",
			Description:  "Set one setting. The value is validated against the setting's type and written to the settings file. A page asks the user first; a user-only setting is refused from a page, a plugin or a thread.",
			Category:     "Settings",
			NoKeybinding: true,
			Args: []ArgSpec{keyArg, {Name: "value", Type: String, Required: true, Positional: true,
				Description: `New value (bool: true/false; keybinding: a chord such as "cmd+shift+n", or "none")`}},
			Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
				key := a.String("key")
				f, _, err := field(ctx, key)
				if err != nil {
					return Result{}, err
				}
				ask := fmt.Sprintf("Change %s to %s?", key, askValue(a.String("value")))
				if err := settingChange(ctx, uctx, f, "settings.set", "Change Setting", "Change", ask); err != nil {
					return Result{}, err
				}
				res, err := b.Update(ctx, connect.NewRequest(&v1.UpdateSettingsRequest{Values: map[string]string{key: a.String("value")}}))
				if err != nil {
					return Result{}, err
				}
				v := res.Msg.GetSettings().GetValues()[key]
				return Result{Message: fmt.Sprintf("%s = %q%s", key, v, restartNote(f)), JSON: settingValue(f, v),
					Warnings: settingsWarnings(res.Msg.GetSettings(), "")}, nil
			},
		},
		Command{
			Name:         "settings.reset",
			NoPalette:    true,
			Title:        "Reset Setting",
			Description:  "Return one setting to its default. A page asks the user first; a user-only setting is refused from a page, a plugin or a thread.",
			Category:     "Settings",
			NoKeybinding: true,
			Args:         []ArgSpec{keyArg},
			Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
				key := a.String("key")
				f, _, err := field(ctx, key)
				if err != nil {
					return Result{}, err
				}
				ask := fmt.Sprintf("Reset %s to its default, %s?", key, askValue(f.GetDefaultValue()))
				if err := settingChange(ctx, uctx, f, "settings.reset", "Reset Setting", "Reset", ask); err != nil {
					return Result{}, err
				}
				res, err := b.Update(ctx, connect.NewRequest(&v1.UpdateSettingsRequest{Values: map[string]string{key: ""}}))
				if err != nil {
					return Result{}, err
				}
				v := res.Msg.GetSettings().GetValues()[key]
				return Result{Message: fmt.Sprintf("%s = %q (default)%s", key, v, restartNote(f)), JSON: settingValue(f, v),
					Warnings: settingsWarnings(res.Msg.GetSettings(), "")}, nil
			},
		},
		Command{
			Name:         "settings.path",
			NoPalette:    true,
			ReadOnly:     true,
			Title:        "Settings File Path",
			Description:  "Print the settings file's path.",
			Category:     "Settings",
			NoKeybinding: true,
			Run: func(ctx context.Context, _ Context, _ Args) (Result, error) {
				res, err := b.Get(ctx, connect.NewRequest(&v1.GetSettingsRequest{}))
				if err != nil {
					return Result{}, err
				}
				p := res.Msg.GetSettings().GetPath()
				return Result{Message: p, JSON: map[string]string{"path": p}}, nil
			},
		},
		Command{
			Name:        "settings.reveal",
			Title:       "Open Settings File in Finder",
			Description: "Show the settings file in Finder.",
			Category:    "Settings",
			Run: func(ctx context.Context, _ Context, _ Args) (Result, error) {
				res, err := b.Get(ctx, connect.NewRequest(&v1.GetSettingsRequest{}))
				if err != nil {
					return Result{}, err
				}
				p := res.Msg.GetSettings().GetPath()
				if err := reveal(ctx, p); err != nil {
					return Result{}, err
				}
				return Result{Message: "revealed " + p}, nil
			},
		},
	)
}
