package threadtest

import (
	"context"
	"fmt"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// ShowTheme records "ShowTheme <id> <theme id>" and appends a theme item with the card
// as given. It checks only that the thread exists and the theme has an id; the real
// store validates the file and fills a refinement's Undo target.
func (f *Fake) ShowTheme(_ context.Context, id string, card thread.ThemeCard) (thread.Item, error) {
	f.mu.Lock()
	if err := f.record("ShowTheme " + id + " " + card.File.ID); err != nil {
		f.mu.Unlock()
		return thread.Item{}, err
	}
	if _, err := f.get(id); err != nil {
		f.mu.Unlock()
		return thread.Item{}, err
	}
	if card.File.ID == "" {
		f.mu.Unlock()
		return thread.Item{}, fmt.Errorf("%w: the theme has no id", thread.ErrInvalidArgument)
	}
	f.next++
	it, ev := f.appendItem(id, thread.Item{ID: fmt.Sprintf("theme-%d", f.next), Kind: thread.KindTheme, Theme: &card})
	f.mu.Unlock()
	bus.Publish(f.bus, ev)
	return it, nil
}
