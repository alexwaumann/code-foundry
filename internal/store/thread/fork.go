package thread

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"time"
)

// A fork's conversation (docs/notes/fork-copies-history.md). Claude continues the
// parent's transcript (--resume --fork-session), so the fork's log starts with a copy of
// the parent's items, then a note saying where the copy ends. A parent that is itself a
// fork holds its own parent's copy, so forks of forks need nothing more. A fork from a
// turn (ForkOptions.At, forkcut.go) copies the items up to that turn's end and its note
// names the turn.

// forkWhy is why a copied tool call or request stopped: the fork's Claude never runs it.
const forkWhy = "the thread was forked before it finished"

// forkNotePrefix starts the id of the note that ends a fork's copied history (then the
// parent's id): a turn boundary in the daemon (isForkNote) and the GUI.
const forkNotePrefix = "note-fork-"

// forkNoteText is the note that ends a fork's copied history, naming the parent as it
// was called at fork time (the row outlives a rename or removal of the parent).
func forkNoteText(parent Thread) string {
	name := parent.Name
	if name == "" {
		name = parent.ID
	}
	return "Forked from " + name
}

// forkTurnNoteText is the note that ends the copy of a fork from turn t: which turn,
// and that the files were not rewound (the fork works in the parent's checkouts).
func forkTurnNoteText(parent Thread, t forkTurn) string {
	return forkNoteText(parent) + " at turn " + strconv.Itoa(t.n) + " of " + strconv.Itoa(t.total) +
		". The files are as they are now, not as they were after that turn."
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
		// Renumbered in the log's order: a placed message's place is its ordinal now. ReadAt
		// and Unsent stay (history: when Claude read it, or that it never did); a message
		// still queued is never read in the copy.
		it.Unsent = it.Unsent || it.Queued
		it.Queued, it.PlacedAfter = false, 0
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

// forkLog builds the fork newID's log from items (the parent's, up to where the fork
// starts) and note, and installs it, so the fork's spawn and first Watch see the copy
// before any row is written (the fork's thread row, which thread_items references, is
// written by spawn; persistForkLog writes the rows after it).
func (m *Manager) forkLog(parent Thread, newID string, items []Item, note string) []Item {
	items = forkItems(items, forkNotePrefix+parent.ID, note, m.opts.Now())
	m.tmu.Lock()
	m.threads[newID] = newThreadLog(newID, m.opts.Bus, m.opts.Now, items)
	m.tmu.Unlock()
	return items
}

// forkCutOf finds the turn at in the parent's items and the uuid that ends the fork's
// conversation with it, reading the parent's transcript at path (forkcut.go).
func (m *Manager) forkCutOf(items []Item, at string, busy bool, path string) (forkTurn, string, error) {
	t, err := forkAt(items, at, busy)
	if err != nil {
		return forkTurn{}, "", err
	}
	f, err := os.Open(path)
	if err != nil {
		return forkTurn{}, "", fmt.Errorf("thread: fork: read the transcript: %w", err)
	}
	defer func() { _ = f.Close() }()
	recs, err := readCutRecords(f)
	if err != nil {
		return forkTurn{}, "", fmt.Errorf("thread: fork: read the transcript: %w", err)
	}
	cut, err := forkCut(items, t, recs, busy)
	return t, cut, err
}

// persistForkLog writes the fork's copied items once its thread row exists.
func (m *Manager) persistForkLog(ctx context.Context, id string, items []Item) {
	if err := saveItems(context.WithoutCancel(ctx), m.opts.DB, id, items, searchIndex{}); err != nil {
		m.log.Error("persist fork history", "thread", id, "items", len(items), "err", err)
	}
}
