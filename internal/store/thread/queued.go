package thread

import (
	"cmp"
	"slices"

	"github.com/alexwaumann/code-foundry/internal/claudestream"
)

// Queued messages (docs/notes/orch-queued-placement.md). A message sent while Claude
// works is not read at once: Claude Code queues it and reads it at its next tool call, or
// once the reply it is writing ends. Its item goes into the log when it arrives (the
// sender sees the send land) marked Queued; when the stream says Claude read it, the flag
// clears and the item moves to that point (PlacedAfter), so it sits above the text that
// answers it instead of above a reply that never saw it.
//
// The signal (Claude Code 2.1.303, stream-json, probed for this change): every user
// message gets command_lifecycle frames keyed by its uuid (our item id): "queued" when it
// arrives, "started" when Claude takes it into the conversation (at once when idle; mid
// turn right after the tool_result it waited behind; after the last text when it came
// during the reply, still inside the same result), "completed" at the turn's end,
// "cancelled" when dropped. The next system/status "requesting" lists it in
// user_message_uuids too, a second signal. An interrupt starts what is queued at once.

// itemOrder is the log's order: by ordinal, except that a placed message (PlacedAfter)
// sits right after the item with that ordinal, after any other message placed there
// earlier (a smaller ordinal: Claude reads its queue in order).
func itemOrder(a, b Item) int {
	return cmp.Or(cmp.Compare(placeKey(a), placeKey(b)), cmp.Compare(placed(a), placed(b)), cmp.Compare(a.Ordinal, b.Ordinal))
}

func placeKey(it Item) int64 {
	if it.PlacedAfter > 0 {
		return it.PlacedAfter
	}
	return it.Ordinal
}

func placed(it Item) int {
	if it.PlacedAfter > 0 {
		return 1
	}
	return 0
}

// reorderLocked sorts the items in itemOrder and reindexes them. t.mu held (or t not
// shared yet).
func (t *threadLog) reorderLocked() {
	slices.SortStableFunc(t.items, itemOrder)
	clear(t.byID)
	for i, it := range t.items {
		t.byID[it.ID] = i
	}
}

// consume clears the Queued flag of message id: Claude read it (place) or never will
// (!place). Placed, it moves after the newest item that is not itself queued, when that
// came after it. False when id is no queued item.
func (t *threadLog) consume(id string, place bool) (Item, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	i, ok := t.byID[id]
	if !ok || !t.items[i].Queued {
		return Item{}, false
	}
	it := cloneItem(t.items[i])
	it.Queued = false
	if place {
		var anchor int64
		for j, x := range t.items {
			if j != i && !x.Queued && x.Ordinal > anchor {
				anchor = x.Ordinal
			}
		}
		if anchor > it.Ordinal {
			it.PlacedAfter = anchor
		}
	}
	it.UpdatedAt = t.now()
	t.items[i] = it
	if it.PlacedAfter > 0 {
		t.reorderLocked()
	}
	t.publishLocked(func(seq uint64) ThreadEvent { return ItemUpdated{ThreadID: t.id, Seq: seq, Item: it} }, it.Kind)
	return it, true
}

// queuedIDs are the messages still queued, oldest first.
func (t *threadLog) queuedIDs() []string {
	t.mu.Lock()
	defer t.mu.Unlock()
	var out []string
	for _, it := range t.items {
		if it.Queued {
			out = append(out, it.ID)
		}
	}
	return out
}

// consume applies threadLog.consume and persists the item.
func (w itemWriter) consume(id string, place bool) (Item, bool) {
	it, ok := w.log.consume(id, place)
	if ok {
		w.save(it)
	}
	return it, ok
}

// queueEvent follows what Claude did with the messages it queued.
func (p *projector) queueEvent(ev claudestream.Event) {
	switch e := ev.(type) {
	case *claudestream.CommandLifecycle:
		switch e.State {
		case "started":
			p.w.consume(e.CommandUUID, true)
		case "cancelled":
			p.w.consume(e.CommandUUID, false)
		}
	case *claudestream.Status:
		if e.Status != nil && *e.Status == "requesting" {
			for _, id := range e.UserMessageUUIDs {
				p.w.consume(id, true)
			}
		}
	case *claudestream.Result:
		// Safety net: with nothing left in Claude's queue every message was read, so a
		// flag still set missed its signal. Where Claude read it is unknown: it stays.
		if e.QueuedTurnCount == 0 {
			for _, id := range p.w.log.queuedIDs() {
				p.w.consume(id, false)
			}
		}
	}
}
