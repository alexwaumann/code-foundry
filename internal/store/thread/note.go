package thread

import (
	"context"
	"fmt"
	"strings"
)

// MaxNoteText is the longest AddNote text, in characters; longer is cut with "…".
const MaxNoteText = 500

// AddNote implements Store: a note item (a line the daemon adds, not Claude) at the
// thread's current position, on the runner's goroutine while it runs, else onto the
// stopped thread's log, as ShowHTML places a page. Starts no turn, unarchives nothing.
// The text goes on one line, at most MaxNoteText characters.
func (m *Manager) AddNote(ctx context.Context, id, text string) (Item, error) {
	text = oneLine(text, MaxNoteText)
	if text == "" {
		return Item{}, fmt.Errorf("%w: a note needs text", ErrInvalidArgument)
	}
	return m.verbItem(ctx, id, func(Thread) (Item, error) {
		return Item{Kind: KindNote, Text: strings.TrimSpace(text)}, nil
	}, nil)
}
