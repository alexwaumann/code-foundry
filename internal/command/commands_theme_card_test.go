package command_test

import (
	"context"
	"log/slog"
	"path/filepath"
	"strings"
	"testing"

	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/api"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	"github.com/alexwaumann/code-foundry/internal/store/settings/settingstest"
	"github.com/alexwaumann/code-foundry/internal/store/usertheme"
)

type cardEnv struct {
	themeEnv
	cards *commandtest.Thread
	emit  *commandtest.Emitter
}

// newCardEnv is newThemeEnv with a thread fake for the cards and an emitter for the toast.
func newCardEnv(t *testing.T) cardEnv {
	t.Helper()
	home := t.TempDir()
	store, err := settingstest.New(context.Background(), home, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	dir := filepath.Join(home, "themes")
	themes := usertheme.New(usertheme.Options{Dir: dir, Log: slog.New(slog.DiscardHandler)})
	themes.Load()
	themes.OnChange(func(s *usertheme.Snapshot) { store.SetThemes(s.Set()) })
	cards, emit := &commandtest.Thread{}, &commandtest.Emitter{}
	reg := command.NewRegistry()
	if err := command.RegisterTheme(reg, command.ThemeDeps{Settings: api.NewSettings(store), Themes: themes, Cards: cards, Emitter: emit}); err != nil {
		t.Fatal(err)
	}
	return cardEnv{themeEnv: themeEnv{reg: reg, settings: store, themes: themes, dir: dir}, cards: cards, emit: emit}
}

// cardRequests are the ShowTheme requests the fake got.
func (e cardEnv) cardRequests() []*v1.ShowThreadThemeRequest {
	var out []*v1.ShowThreadThemeRequest
	for _, m := range e.cards.Requests() {
		if r, ok := m.(*v1.ShowThreadThemeRequest); ok {
			out = append(out, r)
		}
	}
	return out
}

func TestThemeSaveCardAndToast(t *testing.T) {
	thread := command.Context{ActiveThreadID: "s-5f963f4547cc"}
	gui := command.Context{ActiveView: "themes", ActiveThreadID: "s-1"}
	data := string(oceanDusk(t))
	recoloured := strings.Replace(data, `"#5fb3b3"`, `"#6fc3c3"`, 1)
	paired := strings.Replace(data, `"scheme": "dark",`, "\"scheme\": \"dark\",\n  \"pair\": \"ocean-dawn\",", 1)
	if recoloured == data || paired == data {
		t.Fatal("the variants did not change the file")
	}
	notify := func(edit, undo string) *v1.UiIntent_Notify {
		n := &v1.UiIntent_Notify{Level: v1.UiIntent_Notify_LEVEL_INFO, Title: "Ocean Dusk applied to dark", UnlessShowing: "themes"}
		if undo != "" {
			n.Link, n.LinkLabel, n.SecondaryLink, n.SecondaryLinkLabel = undo, "Undo", edit, "Edit"
		} else {
			n.Link, n.LinkLabel = edit, "Edit"
		}
		return n
	}
	type step struct {
		uctx  command.Context
		args  map[string]string
		card  bool   // a card was asked for
		apply bool   // the card says applied
		prev  string // the card's previous
		// own: previous is the theme's own id with the version this save replaced, and
		// the toast's Undo restores it.
		own   bool
		toast *v1.UiIntent_Notify
	}
	tests := []struct {
		name  string
		steps []step
	}{
		{"from a thread with --apply: card and toast with Undo", []step{
			{uctx: thread, args: map[string]string{"data": data, "apply": "true"}, card: true, apply: true, prev: "github-dark",
				toast: notify("theme-edit:ocean-dusk", "theme-undo:dark:ocean-dusk:github-dark")},
		}},
		{"saved without --apply: a card, not applied, no toast", []step{
			{uctx: thread, args: map[string]string{"data": data}, card: true},
		}},
		{"a refinement of the theme in use counts as applied", []step{
			{uctx: thread, args: map[string]string{"data": data, "apply": "true"}, card: true, apply: true, prev: "github-dark",
				toast: notify("theme-edit:ocean-dusk", "theme-undo:dark:ocean-dusk:github-dark")},
			// New colours repaint the slot: a toast, whose Undo puts the colours before
			// back (the version the store kept).
			{uctx: thread, args: map[string]string{"data": recoloured}, card: true, apply: true, prev: "ocean-dusk", own: true,
				toast: notify("theme-edit:ocean-dusk", "theme-undo:dark:ocean-dusk:ocean-dusk:")},
		}},
		{"a save that changes no colour of the theme in use: a card, no toast", []step{
			{uctx: thread, args: map[string]string{"data": data, "apply": "true"}, card: true, apply: true, prev: "github-dark",
				toast: notify("theme-edit:ocean-dusk", "theme-undo:dark:ocean-dusk:github-dark")},
			// Only pair set (the pair turn re-saves the first theme): applied, nothing
			// repainted, nothing to undo.
			{uctx: thread, args: map[string]string{"data": paired, "apply": "true"}, card: true, apply: true},
			// The same file again, without --apply.
			{uctx: thread, args: map[string]string{"data": paired}, card: true, apply: true},
		}},
		{"--apply of a theme saved before but not in use: the slot changes, a toast", []step{
			{uctx: thread, args: map[string]string{"data": data}, card: true},
			{uctx: thread, args: map[string]string{"data": data, "apply": "true"}, card: true, apply: true, prev: "github-dark",
				toast: notify("theme-edit:ocean-dusk", "theme-undo:dark:ocean-dusk:github-dark")},
		}},
		{"from the GUI: no card, no toast", []step{
			{uctx: gui, args: map[string]string{"data": data, "apply": "true"}},
		}},
		{"from the user's terminal: no card, no toast", []step{
			{uctx: command.Context{}, args: map[string]string{"data": data, "apply": "true"}},
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			env := newCardEnv(t)
			for i, s := range tt.steps {
				before := len(env.cardRequests())
				toasts := len(env.emit.Intents())
				was, _ := env.themes.Snapshot().Get("ocean-dusk")
				wantVer := ""
				if s.own {
					wantVer = was.Version()
					s.toast.Link += wantVer
				}
				res, err := env.invoke(t, s.uctx, "theme.save", s.args)
				if err != nil {
					t.Fatalf("step %d: %v", i, err)
				}
				// The card no longer stands in for the contrast line (theme_check_test.go).
				if !strings.Contains(res.Message, "\ncontrast: ") {
					t.Errorf("step %d: no contrast line in %q", i, res.Message)
				}
				reqs := env.cardRequests()[before:]
				switch {
				case !s.card && len(reqs) != 0:
					t.Fatalf("step %d: card requests %v, want none", i, reqs)
				case s.card && len(reqs) != 1:
					t.Fatalf("step %d: %d card requests, want 1", i, len(reqs))
				case s.card:
					r := reqs[0]
					c := r.GetTheme()
					if r.GetThreadId() != "s-5f963f4547cc" || c.GetTheme().GetId() != "ocean-dusk" || c.GetTheme().GetFrom() != "catppuccin-mocha" ||
						c.GetTheme().GetCreatedBy() != "s-5f963f4547cc" || len(c.GetTheme().GetOverrides()) != 2 || c.GetApplied() != s.apply || c.GetPrevious() != s.prev ||
						c.GetPreviousVersion() != wantVer || c.GetPreviousGone() {
						t.Errorf("step %d: card %v, want applied %v previous %q %q", i, r, s.apply, s.prev, wantVer)
					}
				}
				got := env.emit.Intents()[toasts:]
				switch {
				case s.toast == nil && len(got) != 0:
					t.Errorf("step %d: intents %v, want none", i, got)
				case s.toast != nil && (len(got) != 1 || !proto.Equal(got[0].GetNotify(), s.toast)):
					t.Errorf("step %d: intents %v, want %v", i, got, s.toast)
				}
			}
		})
	}
}

// A card the store refuses is a warning: the theme is still saved and applied.
func TestThemeSaveCardFailureWarns(t *testing.T) {
	env := newCardEnv(t)
	env.cards.Err = context.DeadlineExceeded
	res, err := env.invoke(t, command.Context{ActiveThreadID: "s-1"}, "theme.save", map[string]string{"data": string(oceanDusk(t)), "apply": "true"})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Warnings) != 1 || !strings.Contains(res.Warnings[0], "its card was not added to thread s-1") || !strings.Contains(res.Message, "applied: dark theme = Ocean Dusk") {
		t.Errorf("result = %+v", res)
	}
}
