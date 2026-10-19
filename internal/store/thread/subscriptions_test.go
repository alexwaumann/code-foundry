package thread

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestMeets(t *testing.T) {
	th := func(st State, status Status, reason string) Thread {
		return Thread{State: st, Status: status, StatusReason: reason}
	}
	tests := []struct {
		t    Thread
		want map[Condition]bool // conditions not listed are false
	}{
		{th(StateConnected, StatusBusy, "working"), nil},
		{th(StateStarting, StatusBusy, "working"), nil},
		{th(StateStarting, StatusUnknown, "starting"), nil},
		{th(StateConnected, StatusIdle, "at prompt"), map[Condition]bool{CondSettled: true, CondIdle: true}},
		{th(StateConnected, StatusNeedsAttention, "finished"), map[Condition]bool{CondSettled: true, CondIdle: true, CondAttention: true}},
		{th(StateConnected, StatusNeedsAttention, "error: 529"), map[Condition]bool{CondSettled: true, CondIdle: true, CondAttention: true}},
		{th(StateConnected, StatusNeedsAttention, ReasonWakeLimit), map[Condition]bool{CondSettled: true, CondIdle: true, CondAttention: true}},
		{th(StateConnected, StatusNeedsAttention, "permission: Bash ls"), map[Condition]bool{CondSettled: true, CondAttention: true}},
		{th(StateConnected, StatusNeedsAttention, "question: Which?"), map[Condition]bool{CondSettled: true, CondAttention: true}},
		{th(StateDisconnected, StatusError, ReasonInterrupted), map[Condition]bool{CondSettled: true, CondIdle: true, CondError: true, CondDisconnected: true}},
		{th(StateDisconnected, StatusUnknown, ""), map[Condition]bool{CondSettled: true, CondIdle: true, CondDisconnected: true}},
		{th(StateDisconnected, StatusNeedsAttention, ReasonSnoozeEnded), map[Condition]bool{CondSettled: true, CondIdle: true, CondAttention: true, CondDisconnected: true}},
		{th(StateClosing, StatusBusy, "working"), nil},
		// Being removed: the closing snapshot meets nothing (tombstones.go).
		{Thread{State: StateClosing, Status: StatusIdle, StatusReason: "at prompt", Removing: true}, nil},
		{Thread{State: StateDisconnected, Status: StatusError, StatusReason: ReasonInterrupted, Removing: true}, nil},
	}
	for _, tt := range tests {
		for _, c := range append(slices.Clone(ThreadConditions), CondFinished) {
			if got := Meets(c, tt.t); got != tt.want[c] {
				t.Errorf("Meets(%s, %s %s %q) = %v, want %v", c, tt.t.State, tt.t.Status, tt.t.StatusReason, got, tt.want[c])
			}
		}
	}
}

func TestSubscribeTarget(t *testing.T) {
	tests := []struct {
		o        SubscribeOptions
		kind     TargetKind
		cond     Condition
		wantFail bool
	}{
		{o: SubscribeOptions{TargetThreadID: "s-1"}, kind: TargetThread, cond: CondSettled},
		{o: SubscribeOptions{TargetThreadID: "s-1", Condition: CondAttention}, kind: TargetThread, cond: CondAttention},
		{o: SubscribeOptions{TargetThreadID: "s-1", Condition: CondFinished}, wantFail: true},
		{o: SubscribeOptions{TargetThreadID: "s-1", Condition: "soon"}, wantFail: true},
		{o: SubscribeOptions{TargetRunID: "r-1"}, kind: TargetActionRun, cond: CondFinished},
		{o: SubscribeOptions{TargetRunID: "r-1", Condition: CondSettled}, kind: TargetActionRun, cond: CondFinished},
		{o: SubscribeOptions{TargetRunID: "r-1", Condition: CondIdle}, wantFail: true},
		{o: SubscribeOptions{}, wantFail: true},
		{o: SubscribeOptions{TargetThreadID: "s-1", TargetRunID: "r-1"}, wantFail: true},
	}
	for _, tt := range tests {
		kind, _, cond, err := subscribeTarget(tt.o)
		if tt.wantFail {
			if !errors.Is(err, ErrInvalidArgument) {
				t.Errorf("subscribeTarget(%+v) = %v, want invalid argument", tt.o, err)
			}
			continue
		}
		if err != nil || kind != tt.kind || cond != tt.cond {
			t.Errorf("subscribeTarget(%+v) = %s %s %v, want %s %s", tt.o, kind, cond, err, tt.kind, tt.cond)
		}
	}
}

func TestThreadWakeMessage(t *testing.T) {
	at := time.Date(2026, 10, 17, 12, 0, 0, 5e6, time.UTC)
	child := Thread{ID: "s-c", Name: "Write retry backoff tests", State: StateConnected, Status: StatusNeedsAttention,
		StatusReason: "finished", ProjectID: "r1", WorktreePath: "/w", CreatedBy: "s-p", Labels: []string{"tests"},
		Report: Report{Status: ReportDone, Summary: "6 table tests, all passing", Data: `{"n":6}`, At: at}}
	msg := threadWake(Subscription{ID: "sub-1", Condition: CondSettled}, child, at, wakeDetail{})
	wantTitle := `Thread "Write retry backoff tests" (s-c) needs attention: finished. Report: done — 6 table tests, all passing.`
	if msg.WakeTitle != wantTitle || msg.Origin != OriginWake {
		t.Errorf("title = %q (origin %q), want %q", msg.WakeTitle, msg.Origin, wantTitle)
	}
	if !strings.HasPrefix(msg.Text, "[code-foundry wake] "+wantTitle+"\n```json\n{") || !strings.HasSuffix(msg.Text, "}\n```") {
		t.Errorf("text = %q", msg.Text)
	}
	var p struct {
		Kind, SubscriptionID, Condition, FiredAt string
		Thread                                   struct {
			ID, Name, State, Status, StatusReason, ProjectID, WorktreePath, CreatedBy string
			Labels                                                                    []string
			Report                                                                    struct {
				Status, Summary, At string
				Data                map[string]int
			}
		}
	}
	dec := json.NewDecoder(strings.NewReader(msg.WakeJSON))
	if err := dec.Decode(&p); err != nil {
		t.Fatal(err)
	}
	// encoding/json matches the snake_case keys case-insensitively only without the
	// underscores: check those by hand.
	for _, key := range []string{`"subscription_id": "sub-1"`, `"fired_at": "2026-10-17T12:00:00.005Z"`, `"status_reason": "finished"`,
		`"worktree_path": "/w"`, `"created_by": "s-p"`, `"status": "needs_attention"`, `"data": {`} {
		if !strings.Contains(msg.WakeJSON, key) {
			t.Errorf("JSON lacks %s:\n%s", key, msg.WakeJSON)
		}
	}
	if p.Kind != "thread" || p.Condition != "settled" || p.Thread.ID != "s-c" || p.Thread.State != "connected" ||
		!slices.Equal(p.Thread.Labels, []string{"tests"}) || p.Thread.Report.Status != "done" || p.Thread.Report.Data["n"] != 6 {
		t.Errorf("payload = %+v", p)
	}

	// Unnamed, no report, a pending prompt under settled, other conditions.
	plain := Thread{ID: "s-x", State: StateConnected, Status: StatusNeedsAttention, StatusReason: "permission: Bash ls"}
	titles := map[Condition]string{
		CondSettled:      "Thread s-x needs attention: permission: Bash ls.",
		CondAttention:    "Thread s-x needs attention: permission: Bash ls.",
		CondIdle:         "Thread s-x needs attention: permission: Bash ls.",
		CondError:        "Thread s-x has an error: permission: Bash ls.",
		CondDisconnected: "Thread s-x is disconnected: permission: Bash ls.",
	}
	for c, want := range titles {
		if got := threadWakeTitle(c, plain, wakeDetail{}); got != want {
			t.Errorf("title(%s) = %q, want %q", c, got, want)
		}
	}
	if m := threadWake(Subscription{ID: "sub-2", Condition: CondIdle}, plain, at, wakeDetail{}); !strings.Contains(m.WakeJSON, `"labels": []`) ||
		!strings.Contains(m.WakeJSON, `"report": null`) {
		t.Errorf("plain JSON:\n%s", m.WakeJSON)
	}
	long := plain
	long.Report = Report{Status: ReportBlocked, Summary: "line one\nline two " + strings.Repeat("x", 300)}
	if got := threadWakeTitle(CondSettled, long, wakeDetail{}); strings.Contains(got, "\n") || !strings.HasSuffix(got, "…") {
		t.Errorf("long summary title = %q", got)
	}
}

func TestRunWakeMessage(t *testing.T) {
	at := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)
	out := strings.Repeat("a", 5000) + "é" + strings.Repeat("b", 4094)
	msg := runWake(Subscription{ID: "sub-r"}, ActionRun{ID: "r-1", ActionID: "a-1", ActionName: "Test", ProjectID: "r1", Finished: true,
		ExitCode: 3, StartedAt: at, FinishedAt: at.Add(time.Second), Output: out}, at)
	if want := `Action "Test" run r-1 finished with exit 3.`; msg.WakeTitle != want {
		t.Errorf("title = %q, want %q", msg.WakeTitle, want)
	}
	var p struct {
		Kind string `json:"kind"`
		Run  struct {
			ID         string `json:"id"`
			ExitCode   int    `json:"exit_code"`
			FinishedAt string `json:"finished_at"`
			OutputTail string `json:"output_tail"`
		} `json:"run"`
	}
	if err := json.Unmarshal([]byte(msg.WakeJSON), &p); err != nil {
		t.Fatal(err)
	}
	if p.Kind != "action_run" || p.Run.ID != "r-1" || p.Run.ExitCode != 3 || p.Run.FinishedAt != "2026-10-17T12:00:01.000Z" ||
		len(p.Run.OutputTail) > maxOutputTail || !strings.HasSuffix(p.Run.OutputTail, "b") {
		t.Errorf("payload = %+v (tail %d bytes)", p, len(p.Run.OutputTail))
	}
}

// stopped creates a thread and closes it: a row without a process, whose status the
// test sets (setThread) without a runner overriding it.
func (e *env) stopped(name string) Thread {
	e.t.Helper()
	s := e.connected(CreateOptions{Name: name})
	if err := e.m.Close(e.ctx(), s.ID); err != nil {
		e.t.Fatal(err)
	}
	return e.waitFor(s.ID, "stopped", func(s Thread) bool { return s.State == StateDisconnected })
}

// setThread commits a stopped thread as reading st, status and reason.
func (e *env) setThread(id string, st State, status Status, reason string) {
	e.t.Helper()
	if _, ok := e.m.update(id, false, func(rec *record) {
		rec.s.State, rec.s.Status, rec.s.StatusReason = st, status, reason
	}); !ok {
		e.t.Fatalf("no thread %s", id)
	}
}

// subscription returns id's subscription as listed, false when it is gone.
func (e *env) subscription(id string) (Subscription, bool) {
	e.t.Helper()
	subs, err := e.m.Subscriptions(e.ctx(), "")
	if err != nil {
		e.t.Fatal(err)
	}
	i := slices.IndexFunc(subs, func(s Subscription) bool { return s.ID == id })
	if i < 0 {
		return Subscription{}, false
	}
	return subs[i], true
}

// wakes are the wake messages in thread id's items.
func wakes(items []Item) []Item {
	var out []Item
	for _, it := range items {
		if it.Kind == KindUserMessage && it.Origin == OriginWake {
			out = append(out, it)
		}
	}
	return out
}

type step struct {
	st     State
	status Status
	reason string
	req    string // PendingRequestID
}

var (
	busy     = step{StateConnected, StatusBusy, "working", ""}
	finished = step{StateConnected, StatusNeedsAttention, "finished", ""}
	atPrompt = step{StateConnected, StatusIdle, "at prompt", ""}
	askBash  = step{StateConnected, StatusNeedsAttention, "permission: Bash ls", ""}
	crashed  = step{StateDisconnected, StatusError, ReasonInterrupted, ""}
	offIdle  = step{StateDisconnected, StatusIdle, "at prompt", ""}
	budget   = step{StateConnected, StatusNeedsAttention, ReasonBudgetReached, ""}
	// A supervised child's prompts, one after the other (W2A): by reason, then by id.
	askEdit   = step{StateConnected, StatusNeedsAttention, "permission: Edit README.md", ""}
	askWhich  = step{StateConnected, StatusNeedsAttention, "question: Which format?", ""}
	askEdit1  = step{StateConnected, StatusNeedsAttention, "permission: Edit README.md", "req-1"}
	askEdit2  = step{StateConnected, StatusNeedsAttention, "permission: Edit README.md", "req-2"}
	offAsking = step{StateDisconnected, StatusNeedsAttention, "permission: Edit README.md", ""}
)

// setStep commits a stopped thread as reading s.
func (e *env) setStep(id string, s step) {
	e.t.Helper()
	if _, ok := e.m.update(id, false, func(rec *record) {
		rec.s.State, rec.s.Status, rec.s.StatusReason, rec.s.PendingRequestID = s.st, s.status, s.reason, s.req
	}); !ok {
		e.t.Fatalf("no thread %s", id)
	}
}

// Edge-triggered: each condition fires on a transition into it, not while it holds.
func TestSubscriptionTransitions(t *testing.T) {
	tests := []struct {
		name  string
		cond  Condition
		start step
		steps []step
		want  int // fires
	}{
		{"settled: each finished turn", CondSettled, busy, []step{finished, atPrompt, busy, finished, offIdle}, 2},
		{"settled: a prompt counts", CondSettled, busy, []step{askBash, busy, finished}, 2},
		{"idle: not a prompt", CondIdle, busy, []step{askBash, busy, finished, atPrompt}, 1},
		{"attention: prompts and finished turns", CondAttention, busy, []step{askBash, busy, finished, atPrompt, busy}, 2},
		{"error: a crash", CondError, busy, []step{finished, busy, crashed}, 1},
		{"disconnected", CondDisconnected, atPrompt, []step{busy, finished, offIdle, busy, offIdle}, 2},
		// Each new pending request wakes a settled or attention subscriber, though the
		// thread never leaves needs attention (wake-detail.md); nothing else that keeps
		// the condition does.
		{"settled: a permission chain", CondSettled, busy, []step{askEdit, askBash, finished}, 2},
		{"attention: a permission chain", CondAttention, busy, []step{askEdit, askBash, askWhich, busy}, 3},
		{"settled: the same reason, another request", CondSettled, busy, []step{askEdit1, askEdit1, askEdit2, finished}, 2},
		{"settled: finished, then finished", CondSettled, busy, []step{finished, finished, budget, atPrompt}, 1},
		{"settled: a turn ends after a prompt", CondSettled, busy, []step{askEdit, finished}, 1},
		{"settled: a prompt right after a turn", CondSettled, busy, []step{finished, askEdit}, 2},
		{"settled: the process ends at a prompt", CondSettled, busy, []step{askEdit1, offAsking}, 1},
		{"idle: not a permission chain", CondIdle, busy, []step{askEdit, askBash, finished}, 1},
		{"error: not a prompt", CondError, busy, []step{askEdit, askBash}, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			for _, repeat := range []bool{true, false} {
				e := newEnv(t)
				parent, child := e.stopped("parent"), e.stopped("child")
				e.setStep(child.ID, tt.start)
				res, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetThreadID: child.ID, Condition: tt.cond, Repeat: repeat})
				if err != nil || res.Fired {
					t.Fatalf("Subscribe = %+v, %v", res, err)
				}
				for _, s := range tt.steps {
					e.setStep(child.ID, s)
				}
				want := tt.want
				if !repeat {
					want = min(want, 1)
				}
				got, kept := e.subscription(res.Subscription.ID)
				switch {
				case repeat && (!kept || got.FiredCount != want):
					t.Errorf("repeat: fired %d (kept %v), want %d", got.FiredCount, kept, want)
				case !repeat && kept == (want == 1):
					t.Errorf("once: kept = %v after %d fires", kept, want)
				}
				e.waitItems(parent.ID, "the wakes", func(items []Item) bool { return len(wakes(items)) == want })
			}
		})
	}
}

func TestSubscribeFiresAtOnce(t *testing.T) {
	e := newEnv(t)
	parent, child := e.stopped("parent"), e.stopped("child")
	e.setThread(child.ID, StateConnected, StatusNeedsAttention, "finished")
	if _, err := e.m.Report(e.ctx(), child.ID, Report{Status: ReportDone, Summary: "all good"}); err != nil {
		t.Fatal(err)
	}

	// One-shot: fired and not kept.
	res, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetThreadID: child.ID, Condition: CondIdle})
	if err != nil || !res.Fired || res.Subscription.FiredCount != 1 || res.Subscription.LastFiredAt.IsZero() {
		t.Fatalf("Subscribe = %+v, %v", res, err)
	}
	if _, kept := e.subscription(res.Subscription.ID); kept {
		t.Errorf("a one-shot that fired at once was kept")
	}
	items := e.waitItems(parent.ID, "the wake", func(items []Item) bool { return len(wakes(items)) == 1 })
	w := wakes(items)[0]
	wantTitle := `Thread "child" (` + child.ID + `) needs attention: finished. Report: done — all good.`
	if w.WakeTitle != wantTitle || w.Text != "[code-foundry wake] "+wantTitle+"\n```json\n"+w.WakeJSON+"\n```" ||
		!strings.Contains(w.WakeJSON, `"subscription_id": "`+res.Subscription.ID+`"`) {
		t.Errorf("wake = %+v", w)
	}
	// The stopped subscriber started with it, and answered.
	e.waitFor(parent.ID, "the subscriber's turn", func(s Thread) bool { return s.Status == StatusNeedsAttention && s.StatusReason == "finished" })

	// Repeat: fired and kept, armed (no second fire while it holds).
	res, err = e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetThreadID: child.ID, Repeat: true})
	if err != nil || !res.Fired {
		t.Fatalf("Subscribe repeat = %+v, %v", res, err)
	}
	e.setThread(child.ID, StateConnected, StatusIdle, "at prompt")
	if got, kept := e.subscription(res.Subscription.ID); !kept || got.FiredCount != 1 || got.TargetName != "child" ||
		got.TargetStatus != "idle (at prompt)" || got.SubscriberName != "parent" {
		t.Errorf("listed = %+v (kept %v)", got, kept)
	}
	// The same subscription again: returned, nothing fires; repeat is updated.
	again, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetThreadID: child.ID, Condition: CondSettled})
	if err != nil || !again.Existed || again.Fired || again.Subscription.ID != res.Subscription.ID || again.Subscription.Repeat {
		t.Errorf("again = %+v, %v", again, err)
	}
	e.waitItems(parent.ID, "the repeat's wake", func(items []Item) bool { return len(wakes(items)) == 2 })
	// The item keeps its origin across a restart.
	e.restart()
	if w := wakes(e.items(parent.ID).Items); len(w) != 2 || w[0].WakeTitle != wantTitle || w[0].WakeJSON == "" {
		t.Errorf("wakes after restart: %+v", w)
	}
}

func TestSubscribeRefuses(t *testing.T) {
	e := newEnv(t)
	a, b := e.stopped("a"), e.stopped("b")
	archived := e.stopped("archived")
	if _, err := e.m.Archive(e.ctx(), archived.ID, true); err != nil {
		t.Fatal(err)
	}
	e.setThread(b.ID, StateDisconnected, StatusBusy, "working") // not settled: the subscription is kept
	if _, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: a.ID, TargetThreadID: b.ID}); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name string
		o    SubscribeOptions
		want error
	}{
		{"itself", SubscribeOptions{SubscriberID: a.ID, TargetThreadID: a.ID}, ErrFailedPrecondition},
		{"a direct cycle", SubscribeOptions{SubscriberID: b.ID, TargetThreadID: a.ID, Condition: CondIdle}, ErrFailedPrecondition},
		{"an archived subscriber", SubscribeOptions{SubscriberID: archived.ID, TargetThreadID: a.ID}, ErrFailedPrecondition},
		{"an archived target", SubscribeOptions{SubscriberID: a.ID, TargetThreadID: archived.ID}, ErrFailedPrecondition},
		{"an unknown subscriber", SubscribeOptions{SubscriberID: "s-nope", TargetThreadID: a.ID}, ErrNotFound},
		{"an unknown target", SubscribeOptions{SubscriberID: a.ID, TargetThreadID: "s-nope"}, ErrNotFound},
		{"no subscriber", SubscribeOptions{TargetThreadID: a.ID}, ErrInvalidArgument},
		{"two targets", SubscribeOptions{SubscriberID: a.ID, TargetThreadID: b.ID, TargetRunID: "r-1"}, ErrInvalidArgument},
		{"a run without the action store", SubscribeOptions{SubscriberID: a.ID, TargetRunID: "r-1"}, ErrFailedPrecondition},
	}
	for _, tt := range tests {
		if _, err := e.m.Subscribe(e.ctx(), tt.o); !errors.Is(err, tt.want) {
			t.Errorf("%s: Subscribe = %v, want %v", tt.name, err, tt.want)
		} else if tt.name == "a direct cycle" && !strings.Contains(err.Error(), "loop") {
			t.Errorf("cycle message = %q", err)
		}
	}
	if subs, _ := e.m.Subscriptions(e.ctx(), ""); len(subs) != 1 {
		t.Errorf("subscriptions = %+v", subs)
	}
	if _, err := e.m.Subscriptions(e.ctx(), "s-nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("Subscriptions(unknown) = %v", err)
	}
}

func TestUnsubscribe(t *testing.T) {
	e := newEnv(t)
	a, b, c := e.stopped("a"), e.stopped("b"), e.stopped("c")
	for _, setup := range []SubscribeOptions{
		{SubscriberID: a.ID, TargetThreadID: b.ID},
		{SubscriberID: a.ID, TargetThreadID: b.ID, Condition: CondError},
		{SubscriberID: a.ID, TargetThreadID: c.ID},
	} {
		e.setThread(setup.TargetThreadID, StateDisconnected, StatusBusy, "working")
		if _, err := e.m.Subscribe(e.ctx(), setup); err != nil {
			t.Fatal(err)
		}
	}
	gone, err := e.m.Unsubscribe(e.ctx(), UnsubscribeOptions{SubscriberID: a.ID, TargetThreadID: b.ID})
	if err != nil || len(gone) != 2 {
		t.Fatalf("Unsubscribe by target = %+v, %v", gone, err)
	}
	if _, err := e.m.Unsubscribe(e.ctx(), UnsubscribeOptions{SubscriberID: a.ID, TargetThreadID: b.ID}); !errors.Is(err, ErrNotFound) {
		t.Errorf("again = %v", err)
	}
	if _, err := e.m.Unsubscribe(e.ctx(), UnsubscribeOptions{SubscriberID: a.ID}); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("no target = %v", err)
	}
	subs, _ := e.m.Subscriptions(e.ctx(), a.ID)
	if len(subs) != 1 {
		t.Fatalf("left = %+v", subs)
	}
	if _, err := e.m.Unsubscribe(e.ctx(), UnsubscribeOptions{ID: subs[0].ID}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.m.Unsubscribe(e.ctx(), UnsubscribeOptions{ID: subs[0].ID}); !errors.Is(err, ErrNotFound) {
		t.Errorf("by id again = %v", err)
	}
	e.restart()
	if subs, _ := e.m.Subscriptions(e.ctx(), ""); len(subs) != 0 {
		t.Errorf("after restart = %+v", subs)
	}
}

func TestSubscriptionsCleanup(t *testing.T) {
	tests := []struct {
		name string
		// act archives or removes one of the threads.
		act func(e *env, sub, target, other Thread)
	}{
		{"subscriber archived", func(e *env, sub, _, _ Thread) {
			if _, err := e.m.Archive(e.ctx(), sub.ID, true); err != nil {
				e.t.Fatal(err)
			}
		}},
		{"target archived", func(e *env, _, target, _ Thread) {
			if _, err := e.m.Archive(e.ctx(), target.ID, true); err != nil {
				e.t.Fatal(err)
			}
		}},
		{"subscriber removed", func(e *env, sub, _, _ Thread) {
			if err := e.m.Remove(e.ctx(), sub.ID); err != nil {
				e.t.Fatal(err)
			}
		}},
		{"target removed", func(e *env, _, target, _ Thread) {
			if err := e.m.Remove(e.ctx(), target.ID); err != nil {
				e.t.Fatal(err)
			}
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newEnv(t)
			sub, target, other := e.stopped("subscriber"), e.stopped("target"), e.stopped("other")
			for _, s := range []Thread{target, other} {
				e.setThread(s.ID, StateDisconnected, StatusBusy, "working") // not settled; archivable
			}
			for _, o := range []SubscribeOptions{
				{SubscriberID: sub.ID, TargetThreadID: target.ID, Repeat: true},
				{SubscriberID: other.ID, TargetThreadID: sub.ID, Condition: CondAttention},
				{SubscriberID: target.ID, TargetThreadID: other.ID}, // untouched by the subscriber's fate
			} {
				if _, err := e.m.Subscribe(e.ctx(), o); err != nil {
					t.Fatal(err)
				}
			}
			tt.act(e, sub, target, other)
			subs, _ := e.m.Subscriptions(e.ctx(), "")
			for _, s := range subs {
				if strings.HasPrefix(tt.name, "subscriber") && (s.SubscriberID == sub.ID || s.TargetID == sub.ID) {
					t.Errorf("kept %+v", s)
				}
				if strings.HasPrefix(tt.name, "target") && (s.SubscriberID == target.ID || s.TargetID == target.ID) {
					t.Errorf("kept %+v", s)
				}
			}
			if want := 1; strings.HasPrefix(tt.name, "subscriber") && len(subs) != want {
				t.Errorf("left %d, want %d: %+v", len(subs), want, subs)
			}
			e.restart()
			after, _ := e.m.Subscriptions(e.ctx(), "")
			if len(after) != len(subs) {
				t.Errorf("after restart %d, want %d", len(after), len(subs))
			}
		})
	}
}

// Rehydrated subscriptions are armed with the targets as loaded: nothing fires at
// startup, the next transition does. Run subscriptions are dropped.
func TestSubscriptionsRehydrate(t *testing.T) {
	runs := &fakeRuns{runs: map[string]ActionRun{"r-1": {ID: "r-1", ActionName: "Test"}}}
	e := newEnv(t, runs.opts)
	parent, child := e.stopped("parent"), e.stopped("child")
	e.setThread(child.ID, StateConnected, StatusBusy, "working")
	rep, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetThreadID: child.ID, Repeat: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetRunID: "r-1"}); err != nil {
		t.Fatal(err)
	}
	e.setThread(child.ID, StateConnected, StatusNeedsAttention, "finished")
	e.waitItems(parent.ID, "the first wake", func(items []Item) bool { return len(wakes(items)) == 1 })

	e.restart(runs.opts)
	subs, _ := e.m.Subscriptions(e.ctx(), "")
	if len(subs) != 1 || subs[0].ID != rep.Subscription.ID || subs[0].FiredCount != 1 || subs[0].LastFiredAt.IsZero() || !subs[0].Repeat {
		t.Fatalf("after restart = %+v", subs)
	}
	time.Sleep(50 * time.Millisecond)
	if n := len(wakes(e.items(parent.ID).Items)); n != 1 {
		t.Errorf("wakes after restart = %d, want 1 (nothing fires at startup)", n)
	}
	e.setThread(child.ID, StateConnected, StatusBusy, "working")
	e.setThread(child.ID, StateConnected, StatusNeedsAttention, "finished")
	e.waitItems(parent.ID, "a wake after the restart", func(items []Item) bool { return len(wakes(items)) == 2 })
}

// fakeRuns stands in for the action store (Options.ActionRun).
type fakeRuns struct {
	mu   sync.Mutex
	runs map[string]ActionRun
}

func (f *fakeRuns) opts(o *Options) {
	o.ActionRun = func(_ context.Context, id string) (ActionRun, bool) {
		f.mu.Lock()
		defer f.mu.Unlock()
		r, ok := f.runs[id]
		return r, ok
	}
}

func (f *fakeRuns) finish(id string, code int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	r := f.runs[id]
	r.Finished, r.ExitCode, r.Output = true, code, "ok\n"
	f.runs[id] = r
}

func TestRunSubscriptions(t *testing.T) {
	runs := &fakeRuns{runs: map[string]ActionRun{
		"r-run":  {ID: "r-run", ActionID: "a-1", ActionName: "Test"},
		"r-done": {ID: "r-done", ActionID: "a-1", ActionName: "Test", Finished: true, ExitCode: 0},
	}}
	e := newEnv(t, runs.opts)
	parent := e.stopped("parent")

	res, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetRunID: "r-run", Repeat: true})
	if err != nil || res.Fired || res.Subscription.Repeat || res.Subscription.Condition != CondFinished {
		t.Fatalf("Subscribe = %+v, %v", res, err)
	}
	if got, _ := e.subscription(res.Subscription.ID); got.TargetName != "Test" || got.TargetStatus != "running" {
		t.Errorf("listed = %+v", got)
	}
	runs.finish("r-run", 3)
	e.m.ActionRunFinished(e.ctx(), "r-run")
	e.m.ActionRunFinished(e.ctx(), "r-run") // once
	items := e.waitItems(parent.ID, "the run's wake", func(items []Item) bool { return len(wakes(items)) == 1 })
	if w := wakes(items)[0]; w.WakeTitle != `Action "Test" run r-run finished with exit 3.` || !strings.Contains(w.WakeJSON, `"output_tail": "ok\n"`) {
		t.Errorf("wake = %q\n%s", w.WakeTitle, w.WakeJSON)
	}
	if _, kept := e.subscription(res.Subscription.ID); kept {
		t.Errorf("a run subscription stayed after its run finished")
	}

	done, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetRunID: "r-done"})
	if err != nil || !done.Fired {
		t.Fatalf("Subscribe to a finished run = %+v, %v", done, err)
	}
	e.waitItems(parent.ID, "the finished run's wake", func(items []Item) bool { return len(wakes(items)) == 2 })
	if _, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetRunID: "r-nope"}); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown run = %v", err)
	}
	if subs, _ := e.m.Subscriptions(e.ctx(), ""); len(subs) != 0 {
		t.Errorf("left = %+v", subs)
	}
}

func TestCreateNotify(t *testing.T) {
	e := newEnv(t)
	parent := e.stopped("parent")
	child := e.create(CreateOptions{CreatedBy: parent.ID, Notify: true, InitialPrompt: "hello there"})
	subs, err := e.m.Subscriptions(e.ctx(), parent.ID)
	if err != nil || len(subs) != 1 || subs[0].TargetID != child.ID || subs[0].Condition != CondSettled || !subs[0].Repeat {
		t.Fatalf("subscriptions = %+v, %v", subs, err)
	}
	// The child's first turn ends: the parent is woken.
	items := e.waitItems(parent.ID, "the child's wake", func(items []Item) bool { return len(wakes(items)) == 1 })
	if w := wakes(items)[0]; !strings.Contains(w.WakeTitle, child.ID) {
		t.Errorf("wake = %q", w.WakeTitle)
	}
	n := len(e.m.Snapshot().Threads)
	if _, err := e.m.Create(e.ctx(), CreateOptions{WorktreePath: e.wt, Notify: true}); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("notify without a creator = %v", err)
	}
	if got := len(e.m.Snapshot().Threads); got != n {
		t.Errorf("a refused create left a thread")
	}
}

// The wake limit: past it wakes are dropped, the subscriber needs attention once per
// window with a note, the subscription stays, and the window rolls.
func TestWakeLimit(t *testing.T) {
	clk := newTestClock()
	e := newEnv(t, clk.opts(), func(o *Options) { o.WakeLimit = 2 })
	parent, child := e.stopped("parent"), e.stopped("child")
	e.setThread(child.ID, StateConnected, StatusBusy, "working")
	res, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetThreadID: child.ID, Repeat: true})
	if err != nil {
		t.Fatal(err)
	}
	turn := func() {
		e.setThread(child.ID, StateConnected, StatusBusy, "working")
		e.setThread(child.ID, StateConnected, StatusNeedsAttention, "finished")
	}
	notes := func(items []Item) int {
		n := 0
		for _, it := range items {
			if it.Kind == KindNote && it.Text == "Wake limit reached (2/hour); wakes are being dropped." {
				n++
			}
		}
		return n
	}
	e.setThread(child.ID, StateConnected, StatusNeedsAttention, "finished")
	turn()
	e.waitItems(parent.ID, "two wakes", func(items []Item) bool { return len(wakes(items)) == 2 })
	turn() // dropped: note
	turn() // dropped: no second note
	e.waitItems(parent.ID, "the note", func(items []Item) bool { return notes(items) == 1 })
	e.waitFor(parent.ID, "wake limit", func(s Thread) bool { return s.StatusReason == ReasonWakeLimit && s.Status == StatusNeedsAttention })
	time.Sleep(50 * time.Millisecond)
	items := e.items(parent.ID).Items
	if len(wakes(items)) != 2 || notes(items) != 1 {
		t.Errorf("wakes %d, notes %d:\n%s", len(wakes(items)), notes(items), describeItems(items))
	}
	if got, kept := e.subscription(res.Subscription.ID); !kept || got.FiredCount != 2 {
		t.Errorf("subscription = %+v (kept %v)", got, kept)
	}
	// An hour on, wakes go through again.
	clk.advance(WakeWindow + time.Second)
	turn()
	e.waitItems(parent.ID, "a wake in the next window", func(items []Item) bool { return len(wakes(items)) == 3 })
}

func TestWakeLimitStatus(t *testing.T) {
	var d streamStatus
	d.initialized()
	d.wakeLimit = true
	if st, r := d.Status(); st != StatusNeedsAttention || r != ReasonWakeLimit {
		t.Fatalf("idle: %s %q", st, r)
	}
	d.busy = true // a turn runs: it says so
	if st, _ := d.Status(); st != StatusBusy {
		t.Errorf("busy: %s", st)
	}
	d.busy = false
	d.Acknowledge()
	if st, r := d.Status(); st != StatusIdle || r != "at prompt" {
		t.Errorf("seen: %s %q", st, r)
	}
	d.wakeLimit = true
	d.sent(false)
	if !d.wakeLimit {
		t.Errorf("a wake going out keeps it")
	}
	d.sent(true)
	if d.wakeLimit {
		t.Errorf("the user's message clears it")
	}
}
