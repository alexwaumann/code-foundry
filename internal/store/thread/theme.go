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
	// Previous is the theme the slot had before this thread first applied this one, the
	// one Undo puts back; "" when unknown or when the slot already had it.
	Previous string `json:"previous,omitempty"`
}

// ShowTheme implements Store: it appends a theme item to thread id, where ShowHTML puts
// a page. The file must validate (ErrInvalidArgument).
func (m *Manager) ShowTheme(ctx context.Context, id string, card ThemeCard) (Item, error) {
	f, err := theme.ParseFile(card.File.Marshal())
	if err != nil {
		return Item{}, fmt.Errorf("%w: %w", ErrInvalidArgument, err)
	}
	card.File = f
	if !card.Applied {
		card.Previous = ""
	}
	return m.verbItem(ctx, id, func(Thread) (Item, error) {
		c := card
		return Item{Kind: KindTheme, Theme: &c}, nil
	})
}

// inheritPrevious gives a card whose slot already had its theme (a refinement: Previous
// is the theme itself) the Undo target of the thread's latest earlier card of the same
// theme that has one, so Undo on any of the thread's cards goes back to the theme the
// slot had before the thread's first one. Nothing found: no Undo target.
func inheritPrevious(log *threadLog, c *ThemeCard) {
	if c == nil || !c.Applied || c.Previous != c.File.ID {
		return
	}
	c.Previous = ""
	log.mu.Lock()
	defer log.mu.Unlock()
	for i := len(log.items) - 1; i >= 0; i-- {
		t := log.items[i].Theme
		if log.items[i].Kind == KindTheme && t != nil && t.File.ID == c.File.ID && t.File.Scheme == c.File.Scheme && t.Previous != "" && t.Previous != c.File.ID {
			c.Previous = t.Previous
			return
		}
	}
}
