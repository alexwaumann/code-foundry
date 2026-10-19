package thread

import (
	"cmp"
	"slices"
	"strings"
	"time"
)

// The removed wake (docs/notes/removed-thread-signal.md). Removing a thread deletes the
// subscriptions to it; before they go, each subscriber is told once, whatever it
// subscribed to, that the thread was removed:
//
//	[code-foundry wake] Thread "Write retry backoff tests" (s-…) was removed.
//	```json
//	{ "kind": "thread", "subscription_id": "sub-…", "condition": "removed", "fired_at": "…",
//	  "thread": { "id": "s-…", …, "removed_at": "…", "report": { … } } }
//	```
//
// While Remove closes the thread it meets no condition (Thread.Removing), so the
// closing snapshot does not fire a settled wake first.

// CondRemoved is the condition of the wake a removal sends. Nothing subscribes to it:
// every subscription to a thread gets it.
const CondRemoved Condition = "removed"

type wakeRemovedPayload struct {
	Kind           string            `json:"kind"`
	SubscriptionID string            `json:"subscription_id"`
	Condition      Condition         `json:"condition"`
	FiredAt        string            `json:"fired_at"`
	Thread         wakeRemovedThread `json:"thread"`
}

type wakeRemovedThread struct {
	ID        string      `json:"id"`
	Name      string      `json:"name"`
	ProjectID string      `json:"project_id"`
	CreatedBy string      `json:"created_by"`
	Labels    []string    `json:"labels"`
	RemovedAt string      `json:"removed_at"`
	Report    *wakeReport `json:"report"`
}

// fireRemovedLocked sends the removed wake about r, just removed, to each thread
// subscribed to it: once per subscriber, under its oldest subscription. forgetLocked
// deletes the subscriptions after it. Callers hold m.mu.
func (m *Manager) fireRemovedLocked(r RemovedThread) {
	if m.subs == nil {
		return
	}
	s := m.subs
	s.mu.Lock()
	defer s.mu.Unlock()
	var hit []*subRec
	for _, sr := range s.byID {
		if sr.s.TargetKind == TargetThread && sr.s.TargetID == r.ID {
			hit = append(hit, sr)
		}
	}
	slices.SortFunc(hit, func(a, b *subRec) int {
		return cmp.Or(a.s.CreatedAt.Compare(b.s.CreatedAt), strings.Compare(a.s.ID, b.s.ID))
	})
	told := map[string]bool{}
	for _, sr := range hit {
		if told[sr.s.SubscriberID] {
			continue
		}
		told[sr.s.SubscriberID] = true
		m.fireLocked(sr, func(sub Subscription, at time.Time) Message { return removedWake(sub, r, at) })
	}
}

// removedWake is the removed wake of sub about r, fired at.
func removedWake(sub Subscription, r RemovedThread, at time.Time) Message {
	p := wakeRemovedPayload{Kind: "thread", SubscriptionID: sub.ID, Condition: CondRemoved, FiredAt: wakeTime(at), Thread: wakeRemovedThread{
		ID: r.ID, Name: r.Name, ProjectID: r.ProjectID, CreatedBy: r.CreatedBy, Labels: r.Labels,
		RemovedAt: wakeTime(r.RemovedAt), Report: wakeReportOf(r.Report),
	}}
	if p.Thread.Labels == nil {
		p.Thread.Labels = []string{}
	}
	return wakeMessage("Thread "+r.Label()+" was removed.", p)
}
