package thread

import (
	"cmp"
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
// "siblings": how many of the subscriber's live children have settled, and the others
// still working or waiting on an answer, counted when the wake is sent.
//
// A lead that ends a turn with a fresh progress report while its own children work is
// only waiting on them: its settled wake is held (counted in FiredCount, logged "wake
// held: lead still has N workers", not sent) and its parent wakes on its next settle.

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
// Working and Pending (a permission prompt or question waiting) list the others.
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
	Kind  string              `json:"kind"` // "batch"
	Wakes []wakeThreadPayload `json:"wakes"`
}

// joinsBatchLocked reports whether a thread wake for subscriber queued now joins one
// already waiting: drain holds one open, or one is queued behind a delivery in flight.
// Callers hold m.subs.mu.
func (m *Manager) joinsBatchLocked(subscriber string) bool {
	if m.opts.WakeBatch <= 0 {
		return false
	}
	q := m.subs.queues[subscriber]
	return q != nil && (q.holding || slices.ContainsFunc(q.items, func(d delivery) bool { return d.thread != nil }))
}

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
				if d.thread != nil && d.queued.Add(window).After(due) {
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
					if d.thread != nil {
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
// workers (heldLeadWake), counts the subscriber's children for those about them, and
// sends the rest as one message. A batch that sends nothing gives its wake limit slot
// back.
func (m *Manager) deliverThreadWakes(subscriber string, batch []delivery) {
	ctx := m.ctx
	parts := make([]threadWakePart, 0, len(batch))
	subs := make([]string, 0, len(batch))
	var slots []time.Time
	for _, d := range batch {
		if !d.slot.IsZero() {
			slots = append(slots, d.slot)
		}
		p := d.thread(ctx)
		if heldLeadWake(p) {
			n := p.d.children.Working
			m.log.Info("wake held: lead still has "+strconv.Itoa(n)+" workers", "thread", subscriber, "subscription", d.sub,
				"target", p.t.ID, "workers", n)
			continue
		}
		parts, subs = append(parts, p), append(subs, d.sub)
	}
	if len(parts) == 0 {
		s := m.subs
		s.mu.Lock()
		s.refundLocked(subscriber, slots)
		s.mu.Unlock()
		return
	}
	snap := m.Snapshot()
	if st, ok := snap.Thread(subscriber); !ok || !st.ArchivedAt.IsZero() {
		// Archived or removed while the batch waited: a wake must not bring it back.
		m.log.Info("wake not delivered: the subscriber is gone or archived", "thread", subscriber, "subscriptions", subs)
		return
	}
	if sib := siblingsOf(snap, subscriber, parts); sib != nil {
		for i := range parts {
			if parts[i].t.CreatedBy == subscriber {
				parts[i].d.siblings = sib
			}
		}
	}
	var msg Message
	if len(parts) == 1 {
		p := parts[0]
		msg = threadWake(p.sub, p.t, p.at, p.d)
	} else {
		msg = batchWake(parts)
	}
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

// heldLeadWake reports whether p is a lead only waiting on its workers: a repeat
// settled subscription, a turn that ended plainly (idle, or finished) with a progress
// report filed in it, and children still working. Its parent is woken on its next
// settle instead.
func heldLeadWake(p threadWakePart) bool {
	t := p.t
	ended := t.Status == StatusIdle || (t.Status == StatusNeedsAttention && t.StatusReason == "finished")
	return p.sub.Condition == CondSettled && p.sub.Repeat && ended && t.Report.Status == ReportProgress &&
		!p.d.staleReport && p.d.children.Working > 0
}

// siblingsOf counts subscriber's live children for parts' wakes about them, nil when
// none is about one: the targets as they fired, the others as snap has them.
func siblingsOf(snap *Snapshot, subscriber string, parts []threadWakePart) *wakeSiblings {
	fired := map[string]Thread{}
	for _, p := range parts {
		if p.t.CreatedBy == subscriber {
			fired[p.t.ID] = p.t
		}
	}
	if len(fired) == 0 {
		return nil
	}
	kids := make([]Thread, 0, len(snap.Threads))
	for _, k := range snap.Threads {
		if k.CreatedBy == subscriber && k.ArchivedAt.IsZero() && !k.Removing {
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
		s.Total++
		settled := Meets(CondSettled, k)
		if settled {
			s.Settled++
		}
		switch {
		case isTarget:
		case !settled:
			s.Working = append(s.Working, wakeSibling{ID: k.ID, Name: k.Name})
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
	p := wakeBatchPayload{Kind: "batch", Wakes: make([]wakeThreadPayload, 0, len(parts))}
	titles := make([]string, 0, len(parts))
	settled := true
	var sib *wakeSiblings
	for _, part := range parts {
		p.Wakes = append(p.Wakes, threadWakePayload(part.sub, part.t, part.at, part.d))
		titles = append(titles, threadWakeTitle(part.sub.Condition, part.t, part.d))
		settled = settled && part.sub.Condition == CondSettled
		sib = cmp.Or(sib, part.d.siblings)
	}
	head := strconv.Itoa(len(parts)) + " thread wakes: "
	if settled {
		head = strconv.Itoa(len(parts)) + " threads settled: "
	}
	return wakeMessage(joinSentences(head+strings.Join(titles, " "), siblingsSentence(sib)), p)
}

// joinSentences joins a and b with a space; a alone when b is "".
func joinSentences(a, b string) string {
	if b == "" {
		return a
	}
	return a + " " + b
}
