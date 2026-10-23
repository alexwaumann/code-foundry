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
	// ThemeSetLinkPrefix + "<scheme>:<id>" puts a slot on a theme (theme.set-<scheme>).
	ThemeSetLinkPrefix = "theme-set:"
	// ThemesPage is the Themes page's id for Notify.unless_showing: it shows the change.
	ThemesPage = "themes"
)

// showThemeCard puts the saved theme's card in thread `by` and, with toast, shows the
// toast. applied: the slot shows the theme (the card's badge and Undo); before is the
// slot's theme before the save (the card's Undo target; the store takes an earlier card's
// when it is the theme itself). A card that cannot be added is a warning, not a failure:
// the theme is saved. shown: the card was added.
func showThemeCard(ctx context.Context, d ThemeDeps, by string, f theme.File, applied bool, before string, toast bool) (warnings []string, shown bool) {
	previous := ""
	if applied {
		previous = before
	}
	if d.Cards != nil {
		res, err := d.Cards.ShowTheme(ctx, connect.NewRequest(&v1.ShowThreadThemeRequest{ThreadId: by, Theme: &v1.ThemeItem{
			Theme: theme.ToProto(f, ""), Applied: applied, Previous: previous,
		}}))
		if err != nil {
			slog.Warn("theme: card not shown", "thread", by, "theme", f.ID, "err", err)
			warnings = append(warnings, fmt.Sprintf("the theme is saved, but its card was not added to thread %s: %v", by, err))
		} else {
			// The store may have taken an earlier card's Undo target.
			previous, shown = res.Msg.GetItem().GetTheme().GetPrevious(), true
		}
	}
	if toast && d.Emitter != nil {
		d.Emitter.Emit(themeAppliedToast(f, previous))
	}
	return warnings, shown
}

// themeAppliedToast is "<name> applied to <scheme>" with Undo (back to previous, when
// there is one) and Edit; a window showing the Themes page skips it.
func themeAppliedToast(f theme.File, previous string) *v1.UiIntent {
	n := &v1.UiIntent_Notify{
		Level: v1.UiIntent_Notify_LEVEL_INFO, Title: clipText(fmt.Sprintf("%s applied to %s", f.Name, f.Scheme), 120),
		UnlessShowing: ThemesPage,
	}
	edit, editLabel := ThemeEditLinkPrefix+f.ID, "Edit"
	if previous != "" && previous != f.ID {
		n.Link, n.LinkLabel = ThemeSetLinkPrefix+f.Scheme+":"+previous, "Undo"
		n.SecondaryLink, n.SecondaryLinkLabel = edit, editLabel
	} else {
		n.Link, n.LinkLabel = edit, editLabel
	}
	return &v1.UiIntent{Intent: &v1.UiIntent_Notify_{Notify: n}}
}
