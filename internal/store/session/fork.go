package session

import (
	"context"
	"fmt"
	"time"
)

// A fork's conversation (docs/notes/fork-copies-history.md). Claude continues the
// parent's transcript (--resume --fork-session), so the fork's log starts with a copy of
// the parent's items, then a note saying where the copy ends. A parent that is itself a
// fork holds its own parent's copy, so forks of forks need nothing more.

// forkWhy is why a copied tool call or request stopped: the fork's Claude never runs it.
const forkWhy = "the thread was forked before it finished"

// forkNoteText is the note that ends a fork's copied history, naming the parent as it
// was called at fork time (the row outlives a rename or removal of the parent).
func forkNoteText(parent Session) string {
	name := parent.Name
	if name == "" {
		name = parent.ID
	}
	return "Forked from " + name
}

// forkItems is what a fork's log starts with: parent's items in order, renumbered from
// 1, then the note (id noteID, text note, at now). Copies are history, never live:
// streaming items (not in Claude's transcript yet) are dropped, running tool calls end
// as errors and pending requests are cancelled, so the fork has nothing to answer.
// Times are kept: a copied turn happened when it happened.
func forkItems(parent []Item, noteID, note string, now time.Time) []Item {
	out := make([]Item, 0, len(parent)+1)
	for _, it := range parent {
		if it.Streaming {
			continue
		}
		it = cloneItem(it)
		if it.Tool != nil && it.Tool.Status == ToolRunning {
			it.Tool.Status = ToolError
			if it.Tool.Output == "" {
				it.Tool.Output = "Interrupted: " + forkWhy + "."
			}
		}
		if it.Request != nil && it.Request.State == RequestPending {
			it.Request.State, it.Request.Message = RequestCancelled, forkWhy
		}
		it.Ordinal = int64(len(out) + 1)
		out = append(out, it)
	}
	return append(out, Item{
		ID: noteID, Ordinal: int64(len(out) + 1), Kind: KindNote, Text: note, CreatedAt: now, UpdatedAt: now,
	})
}

// forkLog builds the fork newID's log from parent's current items and installs it, so
// the fork's spawn and first Watch see the copy before any row is written (the fork's
// session row, which thread_items references, is written by spawn; persistForkLog
// writes the rows after it).
func (m *Manager) forkLog(ctx context.Context, parent Session, newID string) ([]Item, error) {
	plog, err := m.thread(ctx, parent.ID)
	if err != nil {
		return nil, fmt.Errorf("session: fork %s: %w", parent.ID, err)
	}
	items := forkItems(plog.snapshot().Items, "note-fork-"+parent.ID, forkNoteText(parent), m.opts.Now())
	m.tmu.Lock()
	m.threads[newID] = newThreadLog(newID, m.opts.Bus, m.opts.Now, items)
	m.tmu.Unlock()
	return items, nil
}

// persistForkLog writes the fork's copied items once its session row exists.
func (m *Manager) persistForkLog(ctx context.Context, id string, items []Item) {
	if err := saveItems(context.WithoutCancel(ctx), m.opts.DB, id, items); err != nil {
		m.log.Error("persist fork history", "session", id, "items", len(items), "err", err)
	}
}
