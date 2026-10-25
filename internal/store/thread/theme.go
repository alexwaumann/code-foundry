package thread

import (
	"context"
	"fmt"

	"github.com/alexwaumann/code-foundry/internal/theme"
)

// Theme cards (docs/notes/theme-model-flow.md): `code-foundry theme save` run from a
// thread puts a theme item in that thread's conversation, which the GUI draws as a card
// (swatches, contrast, Undo and Edit). The item holds the file as it was saved, so a
// later save of the same id adds another card and leaves this one as it was.

// KindTheme is a theme the thread saved (ShowTheme): Item.Theme says which.
const KindTheme ItemKind = "theme"

// ThemeCard is a theme item's payload.
type ThemeCard struct {
	// File is the theme file as saved.
	File theme.File `json:"file"`
	// Applied: the save changed what a slot shows (--apply, or a save of the theme the
	// slot already has).
	Applied bool `json:"applied,omitempty"`
	// Previous is what the slot showed immediately before this save, the theme Undo puts
	// back (docs/notes/theme-fuzz-daemon.md); this theme's own id with PreviousVersion when
	// the save replaced the colours the slot showed; "" for nothing to undo.
	Previous string `json:"previous,omitempty"`
	// PreviousVersion is the version of this theme's file the save replaced (kept in the
	// themes directory's history), when Previous is this theme's id.
	PreviousVersion string `json:"previous_version,omitempty"`
	// PreviousGone: what Previous names was not there to put back when the card was made.
	PreviousGone bool `json:"previous_gone,omitempty"`
}

// ShowTheme implements Store: it appends a theme item to thread id, where ShowHTML puts
// a page. The file must validate (ErrInvalidArgument). A card that is not applied has
// nothing to undo; one whose previous is its own theme needs the version it replaced.
func (m *Manager) ShowTheme(ctx context.Context, id string, card ThemeCard) (Item, error) {
	f, err := theme.ParseFile(card.File.Marshal())
	if err != nil {
		return Item{}, fmt.Errorf("%w: %w", ErrInvalidArgument, err)
	}
	card.File = f
	switch {
	case !card.Applied, card.Previous == f.ID && card.PreviousVersion == "" && !card.PreviousGone:
		card.Previous, card.PreviousVersion, card.PreviousGone = "", "", false
	case card.Previous != f.ID:
		card.PreviousVersion = ""
	}
	return m.verbItem(ctx, id, func(Thread) (Item, error) {
		c := card
		return Item{Kind: KindTheme, Theme: &c}, nil
	}, nil)
}
