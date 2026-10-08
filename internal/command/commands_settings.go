package command

import (
	"context"
	"fmt"
	"os/exec"
	"slices"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/awaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/awaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
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

// SettingValue is one entry of settings.get's JSON result.
type SettingValue struct {
	Key     string `json:"key"`
	Value   string `json:"value"`
	Default string `json:"default"`
}

// Views the GUI knows how to show (UiIntent.ShowView.name).
const (
	ViewHelp     = "help"
	ViewSettings = "settings"
)

// RegisterSettings registers settings.get, settings.set, settings.reset, settings.path,
// settings.reveal, and the view.settings and view.help commands that open the GUI's
// settings page and help overlay. reveal may be nil (RevealInFinder).
func RegisterSettings(r *Registry, b SettingsBackend, e Emitter, reveal RevealFunc) error {
	if reveal == nil {
		reveal = RevealInFinder
	}
	keyArg := ArgSpec{Name: "key", Type: String, Required: true, Positional: true, Description: `Setting key, e.g. "appearance.font_size"`}
	show := func(name string) Result {
		n := e.Emit(&v1.UiIntent{Intent: &v1.UiIntent_ShowView_{ShowView: &v1.UiIntent_ShowView{Name: name}}})
		return Result{Message: fmt.Sprintf("delivered=%d", n), JSON: EmitResult{Delivered: n}}
	}
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
			Name:        "settings.get",
			Title:       "Show Settings",
			Description: "Print every setting as key = value, or one setting's value.",
			Category:    "Settings",
			Args:        []ArgSpec{{Name: "key", Type: String, Positional: true, Description: "Setting key (default: all)"}},
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
				vals := res.Msg.GetSettings().GetValues()
				if f != nil {
					v := vals[key]
					return Result{Message: v, JSON: SettingValue{Key: key, Value: v, Default: f.GetDefaultValue()}}, nil
				}
				var sb strings.Builder
				out := make([]SettingValue, 0, len(fields))
				for _, f := range fields {
					v := vals[f.GetKey()]
					out = append(out, SettingValue{Key: f.GetKey(), Value: v, Default: f.GetDefaultValue()})
					fmt.Fprintf(&sb, "%s = %q\n", f.GetKey(), v)
				}
				return Result{Message: strings.TrimRight(sb.String(), "\n"), JSON: out}, nil
			},
		},
		Command{
			Name:        "settings.set",
			Title:       "Change Setting",
			Description: "Set one setting. The value is validated against the setting's type and written to the settings file.",
			Category:    "Settings",
			Args: []ArgSpec{keyArg, {Name: "value", Type: String, Required: true, Positional: true,
				Description: `New value (bool: true/false; keybinding: a chord such as "cmd+shift+n", or "none")`}},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				key := a.String("key")
				f, _, err := field(ctx, key)
				if err != nil {
					return Result{}, err
				}
				res, err := b.Update(ctx, connect.NewRequest(&v1.UpdateSettingsRequest{Values: map[string]string{key: a.String("value")}}))
				if err != nil {
					return Result{}, err
				}
				v := res.Msg.GetSettings().GetValues()[key]
				return Result{Message: fmt.Sprintf("%s = %q%s", key, v, restartNote(f)), JSON: SettingValue{Key: key, Value: v, Default: f.GetDefaultValue()}}, nil
			},
		},
		Command{
			Name:        "settings.reset",
			Title:       "Reset Setting",
			Description: "Return one setting to its default.",
			Category:    "Settings",
			Args:        []ArgSpec{keyArg},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				key := a.String("key")
				f, _, err := field(ctx, key)
				if err != nil {
					return Result{}, err
				}
				res, err := b.Update(ctx, connect.NewRequest(&v1.UpdateSettingsRequest{Values: map[string]string{key: ""}}))
				if err != nil {
					return Result{}, err
				}
				v := res.Msg.GetSettings().GetValues()[key]
				return Result{Message: fmt.Sprintf("%s = %q (default)%s", key, v, restartNote(f)), JSON: SettingValue{Key: key, Value: v, Default: f.GetDefaultValue()}}, nil
			},
		},
		Command{
			Name:        "settings.path",
			Title:       "Settings File Path",
			Description: "Print the settings file's path.",
			Category:    "Settings",
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
			Title:       "Reveal Settings File",
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
		Command{
			Name:        "view.settings",
			Title:       "Open Settings",
			Description: "Open the settings page in every connected window.",
			Category:    "View",
			Keybindings: []string{"cmd+,"},
			Run:         func(context.Context, Context, Args) (Result, error) { return show(ViewSettings), nil },
		},
		Command{
			Name:        "view.help",
			Title:       "Keyboard Shortcuts and Help",
			Description: "Show keybindings and how the app works in every connected window.",
			Category:    "View",
			Keybindings: []string{"cmd+/"},
			Run:         func(context.Context, Context, Args) (Result, error) { return show(ViewHelp), nil },
		},
	)
}
