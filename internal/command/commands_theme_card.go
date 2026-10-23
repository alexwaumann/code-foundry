package command

import (
	"context"
	"fmt"
	"log/slog"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/theme"
)

// Theme cards (docs/notes/theme-model-flow.md): theme.save run from a thread puts a card
// in that thread's conversation (ThreadService.ShowTheme) and, when the save changed what
// a slot shows, a toast in every window with Undo and Edit. The thread is how most
// users edit a theme: the model saves, the app switches, the next message adjusts it.

// ThemeCardShower appends a theme item to a thread (ThreadService.ShowTheme).
type ThemeCardShower interface {
	ShowTheme(context.Context, *connect.Request[v1.ShowThreadThemeRequest]) (*connect.Response[v1.ShowThreadThemeResponse], error)
}

var _ ThemeCardShower = codefoundryv1connect.ThreadServiceHandler(nil)

// Toast links (UiIntent.Notify.link, the GUI's stores/notifyLinks.ts).
const (
	// ThemeEditLinkPrefix + id opens the editor on the theme (theme.edit).
	ThemeEditLinkPrefix = "theme-edit:"
	// ThemeUndoLinkPrefix + "<scheme>:<id>:<previous>[:<version>]" is a card's Undo from
	// its toast: while the slot still shows theme id, put it back on previous
	// (theme.set-<scheme>), or, with a version, put that version of id back
	// (theme.restore).
	ThemeUndoLinkPrefix = "theme-undo:"
	// ThemesPage is the Themes page's id for Notify.unless_showing: it shows the change.
	ThemesPage = "themes"
)

// showThemeCard puts the saved theme's card in thread `by` and, with toast, shows the
// toast. applied: the slot shows the theme (the card's badge); undo is what the slot
// showed immediately before the save (themeUndoOf). A card that cannot be added is a
// warning, not a failure: the theme is saved. shown: the card was added.
func showThemeCard(ctx context.Context, d ThemeDeps, by string, f theme.File, applied bool, undo themeUndo, toast bool) (warnings []string, shown bool) {
	if !applied {
		undo = themeUndo{}
	}
	if d.Cards != nil {
		_, err := d.Cards.ShowTheme(ctx, connect.NewRequest(&v1.ShowThreadThemeRequest{ThreadId: by, Theme: &v1.ThemeItem{
			Theme: theme.ToProto(f, ""), Applied: applied, Previous: undo.id, PreviousVersion: undo.version, PreviousGone: undo.gone,
		}}))
		if err != nil {
			slog.Warn("theme: card not shown", "thread", by, "theme", f.ID, "err", err)
			warnings = append(warnings, fmt.Sprintf("the theme is saved, but its card was not added to thread %s: %v", by, err))
		} else {
			shown = true
		}
	}
	if toast && d.Emitter != nil {
		d.Emitter.Emit(themeAppliedToast(f, undo))
	}
	return warnings, shown
}

// themeAppliedToast is "<name> applied to <scheme>" with Undo (when there is something
// to put back) and Edit; a window showing the Themes page skips it.
func themeAppliedToast(f theme.File, undo themeUndo) *v1.UiIntent {
	n := &v1.UiIntent_Notify{
		Level: v1.UiIntent_Notify_LEVEL_INFO, Title: clipText(fmt.Sprintf("%s applied to %s", f.Name, f.Scheme), 120),
		UnlessShowing: ThemesPage,
	}
	edit, editLabel := ThemeEditLinkPrefix+f.ID, "Edit"
	if undo.id != "" && !undo.gone {
		n.Link, n.LinkLabel = ThemeUndoLinkPrefix+f.Scheme+":"+f.ID+":"+undo.id, "Undo"
		if undo.version != "" {
			n.Link += ":" + undo.version
		}
		n.SecondaryLink, n.SecondaryLinkLabel = edit, editLabel
	} else {
		n.Link, n.LinkLabel = edit, editLabel
	}
	return &v1.UiIntent{Intent: &v1.UiIntent_Notify_{Notify: n}}
}
