package thread

import (
	"cmp"
	"context"
	"slices"
	"strconv"
	"strings"
	"time"
)

// Batched thread wakes, sibling counts and held lead wakes
// (docs/notes/orch-wakes-content.md).
//
// Children of one orchestrator often settle together, milliseconds to a second apart.
// Delivered one by one, the first wake starts a turn that tells the user "the others
// are still running" while their wakes wait in the queue. So a thread wake is not sent
// at once: the subscriber's drain holds it until Options.WakeBatch (WakeBatchWindow, 1 s)
// has passed since the last thread wake for that subscriber was queued, at most
// wakeBatchHold windows after the first, and every thread wake queued meanwhile (or
// while an earlier delivery was in flight) joins it. One joined is one message:
//
//	[code-foundry wake] 2 threads settled: Thread "A" (s-1) is idle: finished. Report: done — ok. Thread "B" (s-2) needs attention: permission: Bash ls. 3 of your 4 child threads settled; still working: "Tests" (s-3).
//	```json
//	{ "kind": "batch", "wakes": [ { "kind": "thread", … }, { "kind": "thread", … } ] }
//	```
//
// A batch takes one slot of the wake limit (fireLaterLocked). Run, pull request, plugin
// and removed wakes are not batched.
//
// A wake about one of the subscriber's own children (created_by the subscriber) carries
// "siblings": how many of the subscriber's live children in the current batch have
// settled, and the others still working or waiting on an answer, counted when the wake
// is sent. The batch is the children at work since the subscriber's last message from
// the user (not a wake): a child that settled before it belongs to an earlier request.
//
// A lead that ends a turn while its own children work is only waiting on them: its
// settled wake is held (counted in FiredCount, logged "wake held: lead still has N
// workers", not sent) until its team settled (subscriptions_hold.go).

// WakeBatchWindow is how long a thread wake waits for others to the same subscriber
// (Options.WakeBatch's default).
const WakeBatchWindow = time.Second

// wakeBatchHold bounds a batch: it goes at most this many windows after its first wake
// was queued, however many keep joining.
const wakeBatchHold = 5

// threadWakePart is one thread wake, built when it is sent: its subscription, the
// target as it fired, when, and the detail its items held.
type threadWakePart struct {
	sub Subscription
	t   Thread
	at  time.Time
	d   wakeDetail
}

// wakeSiblings counts the subscriber's live children (created_by it, not archived) for
// a wake about one of them: Settled of Total, the target(s) included as they fired;
// Working and Pending (a permission prompt or question waiting) list the others. A
// lead waiting on its workers (siblingsOf) is working.
type wakeSiblings struct {
	Settled int                  `json:"settled"`
	Total   int                  `json:"total"`
	Working []wakeSibling        `json:"working"`
	Pending []wakeSiblingPending `json:"pending"`
}

type wakeSibling struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type wakeSiblingPending struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Reason string `json:"reason"`
}

// wakeBatchPayload is the JSON of thread wakes sent as one message.
type wakeBatchPayload struct {
	Kind  string `json:"kind"`  // "batch"
	Wakes []any  `json:"wakes"` // wakeThreadPayload; a restart's notice first (wakeRestartPayload)
}

// joinsBatchLocked reports whether a thread wake for subscriber queued now joins one
// already waiting: drain holds one open, or one is queued behind a delivery in flight.
// Callers hold m.subs.mu.
func (m *Manager) joinsBatchLocked(subscriber string) bool {
	if m.opts.WakeBatch <= 0 {
		return false
	}
	q := m.subs.queues[subscriber]
	return q != nil && (q.holding || slices.ContainsFunc(q.items, delivery.batched))
}

// batched reports whether d goes through the batch path: a thread wake, or a restart's
// wakes.
func (d delivery) batched() bool { return d.thread != nil || d.restart != nil }

// collectBatch waits out first's batch window and takes it with every thread wake queued
// for subscriber meanwhile (the other deliveries keep their order). The window ends
// Options.WakeBatch after the latest of them was queued, at most wakeBatchHold windows
// after first; at once when the Manager stops.
func (m *Manager) collectBatch(subscriber string, first delivery) []delivery {
	window := m.opts.WakeBatch
	if window <= 0 {
		return []delivery{first}
	}
	s := m.subs
	limit := first.queued.Add(wakeBatchHold * window)
	for {
		s.mu.Lock()
		q := s.queues[subscriber]
		due := first.queued.Add(window)
		if q != nil {
			for _, d := range q.items {
				if d.batched() && d.queued.Add(window).After(due) {
					due = d.queued.Add(window)
				}
			}
		}
		if due.After(limit) {
			due = limit
		}
		wait := time.Until(due)
		if wait <= 0 || m.ctx.Err() != nil {
			batch := []delivery{first}
			if q != nil {
				var rest []delivery
				for _, d := range q.items {
					if d.batched() {
						batch = append(batch, d)
					} else {
						rest = append(rest, d)
					}
				}
				q.items, q.holding = rest, false
			}
			s.mu.Unlock()
			return batch
		}
		s.mu.Unlock()
		t := time.NewTimer(wait)
		select {
		case <-t.C:
		case <-m.ctx.Done():
			t.Stop()
		}
	}
}

// deliverThreadWakes builds batch's wakes, holds those of leads still waiting on their
// workers (heldLeadWake, holdLocked), counts the subscriber's children for those about
// them, and sends the rest as one message. A batch that sends nothing gives its wake
// limit slot back.
func (m *Manager) deliverThreadWakes(subscriber string, batch []delivery) {
	ctx := m.ctx
	parts := make([]threadWakePart, 0, len(batch))
	subs := make([]string, 0, len(batch))
	var slots []time.Time
	// A restart's wakes go first (DeliverRestartWakes queues them before anything
	// else); there is one per daemon start.
	var rw *restartWakes
	for _, d := range batch {
		if d.restart == nil {
			continue
		}
		if !d.slot.IsZero() {
			slots = append(slots, d.slot)
		}
		rw = cmp.Or(rw, d.restart)
		for _, build := range d.restart.parts {
			parts = append(parts, build(ctx))
		}
		subs = append(subs, d.restart.subs...)
	}
	for _, d := range batch {
		if d.restart != nil {
			continue
		}
		if !d.slot.IsZero() {
			slots = append(slots, d.slot)
		}
		p := d.thread(ctx)
		if heldLeadWake(p) {
			m.mu.Lock()
			n, held := m.holdLocked(p)
			m.mu.Unlock()
			if held {
				m.log.Info("wake held: lead still has "+strconv.Itoa(n)+" workers", "thread", subscriber, "subscription", d.sub,
					"target", p.t.ID, "workers", n)
				continue
			}
		}
		parts, subs = append(parts, p), append(subs, d.sub)
	}
	if rw != nil && rw.notice.self {
		// The user's message its cut turn was handling (restartcut.go).
		if items, err := m.Items(ctx, subscriber); err != nil {
			m.log.Warn("restart notice: read the thread's items", "thread", subscriber, "err", err)
		} else {
			rw.ownTurn(items.Items)
		}
	}
	snap := m.Snapshot()
	parts = archivedTargets(snap, parts) // archive_wakes.go
	if rw != nil {
		var left bool
		if parts, left = rw.keepLive(snap, parts); !left {
			rw = nil
		}
	}
	if len(parts) == 0 && rw == nil {
		s := m.subs
		s.mu.Lock()
		s.refundLocked(subscriber, slots)
		s.mu.Unlock()
		return
	}
	if st, ok := snap.Thread(subscriber); !ok || !st.ArchivedAt.IsZero() {
		// Archived or removed while the batch waited: a wake must not bring it back.
		m.log.Info("wake not delivered: the subscriber is gone or archived", "thread", subscriber, "subscriptions", subs)
		return
	}
	if sib := siblingsOf(snap, subscriber, parts, m.requestStart(ctx, subscriber, parts)); sib != nil {
		for i := range parts {
			if parts[i].t.CreatedBy == subscriber {
				parts[i].d.siblings = sib
			}
		}
	}
	var msg Message
	if rw != nil {
		msg = restartWake(rw.notice, parts)
	} else if len(parts) == 1 {
		p := parts[0]
		msg = threadWake(p.sub, p.t, p.at, p.d)
	} else {
		msg = batchWake(parts)
	}
	about := make([]string, len(parts))
	for i, p := range parts {
		about[i] = p.t.ID
	}
	msg = m.withWakeNote(subscriber, msg, about)
	if _, err := m.Send(ctx, subscriber, msg); err != nil {
		m.log.Warn("wake not delivered", "thread", subscriber, "subscriptions", subs, "err", err)
		return
	}
	m.log.Info("woke thread", "thread", subscriber, "subscriptions", subs, "wakes", len(parts), "wake", msg.WakeTitle)
}

// refundLocked gives back the wake limit slots of wakes that were not sent. Callers
// hold s.mu.
func (s *subscriptions) refundLocked(subscriber string, slots []time.Time) {
	for _, at := range slots {
		if i := slices.Index(s.sent[subscriber], at); i >= 0 {
			s.sent[subscriber] = slices.Delete(s.sent[subscriber], i, i+1)
		}
	}
}

// requestStart is when subscriber's current request began, for the siblings count: its
// last top-level message from the user (not a wake); zero when parts are about none of
// its children, or it has no such message.
func (m *Manager) requestStart(ctx context.Context, subscriber string, parts []threadWakePart) time.Time {
	if !slices.ContainsFunc(parts, func(p threadWakePart) bool { return p.t.CreatedBy == subscriber }) {
		return time.Time{}
	}
	items, err := m.Items(ctx, subscriber)
	if err != nil {
		m.log.Warn("siblings: read the subscriber's items", "thread", subscriber, "err", err)
		return time.Time{}
	}
	for i := len(items.Items) - 1; i >= 0; i-- {
		if it := items.Items[i]; it.Kind == KindUserMessage && it.ParentToolUseID == "" && it.Origin == OriginUser {
			return it.CreatedAt
		}
	}
	return time.Time{}
}

// siblingsOf counts subscriber's live children for parts' wakes about them, nil when
// none is about one: the targets as they fired, the others as snap has them. A child
// whose own children still work (teamWorking), a target included, counts as working.
// Only the current batch counts: a child settled whose last activity and creation are
// both before since (requestStart; zero: every child) settled for an earlier request
// and is left out, unless a wake is about it.
func siblingsOf(snap *Snapshot, subscriber string, parts []threadWakePart, since time.Time) *wakeSiblings {
	fired := map[string]Thread{}
	for _, p := range parts {
		if p.t.CreatedBy == subscriber {
			fired[p.t.ID] = p.t
		}
	}
	if len(fired) == 0 {
		return nil
	}
	all := childIndex(snap.Threads)
	kids := make([]Thread, 0, len(all[subscriber]))
	for _, k := range all[subscriber] {
		if !k.Removing {
			kids = append(kids, k)
		}
	}
	slices.SortFunc(kids, func(a, b Thread) int { return cmp.Or(a.CreatedAt.Compare(b.CreatedAt), strings.Compare(a.ID, b.ID)) })
	s := &wakeSiblings{Working: []wakeSibling{}, Pending: []wakeSiblingPending{}}
	for _, k := range kids {
		f, isTarget := fired[k.ID]
		if isTarget {
			k = f
		}
		// A lead whose workers run is waiting on them (its settled wake is held, or
		// went for a prompt or a report of its own): still working.
		settled := Meets(CondSettled, k) && teamWorking(k.ID, all) == 0
		if settled && !isTarget && k.LastActivityAt.Before(since) && k.CreatedAt.Before(since) {
			continue // settled before the current request: not in this batch
		}
		s.Total++
		if settled {
			s.Settled++
		}
		switch {
		case !settled:
			s.Working = append(s.Working, wakeSibling{ID: k.ID, Name: k.Name})
		case isTarget:
		case requestKey(k) != "":
			s.Pending = append(s.Pending, wakeSiblingPending{ID: k.ID, Name: k.Name, Reason: k.StatusReason})
		}
	}
	return s
}

// Bounds of the siblings sentence: names listed per kind, and each name's length.
const (
	maxSiblingNames = 3
	maxSiblingName  = 40
)

// siblingsSentence is the header's sentence about the subscriber's children: "3 of your
// 4 child threads settled; still working: "Tests" (s-3)." or "All 4 of your child
// threads settled.", with "; waiting on an answer: …" for prompts; "" for nil or a
// single child.
func siblingsSentence(s *wakeSiblings) string {
	if s == nil || s.Total < 2 {
		return ""
	}
	if s.Settled == s.Total && len(s.Pending) == 0 {
		return "All " + strconv.Itoa(s.Total) + " of your child threads settled."
	}
	line := strconv.Itoa(s.Settled) + " of your " + strconv.Itoa(s.Total) + " child threads settled"
	if len(s.Working) > 0 {
		names := make([]string, 0, len(s.Working))
		for _, w := range s.Working {
			names = append(names, siblingLabel(w.ID, w.Name))
		}
		line += "; still working: " + listNames(names)
	}
	if len(s.Pending) > 0 {
		names := make([]string, 0, len(s.Pending))
		for _, p := range s.Pending {
			names = append(names, siblingLabel(p.ID, p.Name))
		}
		line += "; waiting on an answer: " + listNames(names)
	}
	return line + "."
}

// siblingLabel is `"Name" (s-1)`, or the id when unnamed.
func siblingLabel(id, name string) string {
	if name == "" {
		return id
	}
	return strconv.Quote(oneLine(name, maxSiblingName)) + " (" + id + ")"
}

// listNames joins up to maxSiblingNames names with ", " and counts the rest.
func listNames(names []string) string {
	if len(names) <= maxSiblingNames {
		return strings.Join(names, ", ")
	}
	return strings.Join(names[:maxSiblingNames], ", ") + " and " + strconv.Itoa(len(names)-maxSiblingNames) + " more"
}

// batchWake is the one message of several thread wakes, in the order they fired.
func batchWake(parts []threadWakePart) Message {
	p := wakeBatchPayload{Kind: "batch", Wakes: make([]any, 0, len(parts))}
	for _, part := range parts {
		p.Wakes = append(p.Wakes, threadWakePayload(part.sub, part.t, part.at, part.d))
	}
	head, sib := batchHeader(parts)
	return wakeMessage(joinSentences(head, siblingsSentence(sib)), p)
}

// batchHeader is several thread wakes' header without the siblings sentence: "3
// threads settled: " (or "3 thread wakes: ", or after a restart "3 threads
// interrupted: " when the stop interrupted each), then each wake's own; and the
// siblings counts they carry.
func batchHeader(parts []threadWakePart) (string, *wakeSiblings) {
	titles := make([]string, 0, len(parts))
	settled, stopped := true, true
	var sib *wakeSiblings
	for _, part := range parts {
		titles = append(titles, threadWakeTitle(part.sub.Condition, part.t, part.d))
		settled = settled && part.sub.Condition == CondSettled
		stopped = stopped && part.d.appStopped
		sib = cmp.Or(sib, part.d.siblings)
	}
	head := strconv.Itoa(len(parts)) + " thread wakes: "
	switch {
	case stopped:
		head = strconv.Itoa(len(parts)) + " threads interrupted: "
	case settled:
		head = strconv.Itoa(len(parts)) + " threads settled: "
	}
	return head + strings.Join(titles, " "), sib
}

// joinSentences joins a and b with a space; a alone when b is "".
func joinSentences(a, b string) string {
	if b == "" {
		return a
	}
	return a + " " + b
}
