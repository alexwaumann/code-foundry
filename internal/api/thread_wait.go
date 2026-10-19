package api

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// Wait blocks until the thread meets req's condition, or its timeout passes (timed_out,
// with the current record). A thread removed before or during the wait answers with
// removed (a thread being removed meets no condition; thread_removed.go). It subscribes to the thread list before reading the
// snapshot, so a change between the two is not missed and a condition that already
// holds returns at once. The condition counts only once Claude reacted (isReaction)
// after req's after item, else after the thread's latest message (lastMessage), so a
// wait right after a send never returns the status of the turn before it; followed on
// the thread's item events. See docs/notes/agents-1-wait-events.md,
// docs/notes/agents-5-cli.md and docs/notes/send-ordinal-wait-after.md.
func (h *Thread) Wait(ctx context.Context, req *connect.Request[v1.WaitThreadRequest]) (*connect.Response[v1.WaitThreadResponse], error) {
	id, until := req.Msg.GetId(), req.Msg.GetUntil()
	if id == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("a thread id is required"))
	}
	if res := h.removedResponse(id); res != nil {
		return res, nil
	}
	var expired <-chan time.Time
	if d := req.Msg.GetTimeout().AsDuration(); d > 0 {
		t := time.NewTimer(d)
		defer t.Stop()
		expired = t.C
	}
	sub := bus.Subscribe[thread.Event](h.bus, watchBuffer)
	defer sub.Close()
	// Subscribe to the items before reading them, as for the list.
	items := bus.Subscribe[thread.ThreadEvent](h.bus, threadWatchBuffer)
	defer items.Close()
	itemsC := items.C()
	cur, ok := h.store.Snapshot().Thread(id)
	if !ok {
		return h.waitGone(id, "not found")
	}
	after, reacted, err := h.reactedAfter(ctx, id, req.Msg.GetAfter())
	if err != nil {
		return nil, threadError(err)
	}
	if reacted {
		itemsC = nil
	}
	var dropped, itemsDropped uint64
	for {
		p := threadToProto(cur)
		if reacted && threadWaitMet(until, cur) {
			return connect.NewResponse(&v1.WaitThreadResponse{Thread: p}), nil
		}
		select {
		case <-ctx.Done():
			return nil, threadError(ctx.Err())
		case <-expired:
			return connect.NewResponse(&v1.WaitThreadResponse{Thread: p, TimedOut: true}), nil
		case ev, open := <-itemsC:
			if !open {
				return nil, connect.NewError(connect.CodeUnavailable, fmt.Errorf("the daemon is stopping"))
			}
			if d := items.Dropped(); d != itemsDropped {
				// Missed items: read them again.
				itemsDropped = d
				var err error
				if _, reacted, err = h.reactedAfter(ctx, id, strconv.FormatInt(after, 10)); err != nil {
					return nil, threadError(err)
				}
			} else if ev.Thread() == id && isReaction(eventItem(ev), after) {
				reacted = true
			}
			if reacted {
				itemsC = nil // no need to follow the items further
			}
		case ev, open := <-sub.C():
			if !open {
				return nil, connect.NewError(connect.CodeUnavailable, fmt.Errorf("the daemon is stopping"))
			}
			if d := sub.Dropped(); d != dropped {
				// Missed changes: the snapshot has them.
				dropped = d
				if cur, ok = h.store.Snapshot().Thread(id); !ok {
					return h.waitGone(id, "was removed")
				}
				continue
			}
			switch e := ev.(type) {
			case thread.Updated:
				if e.Thread.ID == id {
					cur = e.Thread
				}
			case thread.Removed:
				if e.ID == id {
					return h.waitGone(id, "was removed")
				}
			}
		}
	}
}

// waitGone is Wait's answer for a thread that is not in the store: the removed one
// (removed set), or NOT_FOUND "thread <id> <what>" when the store does not remember it.
func (h *Thread) waitGone(id, what string) (*connect.Response[v1.WaitThreadResponse], error) {
	if res := h.removedResponse(id); res != nil {
		return res, nil
	}
	return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("thread %s %s", id, what))
}

// reactedAfter reads the thread's items: the ordinal of the item after names (its id,
// else an ordinal; thread_read.go's sinceOrdinal), or with after empty of the thread's
// latest message, and whether Claude reacted after it. A thread with no message has
// nothing to react to: reacted.
func (h *Thread) reactedAfter(ctx context.Context, id, after string) (int64, bool, error) {
	snap, err := h.store.Items(ctx, id)
	if err != nil {
		return 0, false, err
	}
	var ord int64
	if after == "" {
		var ok bool
		if ord, ok = lastMessage(snap.Items); !ok {
			return 0, true, nil
		}
	} else if ord, _, err = sinceOrdinal(snap.Items, after); err != nil {
		return 0, false, err
	}
	for i := range snap.Items {
		if isReaction(&snap.Items[i], ord) {
			return ord, true, nil
		}
	}
	return ord, false, nil
}

// lastMessage is the ordinal of the thread's latest top-level user message, a wake
// message included; false when it has none. The highest ordinal, not the last in the
// log: a queued message Claude read late sits after newer ones.
func lastMessage(items []thread.Item) (int64, bool) {
	var last int64
	for i := range items {
		if it := &items[i]; it.Kind == thread.KindUserMessage && it.ParentToolUseID == "" && it.Ordinal > last {
			last = it.Ordinal
		}
	}
	return last, last > 0
}

// isReaction: it (nil for an event without an item) shows Claude reacted after the
// item with ordinal after: a top-level turn end, error, permission request or question
// that follows it.
func isReaction(it *thread.Item, after int64) bool {
	if it == nil || it.Ordinal <= after || it.ParentToolUseID != "" {
		return false
	}
	switch it.Kind {
	case thread.KindTurnEnd, thread.KindError, thread.KindPermission, thread.KindQuestion:
		return true
	}
	return false
}

// eventItem is the item an item event carries; nil for the others.
func eventItem(ev thread.ThreadEvent) *thread.Item {
	switch e := ev.(type) {
	case thread.ItemAppended:
		return &e.Item
	case thread.ItemUpdated:
		return &e.Item
	}
	return nil
}

// threadWaitConditions maps the wait conditions to the store's (UNSPECIFIED is IDLE).
var threadWaitConditions = map[v1.ThreadWaitCondition]thread.Condition{
	v1.ThreadWaitCondition_THREAD_WAIT_CONDITION_UNSPECIFIED:  thread.CondIdle,
	v1.ThreadWaitCondition_THREAD_WAIT_CONDITION_IDLE:         thread.CondIdle,
	v1.ThreadWaitCondition_THREAD_WAIT_CONDITION_ATTENTION:    thread.CondAttention,
	v1.ThreadWaitCondition_THREAD_WAIT_CONDITION_ERROR:        thread.CondError,
	v1.ThreadWaitCondition_THREAD_WAIT_CONDITION_DISCONNECTED: thread.CondDisconnected,
}

// threadWaitMet reports whether t meets the wait condition (ThreadWaitCondition in
// thread_lifecycle.proto): thread.Meets, which the wake subscriptions share.
func threadWaitMet(until v1.ThreadWaitCondition, t thread.Thread) bool {
	c, ok := threadWaitConditions[until]
	if !ok {
		c = thread.CondIdle
	}
	return thread.Meets(c, t)
}
