package command

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"connectrpc.com/connect"

	"github.com/alexwaumann/code-foundry/internal/theme"
)

// themeDeleteCommand is theme.delete: one of the user's themes (a slot on it moves first
// to its fallback, and back if the file cannot be removed), or a file in the themes
// directory that did not load (--file, or the id of its name; docs/notes/theme-fuzz-daemon.md).
// Only those ask first: a curated or unknown id is refused without a confirmation.
func themeDeleteCommand(d ThemeDeps, values func(context.Context) (map[string]string, error), set func() theme.Set,
	setSlot func(context.Context, string, string) (string, ThemeSet, error)) Command {
	themes := d.Themes
	// target is what a call names: a user theme, a file that did not load, or neither.
	type target struct {
		theme theme.File
		file  string // a file that did not load
		why   string // its reason
	}
	resolve := func(a Args) (target, bool) {
		if themes == nil {
			return target{}, false
		}
		name := a.String("file")
		if name == "" {
			id := a.String("theme")
			if f, user, err := themes.Get(id); err == nil && user {
				return target{theme: f}, true
			}
			name = id
		}
		if is, ok := themes.Snapshot().Issue(name); ok {
			return target{file: is.File, why: is.Message}, true
		}
		return target{}, false
	}
	return Command{
		Name:  "theme.delete",
		Title: "Delete Theme",
		Description: "Delete one of your themes. A slot that used it shows the theme it was copied from, else the default. " +
			"--file removes a file of the themes directory that did not load (theme list names them).",
		Category: "Settings",
		Args: []ArgSpec{
			{Name: "theme", Type: String, Positional: true, Description: "One of your themes' ids (theme list marks them)"},
			{Name: "file", Type: String, Description: "A file in the themes directory that did not load, by its name (theme list's \"not loaded\")"},
		},
		Confirm:      "Delete the theme {theme}? Its file in the themes directory is removed.",
		ConfirmLabel: "Delete",
		ConfirmIf: func(_ context.Context, _ Context, a Args) bool {
			_, ok := resolve(a)
			return ok
		},
		DynamicConfirm: func(ctx context.Context, _ Context, a Args) string {
			t, ok := resolve(a)
			switch {
			case !ok:
				return ""
			case t.file != "":
				return fmt.Sprintf("Delete the file %s from the themes directory? It did not load: %s.", t.file, strings.TrimSuffix(t.why, "."))
			}
			f := t.theme
			msg := fmt.Sprintf("Delete the theme %s? Its file in the themes directory is removed.", f.Name)
			if vals, err := values(ctx); err == nil && vals[themeSlotKey[f.Scheme]] == f.ID {
				next := themeAfterDelete(set(), f)
				msg += fmt.Sprintf(" It is your %s theme; the %s theme becomes %s.", f.Scheme, f.Scheme, next.Name)
			}
			return msg
		},
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			if themes == nil {
				return Result{}, connect.NewError(connect.CodeUnimplemented, errors.New("this daemon has no user themes"))
			}
			id, file := a.String("theme"), a.String("file")
			switch {
			case id != "" && file != "":
				return Result{}, InvalidArg("file", "give a theme id or --file, not both")
			case id == "" && file == "":
				return Result{}, InvalidArg("theme", "give one of your themes' ids, or --file <name> for a file that did not load")
			}
			t, ok := resolve(a)
			switch {
			case !ok && file != "":
				return Result{}, InvalidArg("file", "no file %q among those that did not load (theme list names them)", file)
			case !ok:
				if _, user, err := themes.Get(id); err == nil && !user {
					return Result{}, InvalidArg("theme", "%q is a curated theme; only your own themes can be deleted", id)
				}
				return Result{}, InvalidArg("theme", "no theme %q among yours (theme list marks them)", id)
			case t.file != "":
				is, err := themes.DeleteFile(t.file)
				if err != nil {
					return Result{}, themeErr("file", err)
				}
				return Result{Message: fmt.Sprintf("deleted the file %s (it did not load: %s)", is.File, is.Message),
					JSON: ThemeFileDeleted{File: is.File, Message: is.Message}}, nil
			}
			f := t.theme
			vals, err := values(ctx)
			if err != nil {
				return Result{}, err
			}
			out := ThemeDeleted{ID: f.ID, Name: f.Name, Scheme: f.Scheme}
			lines := []string{fmt.Sprintf("deleted %s (%s)", f.Name, f.ID)}
			// The slot moves first, so the settings never name a theme that is gone.
			key := themeSlotKey[f.Scheme]
			moved := vals[key] == f.ID
			if moved {
				next := themeAfterDelete(set(), f)
				msg, js, err := setSlot(ctx, f.Scheme, next.ID)
				if err != nil {
					return Result{}, fmt.Errorf("move the %s theme off %s first: %w", f.Scheme, f.ID, err)
				}
				out.Slots = map[string]string{key: js.ID}
				lines = append(lines, "now "+msg)
			}
			if _, err := themes.Delete(f.ID); err != nil {
				// Still there: the slot goes back on it.
				if !moved {
					return Result{}, Failed(fmt.Errorf("%s (%s) is not deleted: %w", f.Name, f.ID, err))
				}
				if _, _, berr := setSlot(ctx, f.Scheme, f.ID); berr != nil {
					return Result{}, Failed(fmt.Errorf("%s (%s) is not deleted (%w), and the %s theme could not go back on it: %w", f.Name, f.ID, err, f.Scheme, berr))
				}
				return Result{}, Failed(fmt.Errorf("%s (%s) is not deleted, so the %s theme is back on it: %w", f.Name, f.ID, f.Scheme, err))
			}
			return Result{Message: strings.Join(lines, "\n"), JSON: out}, nil
		},
	}
}
