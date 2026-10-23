package command

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/theme"
)

// theme.ask (docs/notes/theme-model-flow.md): "Ask the model" on the Themes page. It
// starts a no-project thread (cwd $HOME) whose first message is the user's description
// after one sentence of context, and focuses it; the model saves and applies the theme
// with theme.save, whose card and toast follow. --pair asks for the other scheme's pair
// of one of the user's themes (the editor's "Also make a light pair").

// ThemeAskDeps are theme.ask's dependencies.
type ThemeAskDeps struct {
	// Thread starts the thread. Nil: Unimplemented.
	Thread ThreadBackend
	// Settings names the current slots in the prompt. Required.
	Settings SettingsBackend
	// Themes is the user's themes (--pair's ids); nil: --pair is refused.
	Themes ThemeBackend
	// Emitter focuses the new thread. Required.
	Emitter Emitter
}

// MaxThemeAskBytes bounds the description.
const MaxThemeAskBytes = 4 << 10

// ThemeAskPrompt is the new thread's first message: the user's words, then one sentence
// of context (where the user is, the current slots, what to do). The words come first so
// the thread's provisional name (its first line, until the naming model names it) is
// theirs, and the message reads as theirs in the conversation.
func ThemeAskPrompt(onPage bool, dark, light theme.Theme, ask string) string {
	where := "The user wants this as a colour theme for Code Foundry"
	if onPage {
		where = "The user asked for this on the Themes page"
	}
	return fmt.Sprintf("%s\n\n(%s; the current dark theme is %s (%s) and light theme is %s (%s). "+
		"Make the theme they describe, save it with `code-foundry theme save --data - --apply`, and keep refining it in this thread "+
		"(the code-foundry skill: Making a theme).)", ask, where, dark.Name, dark.ID, light.Name, light.ID)
}

// ThemePairAsk is --pair's request: the other scheme's pair of f.
func ThemePairAsk(f theme.File) string {
	other := theme.SchemeLight
	if f.Scheme == theme.SchemeLight {
		other = theme.SchemeDark
	}
	return fmt.Sprintf("Make a %s pair for my theme %s (`code-foundry theme show %s` prints it): same hues, a %s scheme, "+
		"saved as %s with pair set both ways, applied as my %s theme.", other, f.ID, f.ID, other, pairID(f.ID, f.Scheme, other), other)
}

// pairID is the id a pair of id gets: its scheme word swapped ("ocean-dark" →
// "ocean-light"), else the other scheme appended ("ocean-dusk" → "ocean-dusk-light").
func pairID(id, scheme, other string) string {
	if base, ok := strings.CutSuffix(id, "-"+scheme); ok && base != "" {
		return base + "-" + other
	}
	return id + "-" + other
}

// RegisterThemeAsk registers theme.ask.
func RegisterThemeAsk(r *Registry, d ThemeAskDeps) error {
	if d.Emitter == nil || d.Settings == nil {
		return errors.New("register theme.ask: Emitter and Settings are required")
	}
	if d.Thread == nil {
		d.Thread = codefoundryv1connect.UnimplementedThreadServiceHandler{}
	}
	userIDs := func() []string {
		if d.Themes == nil {
			return nil
		}
		snap := d.Themes.Snapshot()
		ids := make([]string, len(snap.Themes))
		for i, f := range snap.Themes {
			ids[i] = f.ID
		}
		return ids
	}
	set := func() theme.Set {
		if d.Themes == nil {
			return theme.Set{}
		}
		return d.Themes.Snapshot().Set()
	}
	return r.Register(Command{
		Name:  "theme.ask",
		Title: "Ask the Model for a Theme…",
		Description: "Start a thread that makes the colour theme you describe: the model saves and applies it, and the thread shows it as a card " +
			"with Undo and Edit. Keep refining it there. --pair asks for the other scheme's pair of one of your themes.",
		Category: "Settings",
		Args: []ArgSpec{
			{Name: "description", Type: String, Positional: true, Description: "The theme, in your words (\"warm dark, teal accent, quieter sidebar\")"},
			{Name: "pair", Type: Enum, EnumFunc: userIDs, Description: "One of your themes: ask for its pair of the other scheme (the description is optional then)"},
			{Name: "model", Type: Enum, Enum: ThreadModels, Description: threadModelHelp + " (default: settings threads.default_model, else Claude's default)"},
			{Name: "effort", Type: Enum, Enum: ThreadEfforts, Description: "Effort level (default: settings threads.default_effort, else Claude's default)"},
			{Name: "permission", Type: Enum, Enum: ThreadPermissions, Default: "auto", Description: "Permission mode, as thread new's"},
		},
		Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
			ask := strings.TrimSpace(a.String("description"))
			if id := a.String("pair"); id != "" {
				if d.Themes == nil {
					return Result{}, connect.NewError(connect.CodeUnimplemented, errors.New("this daemon has no user themes"))
				}
				f, user, err := d.Themes.Get(id)
				switch {
				case err != nil:
					return Result{}, themeErr("pair", err)
				case !user:
					return Result{}, InvalidArg("pair", "%q is a curated theme; copy it first (theme duplicate %s)", id, id)
				}
				ask = strings.TrimSpace(ThemePairAsk(f) + "\n\n" + ask)
			}
			switch {
			case ask == "":
				return Result{}, InvalidArg("description", "describe the theme (or give --pair)")
			case len(ask) > MaxThemeAskBytes:
				return Result{}, InvalidArg("description", "is %d bytes; keep it under %d", len(ask), MaxThemeAskBytes)
			}
			res, err := d.Settings.Get(ctx, connect.NewRequest(&v1.GetSettingsRequest{}))
			if err != nil {
				return Result{}, wrapStep("read the theme settings", err)
			}
			vals, s := res.Msg.GetSettings().GetValues(), set()
			slot := func(scheme string) theme.Theme {
				if t, ok := s.ByID(vals[themeSlotKey[scheme]]); ok {
					return t
				}
				t, _ := s.ByID(theme.Default(scheme))
				return t
			}
			// The Themes page's Ask the model and its save modal send the page as the view.
			prompt := ThemeAskPrompt(uctx.ActiveView == ViewThemes, slot(theme.SchemeDark), slot(theme.SchemeLight), ask)
			created, err := d.Thread.Create(ctx, connect.NewRequest(&v1.CreateThreadRequest{
				NoProject: true, Model: a.String("model"), Effort: a.String("effort"),
				PermissionMode: threadPermissionModes[a.String("permission")], InitialPrompt: prompt,
				ModelDefaulted:  a.String("model") != "" && !a.Given("model"),
				EffortDefaulted: a.String("effort") != "" && !a.Given("effort"),
			}))
			if err != nil {
				return Result{}, wrapStep("start thread", err)
			}
			th := created.Msg.GetThread()
			d.Emitter.Emit(&v1.UiIntent{Intent: &v1.UiIntent_FocusThread_{FocusThread: &v1.UiIntent_FocusThread{ThreadId: th.GetId()}}})
			return Result{Message: fmt.Sprintf("started thread %s to make the theme (no project)", threadLabel(th)), JSON: th}, nil
		},
	})
}
