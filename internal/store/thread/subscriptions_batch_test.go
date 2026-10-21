package thread

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"
	"time"
)

// batchEnv is a parent with n children it subscribed to (settled, repeat: --notify),
// all busy.
type batchEnv struct {
	*env
	parent Thread
	kids   []Thread
	subs   []string
}

func newBatchEnv(t *testing.T, n int, mutate ...func(*Options)) *batchEnv {
	t.Helper()
	b := &batchEnv{env: newEnv(t, mutate...)}
	b.parent = b.stopped("parent")
	for i := range n {
		k := b.stopped("c" + string(rune('0'+i)))
		if _, ok := b.m.update(k.ID, false, func(rec *record) { rec.s.CreatedBy = b.parent.ID }); !ok {
			t.Fatal("no child")
		}
		b.setStep(k.ID, busy)
		res, err := b.m.Subscribe(b.ctx(), SubscribeOptions{SubscriberID: b.parent.ID, TargetThreadID: k.ID, Repeat: true})
		if err != nil {
			t.Fatal(err)
		}
		k, _ = b.m.Snapshot().Thread(k.ID)
		b.kids, b.subs = append(b.kids, k), append(b.subs, res.Subscription.ID)
	}
	return b
}

// wakeSizes is how many thread wakes each wake message holds, in order.
func wakeSizes(t *testing.T, items []Item) []int {
	t.Helper()
	var out []int
	for _, w := range wakes(items) {
		var p struct {
			Kind  string            `json:"kind"`
			Wakes []json.RawMessage `json:"wakes"`
		}
		if err := json.Unmarshal([]byte(w.WakeJSON), &p); err != nil {
			t.Fatalf("wake JSON: %v\n%s", err, w.WakeJSON)
		}
		if p.Kind == "batch" {
			out = append(out, len(p.Wakes))
		} else {
			out = append(out, 1)
		}
	}
	return out
}

func sum(ns []int) int {
	n := 0
	for _, x := range ns {
		n += x
	}
	return n
}

// The batch window: thread wakes to one subscriber that fire within the window of the
// last one are one message; later ones are another; without batching each goes alone.
func TestWakeBatchWindow(t *testing.T) {
	const w = 300 * time.Millisecond
	// A plan's steps: settle child i (>= 0), sleep, or wait for n messages.
	type do struct {
		settle int
		sleep  time.Duration
		wait   int
	}
	settle := func(i int) do { return do{settle: i} }
	sleep := func(d time.Duration) do { return do{settle: -1, sleep: d} }
	wait := func(n int) do { return do{settle: -1, wait: n} }
	tests := []struct {
		name  string
		batch time.Duration
		plan  []do
		want  []int // thread wakes per message
	}{
		{"a burst is one message", w, []do{settle(0), settle(1), settle(2)}, []int{3}},
		{"each within the window of the last", w, []do{settle(0), sleep(w / 2), settle(1), sleep(w / 2), settle(2)}, []int{3}},
		{"after the window: another message", w, []do{settle(0), wait(1), settle(1), settle(2)}, []int{1, 2}},
		{"no batching: each alone", -1, []do{settle(0), settle(1), settle(2)}, []int{1, 1, 1}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			b := newBatchEnv(t, 4, func(o *Options) { o.WakeBatch = tt.batch })
			for _, s := range tt.plan {
				switch {
				case s.settle >= 0:
					b.setStep(b.kids[s.settle].ID, finished)
				case s.wait > 0:
					b.waitItems(b.parent.ID, "the messages", func(items []Item) bool { return len(wakes(items)) == s.wait })
				default:
					time.Sleep(s.sleep)
				}
			}
			b.waitItems(b.parent.ID, "the wakes", func(items []Item) bool { return sum(wakeSizes(t, items)) == sum(tt.want) })
			time.Sleep(w / 3) // nothing more comes
			items := b.items(b.parent.ID).Items
			if got := wakeSizes(t, items); !slices.Equal(got, tt.want) {
				t.Errorf("messages = %v, want %v:\n%s", got, tt.want, describeItems(items))
			}
			for i, id := range b.subs[:sum(tt.want)] {
				if got, _ := b.subscription(id); got.FiredCount != 1 {
					t.Errorf("child %d fired %d times, want 1", i, got.FiredCount)
				}
			}
		})
	}
}

// A batch is bounded: wakes that keep coming within the window still go out once
// wakeBatchHold windows have passed since the first.
func TestWakeBatchHoldBounded(t *testing.T) {
	const w = 60 * time.Millisecond
	b := newBatchEnv(t, 8, func(o *Options) { o.WakeBatch = w })
	for _, k := range b.kids {
		b.setStep(k.ID, finished)
		time.Sleep(w * 4 / 5)
	}
	items := b.waitItems(b.parent.ID, "every wake", func(items []Item) bool { return sum(wakeSizes(t, items)) == 8 })
	if got := wakeSizes(t, items); len(got) < 2 {
		t.Errorf("messages = %v: 8 wakes 0.8 windows apart span more than %d windows", got, wakeBatchHold)
	}
}

// One message for a burst: the header lists each thread and ends with the siblings
// sentence; the JSON is the per-thread payloads, each with the siblings counts.
func TestWakeBatchMessage(t *testing.T) {
	b := newBatchEnv(t, 4, func(o *Options) { o.WakeBatch = 100 * time.Millisecond })
	if _, err := b.m.Report(b.ctx(), b.kids[0].ID, Report{Status: ReportDone, Summary: "ok"}); err != nil {
		t.Fatal(err)
	}
	b.setStep(b.kids[0].ID, finished)
	b.setStep(b.kids[1].ID, askBash)
	b.setStep(b.kids[2].ID, finished)
	items := b.waitItems(b.parent.ID, "the batch", func(items []Item) bool { return len(wakes(items)) == 1 })
	w := wakes(items)[0]
	k := b.kids
	want := `3 threads settled: Thread "c0" (` + k[0].ID + `) needs attention: finished. Report: done — ok. ` +
		`Thread "c1" (` + k[1].ID + `) needs attention: permission: Bash ls. ` +
		`Thread "c2" (` + k[2].ID + `) needs attention: finished without a report. ` +
		`3 of your 4 child threads settled; still working: "c3" (` + k[3].ID + `).`
	if w.WakeTitle != want {
		t.Errorf("title =\n%s\nwant\n%s", w.WakeTitle, want)
	}
	if !strings.HasPrefix(w.Text, wakePrefix+want+"\n```json\n") {
		t.Errorf("text = %q", w.Text)
	}
	var p struct {
		Kind  string `json:"kind"`
		Wakes []struct {
			Kind           string `json:"kind"`
			SubscriptionID string `json:"subscription_id"`
			Thread         struct {
				ID       string        `json:"id"`
				Siblings *wakeSiblings `json:"siblings"`
			} `json:"thread"`
		} `json:"wakes"`
	}
	if err := json.Unmarshal([]byte(w.WakeJSON), &p); err != nil {
		t.Fatal(err)
	}
	if p.Kind != "batch" || len(p.Wakes) != 3 {
		t.Fatalf("payload:\n%s", w.WakeJSON)
	}
	for i, wk := range p.Wakes {
		sib := wk.Thread.Siblings
		if wk.Kind != "thread" || wk.SubscriptionID != b.subs[i] || wk.Thread.ID != k[i].ID || sib == nil ||
			sib.Settled != 3 || sib.Total != 4 || len(sib.Working) != 1 || sib.Working[0].ID != k[3].ID || len(sib.Pending) != 0 {
			t.Errorf("wake %d: %+v (siblings %+v)", i, wk, sib)
		}
	}
}

// A batch takes one slot of the wake limit, however many wakes it holds.
func TestWakeBatchLimit(t *testing.T) {
	b := newBatchEnv(t, 4, func(o *Options) { o.WakeBatch = 100 * time.Millisecond; o.WakeLimit = 2 })
	for _, k := range b.kids[:3] {
		b.setStep(k.ID, finished)
	}
	b.waitItems(b.parent.ID, "the batch", func(items []Item) bool { return len(wakes(items)) == 1 })
	b.setStep(b.kids[3].ID, finished)
	items := b.waitItems(b.parent.ID, "the second message", func(items []Item) bool { return len(wakes(items)) == 2 })
	if got := wakeSizes(t, items); !slices.Equal(got, []int{3, 1}) {
		t.Errorf("messages = %v, want [3 1]", got)
	}
	for _, it := range items {
		if it.Kind == KindNote && strings.HasPrefix(it.Text, "Wake limit reached") {
			t.Errorf("the limit was reached: %s", it.Text)
		}
	}
}

func TestSiblingsOf(t *testing.T) {
	kid := func(id string, s step) Thread {
		return Thread{ID: id, Name: "n" + id, CreatedBy: "p", State: s.st, Status: s.status, StatusReason: s.reason, PendingRequestID: s.req}
	}
	archived := kid("s-arch", busy)
	archived.ArchivedAt = time.Now()
	other := kid("s-other", busy)
	other.CreatedBy = "q"
	removing := kid("s-rm", busy)
	removing.Removing = true
	withReport := func(th Thread, st ReportStatus) Thread {
		th.Report = Report{Status: st, Summary: "x"}
		return th
	}
	worker := func(id, lead string, s step) Thread {
		w := kid(id, s)
		w.CreatedBy = lead
		return w
	}
	// e2-4: the current request began at since; old is a child made and last active
	// before it, recent one active after it.
	since := time.Date(2026, 10, 21, 1, 0, 0, 0, time.UTC)
	old := func(th Thread) Thread {
		th.CreatedAt, th.LastActivityAt = since.Add(-time.Hour), since.Add(-time.Minute)
		return th
	}
	recent := func(th Thread) Thread {
		th.CreatedAt, th.LastActivityAt = since.Add(-time.Hour), since.Add(time.Minute)
		return th
	}
	tests := []struct {
		name    string
		threads []Thread
		parts   []Thread // the wakes' targets as they fired
		want    *wakeSiblings
		since   time.Time
	}{
		{"not a child: none", []Thread{other}, []Thread{other}, nil, time.Time{}},
		{"an only child", []Thread{kid("s-1", busy)}, []Thread{kid("s-1", finished)},
			&wakeSiblings{Settled: 1, Total: 1, Working: []wakeSibling{}, Pending: []wakeSiblingPending{}}, time.Time{}},
		{"the target as it fired, others as they are now",
			[]Thread{kid("s-1", busy), kid("s-2", busy), kid("s-3", askEdit1), kid("s-4", atPrompt), archived, other, removing},
			[]Thread{kid("s-1", finished)},
			&wakeSiblings{Settled: 3, Total: 4, Working: []wakeSibling{{"s-2", "ns-2"}},
				Pending: []wakeSiblingPending{{"s-3", "ns-3", "permission: Edit README.md"}}}, time.Time{}},
		{"a stopped child's old prompt is not pending", []Thread{kid("s-1", finished), kid("s-2", offAsking)}, []Thread{kid("s-1", finished)},
			&wakeSiblings{Settled: 2, Total: 2, Working: []wakeSibling{}, Pending: []wakeSiblingPending{}}, time.Time{}},
		// A lead whose own workers run is still working, whatever its report (its
		// settled wake was held, or went for a report of its own); with its workers
		// settled, it is not. A worker's own lead waiting on workers counts too.
		{"a lead waiting on its workers is working",
			[]Thread{kid("s-1", busy), withReport(kid("s-2", finished), ReportProgress), worker("w-1", "s-2", busy),
				withReport(kid("s-3", finished), ReportDone), worker("w-2", "s-3", busy),
				withReport(kid("s-4", finished), ReportProgress), worker("w-3", "s-4", finished),
				kid("s-5", finished), worker("w-4", "s-5", finished), worker("w-5", "w-4", busy)},
			[]Thread{kid("s-1", finished)},
			&wakeSiblings{Settled: 2, Total: 5, Working: []wakeSibling{{"s-2", "ns-2"}, {"s-3", "ns-3"}, {"s-5", "ns-5"}},
				Pending: []wakeSiblingPending{}}, time.Time{}},
		// D2: the lead that fired, its workers running, is working too, and listed.
		{"a target lead with workers running is working",
			[]Thread{kid("s-1", busy), kid("s-2", finished), worker("w-1", "s-1", busy), worker("w-2", "s-1", finished)},
			[]Thread{kid("s-1", finished)},
			&wakeSiblings{Settled: 1, Total: 2, Working: []wakeSibling{{"s-1", "ns-1"}}, Pending: []wakeSiblingPending{}}, time.Time{}},
		{"two targets in a batch are not listed", []Thread{kid("s-1", busy), kid("s-2", busy), kid("s-3", busy)},
			[]Thread{kid("s-1", finished), kid("s-2", askBash)},
			&wakeSiblings{Settled: 2, Total: 3, Working: []wakeSibling{{"s-3", "ns-3"}}, Pending: []wakeSiblingPending{}}, time.Time{}},
		// e2-4: only the current batch counts.
		{"children settled before the request are left out",
			[]Thread{recent(kid("s-1", busy)), old(kid("s-2", finished)), old(kid("s-3", atPrompt)), recent(kid("s-4", busy))},
			[]Thread{recent(kid("s-1", finished))},
			&wakeSiblings{Settled: 1, Total: 2, Working: []wakeSibling{{"s-4", "ns-4"}}, Pending: []wakeSiblingPending{}}, since},
		{"an only worker of this request after earlier ones: alone",
			[]Thread{old(kid("s-1", finished)), recent(kid("s-2", busy))}, []Thread{recent(kid("s-2", finished))},
			&wakeSiblings{Settled: 1, Total: 1, Working: []wakeSibling{}, Pending: []wakeSiblingPending{}}, since},
		{"settled after the request began: counted",
			[]Thread{recent(kid("s-1", busy)), recent(kid("s-2", finished))}, []Thread{recent(kid("s-1", finished))},
			&wakeSiblings{Settled: 2, Total: 2, Working: []wakeSibling{}, Pending: []wakeSiblingPending{}}, since},
		{"working from before the request: counted",
			[]Thread{recent(kid("s-1", busy)), old(kid("s-2", busy))}, []Thread{recent(kid("s-1", finished))},
			&wakeSiblings{Settled: 1, Total: 2, Working: []wakeSibling{{"s-2", "ns-2"}}, Pending: []wakeSiblingPending{}}, since},
		{"a lead from before whose workers run: counted",
			[]Thread{recent(kid("s-1", busy)), old(kid("s-2", finished)), worker("w-1", "s-2", busy)}, []Thread{recent(kid("s-1", finished))},
			&wakeSiblings{Settled: 1, Total: 2, Working: []wakeSibling{{"s-2", "ns-2"}}, Pending: []wakeSiblingPending{}}, since},
		{"a target is counted however old", []Thread{old(kid("s-1", finished)), old(kid("s-2", finished))},
			[]Thread{old(kid("s-1", finished))},
			&wakeSiblings{Settled: 1, Total: 1, Working: []wakeSibling{}, Pending: []wakeSiblingPending{}}, since},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var parts []threadWakePart
			for _, th := range tt.parts {
				parts = append(parts, threadWakePart{t: th})
			}
			got := siblingsOf(&Snapshot{Threads: tt.threads}, "p", parts, tt.since)
			gj, _ := json.Marshal(got)
			wj, _ := json.Marshal(tt.want)
			if string(gj) != string(wj) {
				t.Errorf("siblings = %s, want %s", gj, wj)
			}
		})
	}
}

func TestSiblingsSentence(t *testing.T) {
	ws := func(ids ...string) []wakeSibling {
		var out []wakeSibling
		for _, id := range ids {
			out = append(out, wakeSibling{ID: id, Name: "T" + id})
		}
		return out
	}
	tests := []struct {
		name string
		s    *wakeSiblings
		want string
	}{
		{"none", nil, ""},
		{"an only child", &wakeSiblings{Settled: 1, Total: 1}, ""},
		{"all settled", &wakeSiblings{Settled: 4, Total: 4}, "All 4 of your child threads settled."},
		{"one working", &wakeSiblings{Settled: 3, Total: 4, Working: ws("s-4")}, `3 of your 4 child threads settled; still working: "Ts-4" (s-4).`},
		{"unnamed", &wakeSiblings{Settled: 1, Total: 2, Working: []wakeSibling{{ID: "s-2"}}}, `1 of your 2 child threads settled; still working: s-2.`},
		{"many working", &wakeSiblings{Settled: 1, Total: 6, Working: ws("a", "b", "c", "d", "e")},
			`1 of your 6 child threads settled; still working: "Ta" (a), "Tb" (b), "Tc" (c) and 2 more.`},
		{"one asking", &wakeSiblings{Settled: 2, Total: 2, Pending: []wakeSiblingPending{{ID: "s-2", Name: "Docs", Reason: "permission: Bash"}}},
			`2 of your 2 child threads settled; waiting on an answer: "Docs" (s-2).`},
		{"working and asking", &wakeSiblings{Settled: 2, Total: 3, Working: ws("s-3"), Pending: []wakeSiblingPending{{ID: "s-2"}}},
			`2 of your 3 child threads settled; still working: "Ts-3" (s-3); waiting on an answer: s-2.`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := siblingsSentence(tt.s); got != tt.want {
				t.Errorf("sentence =\n%s\nwant\n%s", got, tt.want)
			}
		})
	}
	// A single wake about a child ends with it, and its JSON has the counts.
	th := Thread{ID: "s-1", Name: "A", CreatedBy: "p", State: StateConnected, Status: StatusIdle, StatusReason: "at prompt"}
	msg := threadWake(Subscription{ID: "sub-1", Condition: CondSettled}, th, time.Now(), wakeDetail{siblings: &wakeSiblings{Settled: 1, Total: 2,
		Working: ws("s-2"), Pending: []wakeSiblingPending{}}})
	if want := `Thread "A" (s-1) is idle: at prompt. 1 of your 2 child threads settled; still working: "Ts-2" (s-2).`; msg.WakeTitle != want {
		t.Errorf("title = %s", msg.WakeTitle)
	}
	if !strings.Contains(msg.WakeJSON, `"siblings": {`) || !strings.Contains(msg.WakeJSON, `"pending": []`) {
		t.Errorf("JSON:\n%s", msg.WakeJSON)
	}
}

// A batch whose wakes are all held sends nothing and gives its slot back.
func TestRefundLocked(t *testing.T) {
	t0 := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	s := &subscriptions{sent: map[string][]time.Time{"p": {t0, t0.Add(time.Second), t0.Add(time.Second)}}}
	s.refundLocked("p", []time.Time{t0.Add(time.Second), t0.Add(time.Hour)})
	if got := s.sent["p"]; !slices.Equal(got, []time.Time{t0, t0.Add(time.Second)}) {
		t.Errorf("sent = %v", got)
	}
}
