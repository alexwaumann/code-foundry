package command

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/theme"
)

// theme.ask (docs/notes/theme-model-flow.md): "Ask the model" on the Themes page. It
// starts a no-project thread (cwd $HOME) whose first message is the user's description,
// with the context in the thread's own system prompt append (docs/notes/theme-followups.md),
// and focuses it; the model saves and applies the theme with theme.save, whose card and
// toast follow. --pair asks for the other scheme's pair of one of the user's themes (the
// editor's "Also make a light pair").

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

// ThemeAskContext is the new thread's own system prompt append (CreateThreadRequest.
// system_prompt_append): where the user asked, the current slots, what to do and, for a
// pair, which theme to pair and the free id to save it as. It stays out of the first
// message, which is the user's words alone, so the bubble and the provisional name (the
// first line, until the naming model names the thread) are theirs.
func ThemeAskContext(onPage bool, dark, light theme.Theme, pair *theme.File, pairID string) string {
	where := "The user wants a colour theme for Code Foundry"
	if onPage {
		where = "The user asked for a colour theme on Code Foundry's Themes page (Ask the model)"
	}
	ctx := fmt.Sprintf("%s; their first message in this thread describes it. The current dark theme is %s (%s) and the light theme is %s (%s). "+
		"Make the theme they describe, save it with `code-foundry theme save --file <path> --apply`, and keep refining it in this thread "+
		"(the code-foundry skill: Making a theme).", where, dark.Name, dark.ID, light.Name, light.ID)
	if pair != nil {
		ctx += " " + ThemePairAsk(*pair, pairID)
	}
	return ctx
}

// ThemeAskMessage is the first message: the user's words; for a pair, a line in their
// voice naming the theme first.
func ThemeAskMessage(ask string, pair *theme.File) string {
	if pair == nil {
		return ask
	}
	return strings.TrimSpace(fmt.Sprintf("Make a %s pair for my theme %s.", otherScheme(pair.Scheme), pair.Name) + "\n\n" + ask)
}

// ThemePairAsk is --pair's instruction: the other scheme's pair of f, saved as pairID (an
// id no theme has: FreePairID), and f saved again with pair set, which needs --replace
// when the thread did not make f (the user asked for it).
func ThemePairAsk(f theme.File, pairID string) string {
	other := otherScheme(f.Scheme)
	return fmt.Sprintf("They want a %s pair for their theme %s (`code-foundry theme show %s` prints it): same hues, a %s scheme, "+
		"saved as %s (no theme has that id yet), applied as their %s theme; then save %s again with \"pair\": \"%s\" (with --replace: they asked for it) "+
		"and give the new one \"pair\": \"%s\".", other, f.ID, f.ID, other, pairID, other, f.ID, pairID, f.ID)
}

func otherScheme(scheme string) string {
	if scheme == theme.SchemeLight {
		return theme.SchemeDark
	}
	return theme.SchemeLight
}

// FreePairID is the id a pair of id gets: its scheme word swapped ("ocean-dark" →
// "ocean-light"), else the other scheme appended ("ocean-dusk" → "ocean-dusk-light"); when
// that is taken (a theme of the user's, a curated id, a file that did not load) or too
// long, "-2", "-3"… on a stem cut to fit (theme-fuzz-daemon, files 13 / model 3).
func FreePairID(id, scheme string, taken func(string) bool) string {
	stem := id + "-" + otherScheme(scheme)
	if base, ok := strings.CutSuffix(id, "-"+scheme); ok && base != "" {
		stem = base + "-" + otherScheme(scheme)
	}
	for n := 1; ; n++ {
		suffix := ""
		if n > 1 {
			suffix = "-" + strconv.Itoa(n)
		}
		c := strings.TrimRight(stem[:min(len(stem), theme.MaxIDLen-len(suffix))], "-") + suffix
		if theme.ValidID(c) && !taken(c) {
			return c
		}
	}
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
			{Name: "pair", Type: Enum, EnumFunc: userIDs, EnumMiss: userThemeMiss(set), Description: "One of your themes: ask for its pair of the other scheme (the description is optional then)"},
			{Name: "model", Type: Enum, Enum: ThreadModels, Description: threadModelHelp + " (default: settings threads.default_model, else Claude's default)"},
			{Name: "effort", Type: Enum, Enum: ThreadEfforts, Description: "Effort level (default: settings threads.default_effort, else Claude's default)"},
			{Name: "permission", Type: Enum, Enum: ThreadPermissions, Default: "auto", Description: "Permission mode, as thread new's"},
		},
		Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
			ask := strings.TrimSpace(a.String("description"))
			var pair *theme.File
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
				pair = &f
			}
			pairID := ""
			if pair != nil {
				snap := d.Themes.Snapshot()
				pairID = FreePairID(pair.ID, pair.Scheme, func(c string) bool {
					_, user := snap.Get(c)
					_, issue := snap.Issue(c)
					return user || issue || theme.IsCurated(c)
				})
			}
			switch {
			case ask == "" && pair == nil:
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
			created, err := d.Thread.Create(ctx, connect.NewRequest(&v1.CreateThreadRequest{
				NoProject: true, Model: a.String("model"), Effort: a.String("effort"),
				PermissionMode: threadPermissionModes[a.String("permission")], InitialPrompt: ThemeAskMessage(ask, pair),
				SystemPromptAppend: ThemeAskContext(uctx.ActiveView == ViewThemes, slot(theme.SchemeDark), slot(theme.SchemeLight), pair, pairID),
				ModelDefaulted:     a.String("model") != "" && !a.Given("model"),
				EffortDefaulted:    a.String("effort") != "" && !a.Given("effort"),
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
