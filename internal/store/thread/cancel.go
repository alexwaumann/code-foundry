package thread

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"time"

	"github.com/alexwaumann/code-foundry/internal/claudestream"
)

// Cancel and Re-send a message Claude has not read (docs/notes/cancel-queued-messages.md).
//
// A message the user sends while Claude works waits in Claude Code's queue (queued.go).
// Cancel takes it back before Claude reads it: Claude Code's cancel_async_message
// control request (Claude Code 2.1.284 and later) answers {"cancelled":true} while it is
// still queued, then writes a command_lifecycle "cancelled" for it, and Claude never sees
// it; once Claude read it ("started") the answer is {"cancelled":false} and it runs as
// usual. The answer decides, not the timing of the frames. A message that was never sent
// (Unsent: Claude's process ended, or an interrupt held it) needs no request.
//
// A cancelled message leaves the log at once (Item.Cancelled): its row says so, the
// ItemUpdated that drops it tells the watchers, and nothing else sees it again. The GUI
// puts its text back in the composer.
//
// Re-send sends an unsent message again as a new message, like any send (it starts a
// stopped thread, queues behind a running turn), and drops the old one the same way.
//
// An interrupt stops: before it interrupts, the daemon takes the user's own queued
// messages out of Claude's queue (holdUserQueued), so Claude does not start them as the
// next turn; they become not sent (Unsent) where they are, for the user to re-send or
// cancel. Messages from other threads and wakes stay in the queue: Claude starts them at
// once, as before.

// takeBack drops user message id from the log, marked Cancelled, and publishes that.
// Only a message Claude has not read (queued or unsent) can be taken back. The item as
// dropped; false when there is no such message.
func (t *threadLog) takeBack(id string) (Item, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	i, ok := t.byID[id]
	if !ok || t.items[i].Kind != KindUserMessage || !(t.items[i].Queued || t.items[i].Unsent) {
		return Item{}, false
	}
	return t.takeBackLocked(i), true
}

// takeBackLocked is takeBack of t.items[i]. t.mu held.
func (t *threadLog) takeBackLocked(i int) Item {
	it := cloneItem(t.items[i])
	it.Queued, it.Unsent, it.Cancelled = false, false, true
	it.UpdatedAt = t.now()
	t.items = slices.Delete(t.items, i, i+1)
	t.reorderLocked()
	delete(t.held, it.ID)
	if t.cancelled == nil {
		t.cancelled = map[string]bool{}
	}
	t.cancelled[it.ID] = true
	t.turnDirty = true
	t.publishLocked(func(seq uint64) ThreadEvent { return ItemUpdated{ThreadID: t.id, Seq: seq, Item: it} }, it.Kind)
	return it
}

// takeBack applies threadLog.takeBack and persists the item (its row records that it was
// cancelled; loadItems leaves it out).
func (w itemWriter) takeBack(id string) (Item, bool) {
	it, ok := w.log.takeBack(id)
	if ok {
		w.save(it)
	}
	return it, ok
}

// claimTakeBack marks message id as being cancelled or re-sent, so a second Cancel or
// Re-send of it is refused, and a "cancelled" lifecycle for it (consume) takes it back
// instead of marking it unsent. False when it is claimed already.
func (t *threadLog) claimTakeBack(id string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.takingBack[id] {
		return false
	}
	if t.takingBack == nil {
		t.takingBack = map[string]bool{}
	}
	t.takingBack[id] = true
	return true
}

func (t *threadLog) releaseTakeBack(id string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.takingBack, id)
}

// wasCancelled reports whether message id left the log as cancelled (this daemon run).
func (t *threadLog) wasCancelled(id string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.cancelled[id]
}

// userQueued returns the ids of the user's own top-level messages Claude has queued
// (not one the setup row still holds: Claude does not have it): what an interrupt holds.
func (t *threadLog) userQueued() []string {
	t.mu.Lock()
	defer t.mu.Unlock()
	var out []string
	for _, it := range t.items {
		if it.Kind == KindUserMessage && it.Queued && userOwn(it) && !t.held[it.ID] {
			out = append(out, it.ID)
		}
	}
	return out
}

// userOwn reports whether user message it is the user's own: not a wake, not another
// thread's (SentBy), not a subagent's prompt.
func userOwn(it Item) bool {
	return it.ParentToolUseID == "" && it.Origin == OriginUser && it.SentBy == ""
}

// holdUserQueued takes the user's own queued messages out of Claude's queue before an
// interrupt (docs/notes/cancel-queued-messages.md): Claude would otherwise start them at
// once as the next turn. Each one Claude gives back becomes Unsent where it is (consume;
// its "cancelled" lifecycle does the same); one Claude read meanwhile runs as usual, and
// a request that fails is logged and skipped: the interrupt goes ahead either way. Each
// request gets timeout. It returns the ids it held.
func holdUserQueued(ctx context.Context, w itemWriter, conn *claudestream.Conn, timeout time.Duration, log *slog.Logger) []string {
	var held []string
	for _, id := range w.log.userQueued() {
		rctx, cancel := context.WithTimeout(ctx, timeout)
		gone, err := conn.CancelAsyncMessage(rctx, id)
		cancel()
		switch {
		case err != nil:
			log.Warn("interrupt: could not hold a queued message", "item", id, "err", err)
		case gone:
			w.consume(id, false)
			held = append(held, id)
		}
	}
	return held
}

// writer is thread id's item writer outside its runner (the projector's has the same
// save).
func (m *Manager) writer(id string, log *threadLog) itemWriter {
	return itemWriter{log: log, save: func(it Item) { m.saveItem(id, it) }}
}

// errMessageRead: Claude read the message before it could be taken back.
var errMessageRead = errors.New("already read by Claude")

// takeBackTarget is message itemID of thread id when the user may take it back: their
// own message, not read. The thread's log, the item, and the refusal otherwise.
// verb names the act ("cancel"), done its past participle ("cancelled").
func (m *Manager) takeBackTarget(ctx context.Context, id, itemID, verb, done string) (*threadLog, Item, error) {
	if itemID == "" {
		return nil, Item{}, fmt.Errorf("%w: a message id is required", ErrInvalidArgument)
	}
	log, err := m.thread(ctx, id)
	if err != nil {
		return nil, Item{}, err
	}
	if t, ok := m.Snapshot().Thread(id); ok && !t.ArchivedAt.IsZero() {
		return nil, Item{}, fmt.Errorf("%w: thread %s is archived; unarchive it to %s its messages", ErrFailedPrecondition, id, verb)
	}
	it, ok := log.get(itemID)
	switch {
	case !ok && log.wasCancelled(itemID):
		return nil, Item{}, fmt.Errorf("%w: message %s was cancelled already", ErrFailedPrecondition, itemID)
	case !ok:
		return nil, Item{}, fmt.Errorf("%w: thread %s has no message %s", ErrNotFound, id, itemID)
	case it.Kind != KindUserMessage || it.ParentToolUseID != "":
		return nil, Item{}, fmt.Errorf("%w: item %s of thread %s is not a message you sent", ErrInvalidArgument, itemID, id)
	case it.Origin == OriginWake:
		return nil, Item{}, fmt.Errorf("%w: message %s is a wake, not yours: only your own messages can be %s", ErrFailedPrecondition, itemID, done)
	case it.SentBy != "":
		return nil, Item{}, fmt.Errorf("%w: message %s was sent by thread %s, not by you: only your own messages can be %s", ErrFailedPrecondition, itemID, it.SentBy, done)
	case !it.Queued && !it.Unsent:
		return nil, Item{}, fmt.Errorf("%w: message %s: %w; only a queued or not sent message can be %s", ErrFailedPrecondition, itemID, errMessageRead, done)
	}
	return log, it, nil
}

// CancelMessage implements Store.
func (m *Manager) CancelMessage(ctx context.Context, id, itemID string) (Item, error) {
	log, it, err := m.takeBackTarget(ctx, id, itemID, "cancel", "cancelled")
	if err != nil {
		return Item{}, err
	}
	if !log.claimTakeBack(itemID) {
		return Item{}, fmt.Errorf("%w: message %s is being cancelled or sent again already", ErrFailedPrecondition, itemID)
	}
	defer log.releaseTakeBack(itemID)
	w := m.writer(id, log)
	if it.Queued {
		if err := m.cancelQueued(ctx, id, log, itemID); err != nil {
			return Item{}, err
		}
	}
	got, ok := w.takeBack(itemID)
	if !ok {
		// Claude's "cancelled" lifecycle took it back first (consume), or it was read.
		if log.wasCancelled(itemID) {
			got = it
			got.Queued, got.Unsent, got.Cancelled = false, false, true
		} else {
			return Item{}, fmt.Errorf("%w: message %s: %w", ErrFailedPrecondition, itemID, errMessageRead)
		}
	}
	m.log.Info("message cancelled", "thread", id, "item", itemID, "was", map[bool]string{true: "queued", false: "not sent"}[it.Queued])
	return got, nil
}

// cancelQueued takes queued message itemID back from where it waits: the setup's row
// (Setup.Queued) while there is no process yet, else Claude's queue (cancel_async_message).
// errMessageRead when Claude had read it.
func (m *Manager) cancelQueued(ctx context.Context, id string, log *threadLog, itemID string) error {
	if log.queuedHeld(itemID) {
		m.mu.Lock()
		rec, err := m.record(id)
		onRow := err == nil && rec.s.setupUnfinished() && slices.ContainsFunc(rec.s.Setup.Queued, func(q PendingFirst) bool { return q.ItemID == itemID })
		if onRow {
			rec.s.Setup = rec.s.Setup.edit(func(c *Setup) {
				c.Queued = slices.DeleteFunc(c.Queued, func(q PendingFirst) bool { return q.ItemID == itemID })
			})
			m.commitLocked(rec, true)
		}
		m.mu.Unlock()
		if err != nil {
			return err
		}
		if !onRow {
			return fmt.Errorf("%w: Claude is starting with message %s; try again in a moment", ErrFailedPrecondition, itemID)
		}
		log.releaseQueued(itemID)
		return nil
	}
	r, _, err := m.liveOrStopped(ctx, id)
	if err != nil {
		return err
	}
	if r == nil {
		return nil // no process holds it: it is as good as not sent
	}
	select { // a starting process is asked once it answered the handshake
	case <-r.ready:
	case <-r.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
	conn, err := r.st.connection()
	if err != nil {
		return err
	}
	var gone bool
	err = m.boundedControl(ctx, "cancel", func(ctx context.Context) error {
		var err error
		gone, err = conn.CancelAsyncMessage(ctx, itemID)
		return err
	})
	switch {
	case errors.Is(err, claudestream.ErrClosed):
		return nil // the process ended under it: closeUnfinished made it unsent
	case err != nil:
		return controlErr(err)
	case !gone:
		return fmt.Errorf("%w: message %s: %w before it could be cancelled", ErrFailedPrecondition, itemID, errMessageRead)
	}
	return nil
}

// ResendMessage implements Store.
func (m *Manager) ResendMessage(ctx context.Context, id, itemID string) (Item, []string, error) {
	log, it, err := m.takeBackTarget(ctx, id, itemID, "re-send", "re-sent")
	if err != nil {
		return Item{}, nil, err
	}
	if it.Queued {
		return Item{}, nil, fmt.Errorf("%w: message %s is still queued: Claude reads it at its next tool call; cancel it to take it back", ErrFailedPrecondition, itemID)
	}
	if !log.claimTakeBack(itemID) {
		return Item{}, nil, fmt.Errorf("%w: message %s is being cancelled or sent again already", ErrFailedPrecondition, itemID)
	}
	defer log.releaseTakeBack(itemID)
	keep, gone := stagedStill(it.Attachments)
	msg := Message{Text: it.Text, ComposerText: it.ComposerText, Attachments: keep}
	if len(gone) > 0 {
		msg.shownAttachments = it.Attachments // the bubble shows a gone one dashed, as on any message
	}
	sent, err := m.Send(ctx, id, msg)
	if err != nil {
		return Item{}, nil, err
	}
	m.writer(id, log).takeBack(itemID)
	m.log.Info("message sent again", "thread", id, "item", itemID, "as", sent.ID, "gone_attachments", len(gone))
	names := make([]string, len(gone))
	for i, p := range gone {
		names[i] = filepath.Base(p)
	}
	return sent, names, nil
}

// stagedStill splits staged attachment paths into the ones still there and the gone ones.
func stagedStill(paths []string) (keep, gone []string) {
	for _, p := range paths {
		if fi, err := os.Stat(p); err == nil && fi.Mode().IsRegular() {
			keep = append(keep, p)
		} else {
			gone = append(gone, p)
		}
	}
	return keep, gone
}
