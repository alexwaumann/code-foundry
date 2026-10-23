package command

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/usertheme"
	"github.com/alexwaumann/code-foundry/internal/theme"
)

// The theme settings (internal/store/settings, which imports this package, so the keys
// are repeated here): the scheme and the theme of each scheme.
const (
	keyThemeScheme = "appearance.theme"
	keyThemeDark   = "appearance.theme_dark"
	keyThemeLight  = "appearance.theme_light"
)

// themeSlotKey is each scheme's setting.
var themeSlotKey = map[string]string{theme.SchemeDark: keyThemeDark, theme.SchemeLight: keyThemeLight}

// ThemeBackend is the user's own themes, the theme files in the themes directory
// (docs/notes/user-themes.md), as the theme.* commands read and write them.
// *usertheme.Store implements it.
type ThemeBackend interface {
	// Dir is the themes directory.
	Dir() string
	Snapshot() *usertheme.Snapshot
	// Get returns a user theme (user true) or a curated one.
	Get(id string) (f theme.File, user bool, err error)
	Save(f theme.File) (usertheme.Saved, error)
	Duplicate(id, name, createdBy string) (usertheme.Saved, error)
	Delete(id string) (theme.File, error)
}

var _ ThemeBackend = (*usertheme.Store)(nil)

// ThemeListEntry is one theme in theme.list's JSON result.
type ThemeListEntry struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Scheme string `json:"scheme"`
	Pair   string `json:"pair,omitempty"`
	// User is true for one of the user's own themes; From is the theme it was copied
	// from and CreatedBy the thread that wrote it ("" when the user did or it is unknown).
	User      bool   `json:"user"`
	From      string `json:"from,omitempty"`
	CreatedBy string `json:"created_by,omitempty"`
	// Selected is true for the theme in its scheme's slot.
	Selected bool `json:"selected"`
}

// ThemeFileIssue is a file in the themes directory that is not a theme the app can use.
type ThemeFileIssue struct {
	File    string `json:"file"`
	Message string `json:"message"`
}

// ThemeList is theme.list's JSON result.
type ThemeList struct {
	// Scheme is appearance.theme: system, dark, or light.
	Scheme string           `json:"scheme"`
	Dark   string           `json:"dark"`
	Light  string           `json:"light"`
	Themes []ThemeListEntry `json:"themes"`
	// Dir is the themes directory; Issues its files that did not load.
	Dir    string           `json:"dir,omitempty"`
	Issues []ThemeFileIssue `json:"issues,omitempty"`
}

// ThemeSet is theme.set-dark's and theme.set-light's JSON result.
type ThemeSet struct {
	Key    string `json:"key"`
	ID     string `json:"id"`
	Name   string `json:"name"`
	Scheme string `json:"scheme"`
}

// ThemeSaved is theme.save's and theme.duplicate's JSON result.
type ThemeSaved struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Scheme    string `json:"scheme"`
	From      string `json:"from,omitempty"`
	CreatedBy string `json:"created_by,omitempty"`
	// Pinned is how many slots the file overrides.
	Pinned int `json:"pinned"`
	// Path is the file written; Replaced is true when the id was there before.
	Path     string `json:"path"`
	Replaced bool   `json:"replaced"`
	// Applied is the setting --apply wrote ("" without it).
	Applied string `json:"applied,omitempty"`
}

// ThemeDeleted is theme.delete's JSON result: the theme, and the slots that named it
// with the theme each shows now.
type ThemeDeleted struct {
	ID     string            `json:"id"`
	Name   string            `json:"name"`
	Scheme string            `json:"scheme"`
	Slots  map[string]string `json:"slots,omitempty"`
}

// themeCaller is the thread a theme write comes from: the CLI's thread
// ($CODE_FOUNDRY_THREAD; ActiveView is empty only there), "" for the user's own terminal
// or the GUI.
func themeCaller(uctx Context) string {
	if uctx.ActiveView != "" {
		return ""
	}
	return uctx.CallerThreadID
}

// themeErr maps the store's errors onto the command's.
func themeErr(arg string, err error) error {
	switch {
	case connect.CodeOf(err) != connect.CodeUnknown:
		return err
	case errors.Is(err, theme.ErrInvalid):
		return InvalidArg(arg, "the theme does not validate: %s", strings.TrimPrefix(err.Error(), theme.ErrInvalid.Error()+": "))
	case errors.Is(err, usertheme.ErrCurated):
		return InvalidArg(arg, "%s", strings.TrimPrefix(err.Error(), usertheme.ErrCurated.Error()+": "))
	case errors.Is(err, usertheme.ErrNotFound):
		return connect.NewError(connect.CodeNotFound, err)
	}
	return Failed(err)
}

// RegisterTheme registers the theme.* commands but theme.pick: list, set-dark and
// set-light (the appearance.theme_dark / theme_light settings), and show, save, duplicate
// and delete (the user's own themes, docs/notes/user-themes.md). The settings store
// validates a slot against the themes and the scheme; the slot args list the scheme's
// ids (the user's included, again at every call), so the palette offers a pick list and
// the CLI refuses another scheme's theme before sending. Without themes (nil) only the
// curated catalog is known and the user-theme verbs fail Unimplemented.
func RegisterTheme(r *Registry, b SettingsBackend, themes ThemeBackend) error {
	values := func(ctx context.Context) (map[string]string, error) {
		res, err := b.Get(ctx, connect.NewRequest(&v1.GetSettingsRequest{}))
		if err != nil {
			return nil, err
		}
		return res.Msg.GetSettings().GetValues(), nil
	}
	set := func() theme.Set {
		if themes == nil {
			return theme.Set{}
		}
		return themes.Snapshot().Set()
	}
	needThemes := func() error {
		if themes == nil {
			return connect.NewError(connect.CodeUnimplemented, errors.New("this daemon has no user themes"))
		}
		return nil
	}
	// setSlot writes a scheme's slot and says what it shows now.
	setSlot := func(ctx context.Context, scheme, id string) (string, ThemeSet, error) {
		key := themeSlotKey[scheme]
		res, err := b.Update(ctx, connect.NewRequest(&v1.UpdateSettingsRequest{Values: map[string]string{key: id}}))
		if err != nil {
			return "", ThemeSet{}, err
		}
		vals := res.Msg.GetSettings().GetValues()
		t, _ := set().ByID(vals[key])
		msg := fmt.Sprintf("%s theme = %s (%s)", scheme, t.Name, t.ID)
		if s := vals[keyThemeScheme]; s != "system" && s != scheme {
			msg += fmt.Sprintf("; the scheme is %s, so it shows after `code-foundry settings set %s %s`", s, keyThemeScheme, scheme)
		}
		return msg, ThemeSet{Key: key, ID: t.ID, Name: t.Name, Scheme: t.Scheme}, nil
	}
	slotCmd := func(scheme string) Command {
		title := strings.ToUpper(scheme[:1]) + scheme[1:]
		return Command{
			Name:        "theme.set-" + scheme,
			Title:       "Set " + title + " Theme",
			Description: fmt.Sprintf("Choose the theme used when the scheme is %s (the %s setting): a curated one or one of yours. Run theme list for the ids.", scheme, themeSlotKey[scheme]),
			Category:    "Settings",
			Args: []ArgSpec{{Name: "theme", Type: Enum, EnumFunc: func() []string { return set().IDs(scheme) }, Required: true, Positional: true,
				Description: "A " + scheme + " theme id, e.g. " + theme.Default(scheme)}},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				msg, js, err := setSlot(ctx, scheme, a.String("theme"))
				if err != nil {
					return Result{}, err
				}
				return Result{Message: msg, JSON: js}, nil
			},
		}
	}
	anyTheme := ArgSpec{Name: "theme", Type: Enum, Required: true, Positional: true,
		EnumFunc: func() []string {
			ts := set().Themes()
			ids := make([]string, len(ts))
			for i, t := range ts {
				ids[i] = t.ID
			}
			return ids
		}}
	return r.RegisterAll(
		Command{
			Name:         "theme.list",
			Title:        "List Themes",
			Description:  "Print every colour theme by scheme, yours first, marking the ones in use. Yours show the theme each was copied from.",
			Category:     "Settings",
			NoKeybinding: true,
			Run: func(ctx context.Context, _ Context, _ Args) (Result, error) {
				vals, err := values(ctx)
				if err != nil {
					return Result{}, err
				}
				return themeList(vals, set(), themes), nil
			},
		},
		slotCmd(theme.SchemeDark),
		slotCmd(theme.SchemeLight),
		Command{
			Name:         "theme.show",
			Title:        "Show Theme File",
			Description:  "Print a theme's file (curated or yours) as JSON. It is the format theme save reads.",
			Category:     "Settings",
			NoKeybinding: true,
			Args:         []ArgSpec{withDescription(anyTheme, "A theme id (theme list prints them)")},
			Run: func(_ context.Context, _ Context, a Args) (Result, error) {
				if err := needThemes(); err != nil {
					return Result{}, err
				}
				f, _, err := themes.Get(a.String("theme"))
				if err != nil {
					return Result{}, themeErr("theme", err)
				}
				return Result{Message: strings.TrimRight(string(f.Marshal()), "\n"), JSON: f}, nil
			},
		},
		Command{
			Name:  "theme.save",
			Title: "Save Theme File",
			Description: "Save a theme file as one of your themes. It replaces yours with the same id; a curated id is refused. " +
				"From a thread, the file records the thread as created_by. --apply also makes it the dark or light theme, per its scheme.",
			Category:     "Settings",
			NoKeybinding: true,
			Args: []ArgSpec{
				{Name: "file", Type: Path, Description: "The theme file (JSON) to read"},
				{Name: "data", Type: String, FileOrStdin: true, Description: "The theme file itself, its JSON (-: stdin, @file: a file); instead of --file"},
				{Name: "apply", Type: Bool, Description: "Also set it as the dark or light theme, per its scheme"},
			},
			Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
				if err := needThemes(); err != nil {
					return Result{}, err
				}
				data, arg, err := themeInput(a)
				if err != nil {
					return Result{}, err
				}
				f, err := theme.ParseFile(data)
				if err != nil {
					return Result{}, themeErr(arg, err)
				}
				if by := themeCaller(uctx); by != "" {
					f.CreatedBy = by
				}
				saved, err := themes.Save(f)
				if err != nil {
					return Result{}, themeErr(arg, err)
				}
				out, lines := themeSaved(saved, set())
				if a.Bool("apply") {
					msg, js, err := setSlot(ctx, saved.File.Scheme, saved.File.ID)
					if err != nil {
						return Result{Message: strings.Join(lines, "\n")}, err
					}
					out.Applied = js.Key
					lines = append(lines, "applied: "+msg)
				}
				return Result{Message: strings.Join(lines, "\n"), JSON: out}, nil
			},
		},
		Command{
			Name:  "theme.duplicate",
			Title: "Duplicate Theme",
			Description: "Copy a theme into your themes, to change it. The copy's id is <id>-copy (then -2, ...) and it records the theme it came from; " +
				"print its file with theme show and save the changed file with theme save.",
			Category: "Settings",
			Args: []ArgSpec{
				withDescription(anyTheme, "The theme to copy (theme list prints the ids)"),
				{Name: "name", Type: String, Description: "The copy's name (default: \"<name> copy\")"},
			},
			Run: func(_ context.Context, uctx Context, a Args) (Result, error) {
				if err := needThemes(); err != nil {
					return Result{}, err
				}
				saved, err := themes.Duplicate(a.String("theme"), a.String("name"), themeCaller(uctx))
				if err != nil {
					return Result{}, themeErr("theme", err)
				}
				out, lines := themeSaved(saved, set())
				return Result{Message: strings.Join(lines, "\n"), JSON: out}, nil
			},
		},
		Command{
			Name:         "theme.delete",
			Title:        "Delete Theme",
			Description:  "Delete one of your themes. A slot that used it shows the theme it was copied from, else the default.",
			Category:     "Settings",
			Args:         []ArgSpec{{Name: "theme", Type: String, Required: true, Positional: true, Description: "One of your themes' ids (theme list marks them)"}},
			Confirm:      "Delete the theme {theme}? Its file in the themes directory is removed.",
			ConfirmLabel: "Delete",
			DynamicConfirm: func(ctx context.Context, _ Context, a Args) string {
				if themes == nil {
					return ""
				}
				f, user, err := themes.Get(a.String("theme"))
				if err != nil || !user {
					return ""
				}
				msg := fmt.Sprintf("Delete the theme %s? Its file in the themes directory is removed.", f.Name)
				if vals, err := values(ctx); err == nil && vals[themeSlotKey[f.Scheme]] == f.ID {
					next := themeAfterDelete(set(), f)
					msg += fmt.Sprintf(" It is your %s theme; the %s theme becomes %s.", f.Scheme, f.Scheme, next.Name)
				}
				return msg
			},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				if err := needThemes(); err != nil {
					return Result{}, err
				}
				id := a.String("theme")
				f, user, err := themes.Get(id)
				switch {
				case err != nil:
					return Result{}, themeErr("theme", err)
				case !user:
					return Result{}, InvalidArg("theme", "%q is a curated theme; only your own themes can be deleted", id)
				}
				vals, err := values(ctx)
				if err != nil {
					return Result{}, err
				}
				out := ThemeDeleted{ID: f.ID, Name: f.Name, Scheme: f.Scheme}
				lines := []string{fmt.Sprintf("deleted %s (%s)", f.Name, f.ID)}
				// The slot moves first, so the settings never name a theme that is gone.
				if key := themeSlotKey[f.Scheme]; vals[key] == f.ID {
					next := themeAfterDelete(set(), f)
					msg, js, err := setSlot(ctx, f.Scheme, next.ID)
					if err != nil {
						return Result{}, fmt.Errorf("move the %s theme off %s first: %w", f.Scheme, f.ID, err)
					}
					out.Slots = map[string]string{key: js.ID}
					lines = append(lines, "now "+msg)
				}
				if _, err := themes.Delete(id); err != nil {
					return Result{}, themeErr("theme", err)
				}
				return Result{Message: strings.Join(lines, "\n"), JSON: out}, nil
			},
		},
	)
}

func withDescription(a ArgSpec, d string) ArgSpec {
	a.Description = d
	return a
}

// themeAfterDelete is what a slot naming f shows once f is deleted: the theme it was
// copied from (or that one's), else the scheme's default.
func themeAfterDelete(s theme.Set, f theme.File) theme.Theme {
	after := s.Without(f.ID)
	id := after.Fallback(f.ID, f.Scheme)
	if id == "" {
		id = theme.Default(f.Scheme)
	}
	t, _ := after.ByID(id)
	return t
}

// themeInput is theme.save's file: --file's contents or --data's text, exactly one of
// them, and the arg it came from.
func themeInput(a Args) ([]byte, string, error) {
	path, text := a.String("file"), a.String("data")
	switch {
	case path != "" && text != "":
		return nil, "", InvalidArg("data", "give --file or --data, not both")
	case path == "" && text == "":
		return nil, "", InvalidArg("file", "give the theme file: --file <path>, or --data - to read it from stdin")
	case text != "":
		return []byte(text), "data", nil
	}
	fi, err := os.Stat(path)
	switch {
	case err != nil:
		return nil, "", InvalidArg("file", "%v", err)
	case !fi.Mode().IsRegular():
		return nil, "", InvalidArg("file", "%s is not a file", path)
	case fi.Size() > theme.MaxFileBytes:
		return nil, "", InvalidArg("file", "%s is more than %d KiB", path, theme.MaxFileBytes>>10)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, "", InvalidArg("file", "%v", err)
	}
	return data, "file", nil
}

// themeSaved is a written theme's JSON and its lines: what it is, where it came from,
// how many slots it pins, and where it was written.
func themeSaved(s usertheme.Saved, set theme.Set) (ThemeSaved, []string) {
	f := s.File
	out := ThemeSaved{ID: f.ID, Name: f.Name, Scheme: f.Scheme, From: f.From, CreatedBy: f.CreatedBy, Pinned: f.Pinned(), Path: s.Path, Replaced: s.Replaced}
	verb := "saved"
	if s.Replaced {
		verb = "replaced"
	}
	from := "from: nothing (made from scratch)"
	if f.From != "" {
		from = "from: " + themeName(set, f.From)
	}
	pinned := fmt.Sprintf("pinned: %d slots", f.Pinned())
	if f.Pinned() == 1 {
		pinned = "pinned: 1 slot"
	}
	// The daemon derives no colours (the rules are the GUI's, src/themes/slots.ts), so it
	// cannot say which pairs fall short or which pins the base has moved; the editor does.
	contrast := fmt.Sprintf("contrast: checked in the editor (theme edit %s shows failing pairs and stale pins)", f.ID)
	lines := []string{fmt.Sprintf("%s %s (%s), a %s theme", verb, f.Name, f.ID, f.Scheme), from, pinned, contrast, "written to: " + s.Path}
	return out, lines
}

// themeName is "Name (id)", or the id alone for a theme the set does not have.
func themeName(s theme.Set, id string) string {
	if t, ok := s.ByID(id); ok {
		return fmt.Sprintf("%s (%s)", t.Name, id)
	}
	return id + " (not a theme now)"
}

// themeList is theme.list's result: the scheme, then each scheme's themes, the user's
// first (marked, with the theme each came from), then the files that did not load.
func themeList(vals map[string]string, set theme.Set, themes ThemeBackend) Result {
	out := ThemeList{Scheme: vals[keyThemeScheme], Dark: vals[keyThemeDark], Light: vals[keyThemeLight]}
	slot := map[string]string{theme.SchemeDark: out.Dark, theme.SchemeLight: out.Light}
	var sb strings.Builder
	fmt.Fprintf(&sb, "scheme: %s (%s)\n", out.Scheme, keyThemeScheme)
	for _, scheme := range []string{theme.SchemeDark, theme.SchemeLight} {
		fmt.Fprintf(&sb, "\n%s themes (%s):\n", scheme, themeSlotKey[scheme])
		ts := set.For(scheme)
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
			line := fmt.Sprintf("%s %-*s  %s", mark, w, t.ID, t.Name)
			if t.User {
				tag := "yours"
				if t.From != "" {
					tag += ", from " + t.From
				}
				if t.CreatedBy != "" {
					tag += ", by thread " + t.CreatedBy
				}
				line += "  [" + tag + "]"
			}
			sb.WriteString(line + "\n")
			out.Themes = append(out.Themes, ThemeListEntry{ID: t.ID, Name: t.Name, Scheme: t.Scheme, Pair: t.Pair, User: t.User, From: t.From, CreatedBy: t.CreatedBy, Selected: sel})
		}
	}
	if themes != nil {
		out.Dir = themes.Dir()
		fmt.Fprintf(&sb, "\nyour themes are files in %s (theme show <id> prints one)\n", out.Dir)
		snap := themes.Snapshot()
		for _, is := range snap.Issues {
			out.Issues = append(out.Issues, ThemeFileIssue{File: is.File, Message: is.Message})
		}
		if len(out.Issues) > 0 {
			fmt.Fprintf(&sb, "not loaded (fix the file, or delete it):\n")
			for _, is := range out.Issues {
				fmt.Fprintf(&sb, "  %s: %s\n", is.File, is.Message)
			}
		}
	}
	return Result{Message: strings.TrimRight(sb.String(), "\n"), JSON: out}
}
