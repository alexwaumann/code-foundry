package command

import (
	"context"
	"errors"
	"fmt"
	"os"
	"slices"
	"strings"
	"time"

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
	// Restore puts back a kept version of a user theme (a card's Undo).
	Restore(id, version string) (usertheme.Saved, error)
	Delete(id string) (theme.File, error)
	// DeleteFile removes a file that did not load, by its name or the id of its name.
	DeleteFile(name string) (usertheme.Issue, error)
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
	Scheme string `json:"scheme"`
	// Showing is the scheme the app shows now (system resolved by the window; "" while
	// unknown).
	Showing string           `json:"showing,omitempty"`
	Dark    string           `json:"dark"`
	Light   string           `json:"light"`
	Themes  []ThemeListEntry `json:"themes"`
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
	// Contrast is the app's check of the file as written (docs/notes/theme-followups.md).
	Contrast ThemeCheck `json:"contrast"`
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

// ThemeDeps are the theme.* commands' dependencies.
type ThemeDeps struct {
	// Settings holds the slots (appearance.theme_dark / theme_light). Required.
	Settings SettingsBackend
	// Themes is the user's theme files; nil: the catalog only.
	Themes ThemeBackend
	// Cards puts a theme card in the thread a theme.save runs from
	// (docs/notes/theme-model-flow.md); nil: no card.
	Cards ThemeCardShower
	// Emitter shows the toast for a theme a thread applied, and counts the app windows
	// that could report on a saved theme's contrast; nil: none.
	Emitter Emitter
	// Reports is the GUI's contrast reports on the user's themes (theme.Reports); nil:
	// theme save and theme check say nothing was checked.
	Reports ThemeReports
	// ReportWait bounds the wait for a report on a file just written; 0:
	// DefaultThemeReportWait.
	ReportWait time.Duration
	// Showing is the scheme the app's window shows now (the GUI's published theme), for
	// a "system" scheme; ok false while no window has published one. Nil: unknown.
	Showing func() (scheme string, ok bool)
}

// ThemeFileDeleted is theme.delete's JSON result for a file that did not load.
type ThemeFileDeleted struct {
	File    string `json:"file"`
	Message string `json:"message"`
}

// RegisterTheme registers the theme.* commands but theme.pick: list, set-dark,
// set-light and set-scheme (the appearance.theme_dark / theme_light / theme settings),
// and show, save, duplicate, restore and delete (the user's own themes,
// docs/notes/user-themes.md). The settings store validates a slot against the themes and
// the scheme; the slot args list the scheme's ids (the user's included, again at every
// call), so the palette offers a pick list, and a value that is not one says why (another
// scheme's, curated, gone). Without themes (nil) only the curated catalog is known and the
// user-theme verbs fail Unimplemented.
func RegisterTheme(r *Registry, d ThemeDeps) error {
	b, themes := d.Settings, d.Themes
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
	showing := func(vals map[string]string) string { return themeShowing(d, vals) }
	// setSlot writes a scheme's slot and says what it shows now.
	setSlot := func(ctx context.Context, scheme, id string) (string, ThemeSet, error) {
		key := themeSlotKey[scheme]
		res, err := b.Update(ctx, connect.NewRequest(&v1.UpdateSettingsRequest{Values: map[string]string{key: id}}))
		if err != nil {
			return "", ThemeSet{}, err
		}
		vals := res.Msg.GetSettings().GetValues()
		t, _ := set().ByID(vals[key])
		msg := fmt.Sprintf("%s theme = %s (%s)", scheme, t.Name, t.ID) + themeSchemeNote(vals[keyThemeScheme], showing(vals), scheme)
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
				EnumMiss:    func(v string) error { return set().Check(v, scheme) },
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
		},
		EnumMiss: func(v string) error { return fmt.Errorf("no theme %q (theme list prints the ids)", v) }}
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
				return themeList(vals, showing(vals), set(), themes), nil
			},
		},
		slotCmd(theme.SchemeDark),
		slotCmd(theme.SchemeLight),
		Command{
			Name:  "theme.set-scheme",
			Title: "Set Color Scheme",
			Description: "Choose whether the app is dark, light, or follows the Mac (system): the appearance.theme setting. " +
				"Each scheme shows its own theme (theme set-dark, theme set-light).",
			Category: "Settings",
			Args: []ArgSpec{{Name: "scheme", Type: Enum, Enum: []string{"system", theme.SchemeDark, theme.SchemeLight}, Required: true, Positional: true,
				Description: "system (follow the Mac), dark or light"}},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := b.Update(ctx, connect.NewRequest(&v1.UpdateSettingsRequest{Values: map[string]string{keyThemeScheme: a.String("scheme")}}))
				if err != nil {
					return Result{}, err
				}
				vals := res.Msg.GetSettings().GetValues()
				name := func(scheme string) string { return themeName(set(), vals[themeSlotKey[scheme]]) }
				msg := fmt.Sprintf("scheme = %s (%s): ", vals[keyThemeScheme], keyThemeScheme)
				if s := vals[keyThemeScheme]; s == theme.SchemeDark || s == theme.SchemeLight {
					msg += "the app shows " + name(s)
				} else {
					msg += fmt.Sprintf("the app follows the Mac: %s when dark, %s when light", name(theme.SchemeDark), name(theme.SchemeLight))
				}
				return Result{Message: msg, JSON: map[string]string{"key": keyThemeScheme, "scheme": vals[keyThemeScheme]}}, nil
			},
		},
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
			Description: "Save a theme file as one of your themes. It replaces yours with the same id (the version it replaces is kept for Undo); a curated id is refused. " +
				"From a thread, the file records the thread as created_by, and replacing a theme the thread did not make needs --replace. " +
				"--apply also makes it the dark or light theme, per its scheme.",
			Category:     "Settings",
			NoKeybinding: true,
			Args: []ArgSpec{
				{Name: "file", Type: Path, Description: "The theme file (JSON) to read"},
				{Name: "data", Type: String, FileOrStdin: true, Description: "The theme file itself, its JSON (-: stdin, @file: a file); instead of --file"},
				{Name: "apply", Type: Bool, Description: "Also set it as the dark or light theme, per its scheme"},
				{Name: "replace", Type: Bool, Description: "From a thread: replace a theme with this id that the thread did not make (once the user asked to change it)"},
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
				by := themeCaller(uctx)
				// The slots before the save: what a thread's card puts back on Undo.
				vals, verr := values(ctx)
				before := ""
				if verr == nil {
					before = vals[themeSlotKey[f.Scheme]]
				}
				// The file before it, to tell a recolour from a save that changes no colour.
				was, existed := themes.Snapshot().Get(f.ID)
				if existed {
					if err := themeSaveGuard(by, was, f, vals, a.Bool("replace"), set()); err != nil {
						return Result{}, err
					}
				}
				switch {
				case existed && by != "":
					f.CreatedBy = was.CreatedBy // who made it stays
				case by != "":
					f.CreatedBy = by
				}
				saved, err := themes.Save(f)
				if err != nil {
					return Result{}, themeErr(arg, err)
				}
				out, lines := themeSaved(saved, set())
				var applyErr error
				if a.Bool("apply") {
					msg, js, err := setSlot(ctx, saved.File.Scheme, saved.File.ID)
					if err != nil {
						applyErr = err
					} else {
						out.Applied = js.Key
						lines = append(lines, "applied: "+msg)
					}
				}
				var warnings []string
				if by != "" {
					// The card says applied when the slot shows the theme; the toast only
					// when the save changed what the slot shows: another theme, or new
					// colours. A save that only sets pair repaints nothing.
					applied := (a.Bool("apply") && applyErr == nil) || before == saved.File.ID
					repaint := before != saved.File.ID || !existed || !theme.SameColours(was, saved.File)
					undo := themeUndoOf(applied, before, was, existed, saved, set())
					warnings, _ = showThemeCard(ctx, d, by, saved.File, applied, undo, applied && repaint)
				}
				// Last, so the card and the window's repaint do not wait on it. From the
				// app (its editor) there is no wait: the editor shows the report itself.
				out.Contrast = themeCheck(ctx, d, saved.File, uctx.ActiveView == "")
				lines = slices.Insert(lines, themeContrastAt, out.Contrast.lines(false)...)
				if applyErr != nil {
					// Saved, but not applied: both, so a retry is not read as a new save.
					lines = append(append(lines, warnings...), "not applied: "+strings.TrimPrefix(connectMessage(applyErr), "invalid settings: "))
					return Result{}, Failed(errors.New(strings.Join(lines, "\n")))
				}
				return Result{Message: strings.Join(lines, "\n"), JSON: out, Warnings: warnings}, nil
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
			Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
				if err := needThemes(); err != nil {
					return Result{}, err
				}
				saved, err := themes.Duplicate(a.String("theme"), a.String("name"), themeCaller(uctx))
				if err != nil {
					return Result{}, themeErr("theme", err)
				}
				out, lines := themeSaved(saved, set())
				out.Contrast = themeCheck(ctx, d, saved.File, uctx.ActiveView == "")
				lines = slices.Insert(lines, themeContrastAt, out.Contrast.lines(false)...)
				return Result{Message: strings.Join(lines, "\n"), JSON: out}, nil
			},
		},
		Command{
			Name:  "theme.restore",
			Title: "Restore Theme Colours",
			Description: "Put back an earlier version of one of your themes: each save keeps the version it replaces (the last 10). " +
				"A theme card's Undo runs it when the save changed the colours of the theme in use.",
			Category:     "Settings",
			NoKeybinding: true,
			Args: []ArgSpec{
				{Name: "theme", Type: Enum, EnumFunc: userIDs, EnumMiss: userThemeMiss(set), Required: true, Positional: true, Description: "One of your themes' ids"},
				{Name: "version", Type: String, Required: true, Description: "The version to put back (a theme card's previous_version)"},
			},
			Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
				if err := needThemes(); err != nil {
					return Result{}, err
				}
				saved, err := themes.Restore(a.String("theme"), a.String("version"))
				if err != nil {
					return Result{}, themeErr("version", err)
				}
				out, lines := themeSaved(saved, set())
				lines[0] = fmt.Sprintf("restored %s (%s) to an earlier version", saved.File.Name, saved.File.ID)
				out.Contrast = themeCheck(ctx, d, saved.File, uctx.ActiveView == "")
				lines = slices.Insert(lines, themeContrastAt, out.Contrast.lines(false)...)
				return Result{Message: strings.Join(lines, "\n"), JSON: out}, nil
			},
		},
		themeDeleteCommand(d, values, set, setSlot),
		themeCheckCommand(d, userIDs, needThemes),
	)
}

// themeSaveGuard refuses a save over the existing theme was that would lose something: from
// a thread, a theme it did not make without --replace (theme-fuzz-daemon, model 3); and a
// change of scheme while a slot of the old scheme shows the theme (files 1: the slot would
// drop to its fallback without a word).
func themeSaveGuard(by string, was, f theme.File, vals map[string]string, replace bool, set theme.Set) error {
	if by != "" && was.CreatedBy != by && !replace {
		maker := "one the user made"
		if was.CreatedBy != "" {
			maker = "made by thread " + was.CreatedBy
		}
		return InvalidArg("replace", "%s is a theme this thread did not make (%s): save under another id, "+
			"or pass --replace once the user asked to change that theme (the version it replaces is kept for Undo)", themeName(set, was.ID), maker)
	}
	if was.Scheme != f.Scheme && vals != nil && vals[themeSlotKey[was.Scheme]] == was.ID {
		return InvalidArg("file", "%s is your %s theme; a %s theme needs another id (or first put the %s slot on another theme: theme set-%s <id>)",
			was.ID, was.Scheme, f.Scheme, was.Scheme, was.Scheme)
	}
	return nil
}

// themeUndo is what a theme card's Undo puts back: another theme (id), or this theme's
// replaced version (id is the theme's own, version set); gone when it is not there to put
// back. The zero value: no Undo.
type themeUndo struct {
	id, version string
	gone        bool
}

// themeUndoOf is the card's Undo (docs/notes/theme-fuzz-daemon.md): what the slot showed
// immediately before this save, when the save changed what it shows. A slot on another
// theme goes back to it; a slot already on this theme goes back to the colours the save
// replaced (the version the store kept); a save that changed no colour has none.
func themeUndoOf(applied bool, before string, was theme.File, existed bool, saved usertheme.Saved, set theme.Set) themeUndo {
	switch {
	case !applied || before == "":
		return themeUndo{}
	case before != saved.File.ID:
		return themeUndo{id: before, gone: !set.Valid(before, saved.File.Scheme)}
	case existed && !theme.SameColours(was, saved.File):
		return themeUndo{id: before, version: saved.PreviousVersion, gone: saved.PreviousVersion == ""}
	}
	return themeUndo{}
}

// userThemeMiss explains a value that is not one of the user's themes: a curated id to
// copy first, else an unknown one.
func userThemeMiss(set func() theme.Set) func(string) error {
	return func(v string) error {
		if t, ok := set().ByID(v); ok && !t.User {
			return fmt.Errorf("%s (%q) is a curated theme; copy it first (theme duplicate %s)", t.Name, v, v)
		}
		return fmt.Errorf("no theme %q among yours (theme list marks them)", v)
	}
}

// themeShowing is the scheme the app shows: appearance.theme, or for system what the
// window published ("" while unknown).
func themeShowing(d ThemeDeps, vals map[string]string) string {
	if s := vals[keyThemeScheme]; s == theme.SchemeDark || s == theme.SchemeLight {
		return s
	}
	if d.Showing != nil {
		if s, ok := d.Showing(); ok {
			return s
		}
	}
	return ""
}

// themeSchemeNote is what follows a slot set for a scheme the app does not show now: it
// changes nothing on screen until the scheme is that one, and the command that switches
// it. "" when it shows.
func themeSchemeNote(pref, showing, scheme string) string {
	switch {
	case showing == scheme:
		return ""
	case pref == "system" && showing == "":
		return fmt.Sprintf("; the scheme is system (the Mac's appearance decides), so it shows while the Mac is %s", scheme)
	case pref == "system":
		return fmt.Sprintf("; the scheme is system, currently %s, so nothing changes on screen until the Mac is %s (theme set-scheme %s switches the app)", showing, scheme, scheme)
	}
	return fmt.Sprintf("; the scheme is %s, so nothing changes on screen until it is %s (theme set-scheme %s switches it)", pref, scheme, scheme)
}

// connectMessage is err's message without connect's code prefix.
func connectMessage(err error) string {
	var ce *connect.Error
	if errors.As(err, &ce) {
		return ce.Message()
	}
	return err.Error()
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

// themeContrastAt is where the contrast lines go among themeSaved's: after the pinned count.
const themeContrastAt = 3

// themeSaved is a written theme's JSON and its lines: what it is, where it came from,
// how many slots it pins, and where it was written. The caller inserts the contrast check
// at themeContrastAt.
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
	lines := []string{fmt.Sprintf("%s %s (%s), a %s theme", verb, f.Name, f.ID, f.Scheme), from, pinned, "written to: " + s.Path}
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
func themeList(vals map[string]string, showing string, set theme.Set, themes ThemeBackend) Result {
	out := ThemeList{Scheme: vals[keyThemeScheme], Showing: showing, Dark: vals[keyThemeDark], Light: vals[keyThemeLight]}
	slot := map[string]string{theme.SchemeDark: out.Dark, theme.SchemeLight: out.Light}
	var sb strings.Builder
	fmt.Fprintf(&sb, "scheme: %s (%s)", out.Scheme, keyThemeScheme)
	if out.Scheme == "system" && showing != "" {
		fmt.Fprintf(&sb, ", currently %s", showing)
	}
	sb.WriteString("\n")
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
		// Not "your themes are files in …": a thread read that as leave to edit them in
		// place, which adds no card and keeps no Undo (theme-fuzz-daemon, model 2).
		sb.WriteString("\nchange one of yours with theme edit <id> (the app's editor), or save a new version with theme save " +
			"(theme show <id> prints the file to start from)\n")
		snap := themes.Snapshot()
		for _, is := range snap.Issues {
			out.Issues = append(out.Issues, ThemeFileIssue{File: is.File, Message: is.Message})
		}
		if len(out.Issues) > 0 {
			fmt.Fprintf(&sb, "not loaded (fix the file in %s, or remove it with theme delete --file <name>):\n", out.Dir)
			for _, is := range out.Issues {
				fmt.Fprintf(&sb, "  %s: %s\n", is.File, is.Message)
			}
		}
	}
	return Result{Message: strings.TrimRight(sb.String(), "\n"), JSON: out}
}
