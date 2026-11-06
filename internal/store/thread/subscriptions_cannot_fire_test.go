package thread

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestPRCannotFire(t *testing.T) {
	// The conditions that can still fire, by state.
	can := map[string][]Condition{
		"open":   PullRequestConditions,
		"":       PullRequestConditions, // a placeholder without a state says nothing
		"closed": {CondClosed, CondChanged},
		"merged": {CondMerged},
	}
	for state, want := range can {
		for _, c := range PullRequestConditions {
			if got := prCannotFire(c, PullRequestInfo{State: state}); got == slices.Contains(want, c) {
				t.Errorf("%q %s: cannot fire = %v", state, c, got)
			}
		}
	}
}

// Every pull request state and condition, on GitHub's answer at subscribe time.
func TestSubscribeAsksGitHub(t *testing.T) {
	const target = "acme/web#7"
	info := func(state string, c PRChecks) PullRequestInfo {
		return PullRequestInfo{Slug: "acme/web", Number: 7, State: state, Checks: c}
	}
	const (
		kept  = "kept"
		fires = "fires"
		warns = "warns"
	)
	reopen := []string{"reopen it and subscribe again", "--until changed"}
	onMerge := []string{"act on the merge now"}
	tests := []struct {
		name string
		pr   PullRequestInfo
		// want is by condition: kept, fires, warns, or else refused with refused in it.
		want    map[Condition]string
		refused []string
	}{
		{name: "open, checks pending", pr: info("open", pending4)},
		{name: "open, checks passed", pr: info("open", passed4),
			want: map[Condition]string{CondChecksDone: fires, CondChecksPassed: fires}},
		{name: "open, checks failed", pr: info("open", failed4),
			want: map[Condition]string{CondChecksDone: fires, CondChecksFailed: fires}},
		{name: "closed", pr: info("closed", passed4), refused: reopen,
			want: map[Condition]string{CondClosed: fires, CondChanged: warns}},
		{name: "merged", pr: info("merged", passed4), refused: onMerge,
			want: map[Condition]string{CondMerged: fires}},
	}
	for _, tt := range tests {
		for _, c := range PullRequestConditions {
			t.Run(tt.name+"/"+string(c), func(t *testing.T) {
				prs := newFakePRs(tt.pr)
				e := newEnv(t, prs.opts)
				parent := e.stopped("parent")
				res, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetPullRequest: target, Condition: c})
				want := tt.want[c]
				if want == "" && tt.refused == nil {
					want = kept
				}
				if want == "" {
					if !errors.Is(err, ErrFailedPrecondition) {
						t.Fatalf("err = %v, want a refusal", err)
					}
					for _, s := range tt.refused {
						if !strings.Contains(err.Error(), s) {
							t.Errorf("refusal %q does not say %q", err, s)
						}
					}
					if subs, _ := e.m.Subscriptions(e.ctx(), parent.ID); len(subs) != 0 {
						t.Errorf("a refusal kept %+v", subs)
					}
					return
				}
				if err != nil {
					t.Fatal(err)
				}
				if res.Fired != (want == fires) {
					t.Errorf("fired = %v, want %s", res.Fired, want)
				}
				if warned := len(res.Warnings) > 0; warned != (want == warns) {
					t.Errorf("warnings = %q, want %s", res.Warnings, want)
				}
				if _, stays := e.subscription(res.Subscription.ID); stays != (want != fires) {
					t.Errorf("stays = %v, want %s", stays, want)
				}
			})
		}
	}
}

func TestSubscribeGitHubDidNotFind(t *testing.T) {
	prs := newFakePRs()
	prs.lookup = func(context.Context, string) (PullRequestInfo, error) { return PullRequestInfo{}, ErrNotFound }
	e := newEnv(t, prs.opts)
	parent := e.stopped("parent")
	for _, c := range PullRequestConditions {
		_, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetPullRequest: "acme/web#7", Condition: c})
		if !errors.Is(err, ErrFailedPrecondition) || !strings.Contains(err.Error(), "does not exist") {
			t.Errorf("%s: %v", c, err)
		}
	}
	if subs, _ := e.m.Subscriptions(e.ctx(), parent.ID); len(subs) != 0 {
		t.Errorf("kept %+v", subs)
	}
}

// A question that failed refuses nothing and fires nothing, whatever the cache holds.
func TestSubscribeLookupFails(t *testing.T) {
	const target = "acme/web#7"
	for _, cached := range []string{"", "open", "closed", "merged"} {
		for _, c := range PullRequestConditions {
			t.Run(cached+"/"+string(c), func(t *testing.T) {
				prs := newFakePRs()
				if cached != "" {
					prs.set(PullRequestInfo{Slug: "acme/web", Number: 7, State: cached, Checks: passed4})
				}
				prs.lookup = func(context.Context, string) (PullRequestInfo, error) {
					return PullRequestInfo{}, errors.New("rate limited")
				}
				e := newEnv(t, prs.opts)
				parent := e.stopped("parent")
				res, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetPullRequest: target, Condition: c})
				if err != nil {
					t.Fatal(err)
				}
				if res.Fired || len(res.Warnings) != 1 || !strings.Contains(res.Warnings[0], "could not check") || !strings.Contains(res.Warnings[0], "rate limited") {
					t.Errorf("= %+v", res)
				}
				if _, kept := e.subscription(res.Subscription.ID); !kept {
					t.Error("the subscription went")
				}
			})
		}
	}
}

// GitHub not answering holds Subscribe a few seconds at most and no lock: the store goes
// on, and the subscription stays with a warning.
func TestSubscribeLookupTimesOut(t *testing.T) {
	prs := newFakePRs()
	asked := make(chan time.Time, 1)
	prs.lookup = func(ctx context.Context, _ string) (PullRequestInfo, error) {
		deadline, _ := ctx.Deadline()
		asked <- deadline
		<-ctx.Done()
		return PullRequestInfo{}, ctx.Err()
	}
	e := newEnv(t, prs.opts)
	parent := e.stopped("parent")
	other := e.stopped("other")
	start := time.Now()
	ctx, cancel := context.WithCancel(e.ctx()) // the question lasts until the store answered
	defer cancel()
	type result struct {
		res SubscribeResult
		err error
	}
	done := make(chan result, 1)
	go func() {
		res, err := e.m.Subscribe(ctx, SubscribeOptions{SubscriberID: parent.ID, TargetPullRequest: "acme/web#7"})
		done <- result{res, err}
	}()
	if d := <-asked; d.IsZero() || d.After(start.Add(prLookupTimeout+time.Second)) {
		t.Errorf("deadline %v after start: not bounded", d.Sub(start))
	}
	// Mid-question: a read and a subscribe that takes both locks get through.
	answered := make(chan error, 1)
	go func() {
		_, err := e.m.Subscriptions(e.ctx(), parent.ID)
		if err == nil {
			_, err = e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetThreadID: other.ID})
		}
		answered <- err
	}()
	select {
	case err := <-answered:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(prLookupTimeout / 2):
		t.Fatal("the store waits for the question: a lock is held")
	}
	cancel()
	r := <-done
	if r.err != nil || r.res.Fired || len(r.res.Warnings) != 1 {
		t.Fatalf("= %+v, %v", r.res, r.err)
	}
	if _, kept := e.subscription(r.res.Subscription.ID); !kept {
		t.Error("the subscription went")
	}
}

// A cached closed copy of a pull request GitHub says is open decides nothing: not the
// subscription, not the timers' tick, and not an event about something else.
func TestStaleCachedClosed(t *testing.T) {
	const target = "acme/web#7"
	cachedClosed := PullRequestInfo{Slug: "acme/web", Number: 7, State: "closed"}
	prs := newFakePRs(cachedClosed)
	prs.lookup = func(context.Context, string) (PullRequestInfo, error) {
		return PullRequestInfo{Slug: "acme/web", Number: 7, State: "open", Checks: pending4}, nil
	}
	e := newEnv(t, prs.opts)
	parent := e.stopped("parent")
	var ids []string
	for _, c := range []Condition{CondChecksPassed, CondComment, CondMerged, CondClosed} {
		res, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetPullRequest: target, Condition: c})
		if err != nil || res.Fired || len(res.Warnings) != 0 {
			t.Fatalf("%s: %+v, %v", c, res, err)
		}
		ids = append(ids, res.Subscription.ID)
	}
	e.m.fireTimers()
	e.m.PullRequestChanged(prEvent(pending4, PullRequestChange{Kind: PRChangeTitle, OldTitle: "a", NewTitle: "b"}))
	time.Sleep(20 * time.Millisecond)
	if n := len(wakes(e.items(parent.ID).Items)); n != 0 {
		t.Errorf("%d wakes", n)
	}
	for _, id := range ids {
		if _, kept := e.subscription(id); !kept {
			t.Errorf("%s went", id)
		}
	}
}

func stateEvent(state string, kind PRChangeKind) PullRequestEvent {
	ev := prEvent(pending4, PullRequestChange{Kind: kind, OldState: "open", NewState: state})
	ev.PullRequest.State = state
	return ev
}

// A reported close or merge: what cannot fire any more ends with one wake each, what
// fires goes with its own wake, and what can still fire stays.
func TestPullRequestEndsSubscriptions(t *testing.T) {
	const (
		target = "acme/web#7"
		closed = "closed without merging, so %s can no longer fire and the subscription ended. Subscribe again if it reopens."
		merged = "merged, so %s can no longer fire and the subscription ended."
	)
	title := func(format string, c Condition) string {
		return "Pull request acme/web#7: " + strings.Replace(format, "%s", string(c), 1)
	}
	tests := []struct {
		ev     PullRequestEvent
		format string
		fired  map[Condition]string // those that fire as themselves, with their wake
		stays  []Condition
	}{
		{ev: stateEvent("closed", PRChangeClosed), format: closed, stays: []Condition{CondChanged},
			fired: map[Condition]string{CondClosed: "Pull request acme/web#7: closed without merging.",
				CondChanged: "Pull request acme/web#7: changed (closed)."}},
		{ev: stateEvent("merged", PRChangeMerged), format: merged,
			fired: map[Condition]string{CondMerged: "Pull request acme/web#7: merged.",
				CondChanged: "Pull request acme/web#7: changed (merged)."}},
	}
	for _, tt := range tests {
		for _, c := range PullRequestConditions {
			t.Run(tt.ev.PullRequest.State+"/"+string(c), func(t *testing.T) {
				prs := newFakePRs(PullRequestInfo{Slug: "acme/web", Number: 7, State: "open", Checks: pending4})
				e := newEnv(t, prs.opts)
				parent := e.stopped("parent")
				res, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetPullRequest: target, Condition: c, Repeat: true})
				if err != nil {
					t.Fatal(err)
				}
				e.m.PullRequestChanged(tt.ev)
				items := e.waitItems(parent.ID, "the wake", func(items []Item) bool { return len(wakes(items)) >= 1 })
				want, ok := tt.fired[c]
				if !ok {
					want = title(tt.format, c)
				}
				if got := wakeTitles(items); !slices.Equal(got, []string{want}) {
					t.Errorf("wakes %q, want %q", got, want)
				}
				if _, kept := e.subscription(res.Subscription.ID); kept != slices.Contains(tt.stays, c) {
					t.Errorf("kept = %v", kept)
				}
				// Nothing fires it twice: the tick, then the same news again.
				e.m.fireTimers()
				e.m.PullRequestChanged(prEvent(pending4, PullRequestChange{Kind: PRChangeDraft}))
				time.Sleep(20 * time.Millisecond)
				if n := len(wakes(e.items(parent.ID).Items)); n != 1 && !slices.Contains(tt.stays, c) {
					t.Errorf("%d wakes", n)
				}
			})
		}
	}
}

// A subscription kept because GitHub could not be asked meets its closed pull request
// through any later change: the event's state is the poll's, so it counts.
func TestEventOnAClosedPullRequest(t *testing.T) {
	for _, tt := range []struct {
		cond  Condition
		want  string
		stays bool
	}{
		{CondChecksPassed, "Pull request acme/web#7: closed without merging, so checks_passed can no longer fire and the subscription ended. Subscribe again if it reopens.", false},
		{CondClosed, "Pull request acme/web#7: closed without merging.", false},
		{CondChanged, "Pull request acme/web#7: changed (title).", true},
	} {
		t.Run(string(tt.cond), func(t *testing.T) {
			prs := newFakePRs() // the question fails
			e := newEnv(t, prs.opts)
			parent := e.stopped("parent")
			res, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetPullRequest: "acme/web#7", Condition: tt.cond, Repeat: true})
			if err != nil {
				t.Fatal(err)
			}
			ev := prEvent(pending4, PullRequestChange{Kind: PRChangeTitle, OldTitle: "a", NewTitle: "b"})
			ev.PullRequest.State = "closed"
			e.m.PullRequestChanged(ev)
			items := e.waitItems(parent.ID, "the wake", func(items []Item) bool { return len(wakes(items)) == 1 })
			if got := wakeTitles(items)[0]; got != tt.want {
				t.Errorf("wake %q", got)
			}
			if _, kept := e.subscription(res.Subscription.ID); kept != tt.stays {
				t.Errorf("kept = %v", kept)
			}
		})
	}
}

func TestPREndedWakePayload(t *testing.T) {
	sub := Subscription{ID: "sub-1", Condition: CondComment, Note: "ship it"}
	p := PullRequestInfo{Slug: "acme/web", Number: 7, Title: "Fix login", State: "closed"}
	changes := []PullRequestChange{{Kind: PRChangeClosed, OldState: "open", NewState: "closed"}}
	msg := prEndedWake(sub, p, changes, time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC))
	if want := `Pull request acme/web#7 "Fix login": closed without merging, so comment can no longer fire and the subscription ended. Subscribe again if it reopens.`; msg.WakeTitle != want {
		t.Errorf("title %q", msg.WakeTitle)
	}
	var got wakePRPayload
	if err := json.Unmarshal([]byte(msg.WakeJSON), &got); err != nil {
		t.Fatal(err)
	}
	if !got.Ended || got.Condition != CondComment || got.Note != "ship it" || got.PullRequest.State != "closed" || len(got.Changes) != 1 {
		t.Errorf("payload %+v", got)
	}
}

// A closed pull request that reopens can be subscribed to again, and its next close is
// told once more.
func TestReopenedSubscribesAgain(t *testing.T) {
	const target = "acme/web#7"
	prs := newFakePRs(PullRequestInfo{Slug: "acme/web", Number: 7, State: "open", Checks: pending4})
	e := newEnv(t, prs.opts)
	parent := e.stopped("parent")
	sub := func() error {
		_, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetPullRequest: target, Condition: CondChecksPassed})
		return err
	}
	if err := sub(); err != nil {
		t.Fatal(err)
	}
	e.m.PullRequestChanged(stateEvent("closed", PRChangeClosed))
	e.waitItems(parent.ID, "the last wake", func(items []Item) bool { return len(wakes(items)) == 1 })
	prs.set(PullRequestInfo{Slug: "acme/web", Number: 7, State: "closed"})
	if err := sub(); !errors.Is(err, ErrFailedPrecondition) {
		t.Fatalf("on the closed pull request: %v", err)
	}
	prs.set(PullRequestInfo{Slug: "acme/web", Number: 7, State: "open", Checks: pending4})
	if err := sub(); err != nil {
		t.Fatalf("after it reopened: %v", err)
	}
	e.m.PullRequestChanged(stateEvent("closed", PRChangeClosed))
	e.waitItems(parent.ID, "the second last wake", func(items []Item) bool { return len(wakes(items)) == 2 })
}

// limited is a subscriber whose one wake per window is spent, with a subscription to
// another pull request to spend it.
func limited(t *testing.T, prs *fakePRs, clk *testClock) (*env, Thread) {
	t.Helper()
	e := newEnv(t, clk.opts(), prs.opts, func(o *Options) { o.WakeLimit = 1 })
	parent := e.stopped("parent")
	prs.set(PullRequestInfo{Slug: "acme/web", Number: 8, State: "open", Checks: pending4})
	if _, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetPullRequest: "acme/web#8", Condition: CondChanged, Repeat: true}); err != nil {
		t.Fatal(err)
	}
	return e, parent
}

func spend(e *env, parent Thread) {
	other := prEvent(pending4, PullRequestChange{Kind: PRChangeTitle, OldTitle: "a", NewTitle: "b"})
	other.PullRequest.Number = 8
	e.m.PullRequestChanged(other)
	e.waitItems(parent.ID, "the wake that spends the limit", func(items []Item) bool { return len(wakes(items)) == 1 })
}

// Over the wake limit a last wake waits: the subscription stays until one gets through,
// and that is the only one.
func TestFinalWakeAtTheLimit(t *testing.T) {
	const target = "acme/web#7"
	tests := []struct {
		name string
		cond Condition
		ev   PullRequestEvent
		want string
	}{
		{"ended on a close", CondChecksPassed, stateEvent("closed", PRChangeClosed),
			"Pull request acme/web#7: closed without merging, so checks_passed can no longer fire and the subscription ended. Subscribe again if it reopens."},
		{"ended on a merge", CondComment, stateEvent("merged", PRChangeMerged),
			"Pull request acme/web#7: merged, so comment can no longer fire and the subscription ended."},
		{"closed itself", CondClosed, stateEvent("closed", PRChangeClosed), "Pull request acme/web#7: closed without merging."},
		{"merged itself", CondMerged, stateEvent("merged", PRChangeMerged), "Pull request acme/web#7: merged."},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			clk := newTestClock()
			prs := newFakePRs(PullRequestInfo{Slug: "acme/web", Number: 7, State: "open", Checks: pending4})
			e, parent := limited(t, prs, clk)
			res, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetPullRequest: target, Condition: tt.cond})
			if err != nil {
				t.Fatal(err)
			}
			spend(e, parent)
			e.m.PullRequestChanged(tt.ev)
			clk.advance(2 * timerRetry)
			e.m.fireTimers() // still inside the window
			if _, kept := e.subscription(res.Subscription.ID); !kept {
				t.Fatal("it went with its wake dropped")
			}

			clk.advance(WakeWindow)
			for range 3 { // past the retry each time: once sent, nothing is left to send
				e.m.fireTimers()
				clk.advance(2 * timerRetry)
			}
			items := e.waitItems(parent.ID, "the last wake", func(items []Item) bool { return len(wakes(items)) >= 2 })
			time.Sleep(20 * time.Millisecond)
			if got := wakeTitles(e.items(parent.ID).Items)[1:]; !slices.Equal(got, []string{tt.want}) {
				t.Errorf("after the window: %q, want %q (%d items)", got, tt.want, len(items))
			}
			if _, kept := e.subscription(res.Subscription.ID); kept {
				t.Error("it stayed after its wake")
			}
		})
	}
}

// The pull request reopens while its last wake waits: the wake is off, the subscription
// is live again.
func TestReopeningCallsOffAFinalWake(t *testing.T) {
	const target = "acme/web#7"
	clk := newTestClock()
	prs := newFakePRs(PullRequestInfo{Slug: "acme/web", Number: 7, State: "open", Checks: pending4})
	e, parent := limited(t, prs, clk)
	res, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetPullRequest: target, Condition: CondComment})
	if err != nil {
		t.Fatal(err)
	}
	spend(e, parent)
	e.m.PullRequestChanged(stateEvent("closed", PRChangeClosed))
	reopened := prEvent(pending4, PullRequestChange{Kind: PRChangeReopened, OldState: "closed", NewState: "open"})
	e.m.PullRequestChanged(reopened)
	clk.advance(WakeWindow + timerRetry)
	e.m.fireTimers()
	time.Sleep(20 * time.Millisecond)
	if n := len(wakes(e.items(parent.ID).Items)); n != 1 {
		t.Errorf("%d wakes, want the one that spent the limit", n)
	}
	if _, kept := e.subscription(res.Subscription.ID); !kept {
		t.Error("it went")
	}
}

// merged or closed already true at subscribe time, the wake dropped: it is tried again
// like any last wake, as nothing else would ever fire it.
func TestAtOnceWakeAtTheLimit(t *testing.T) {
	clk := newTestClock()
	prs := newFakePRs(PullRequestInfo{Slug: "acme/web", Number: 7, State: "closed"})
	e, parent := limited(t, prs, clk)
	spend(e, parent)
	res, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetPullRequest: "acme/web#7", Condition: CondClosed})
	if err != nil || res.Fired {
		t.Fatalf("= %+v, %v", res, err)
	}
	clk.advance(WakeWindow + timerRetry)
	e.m.fireTimers()
	e.waitItems(parent.ID, "the wake", func(items []Item) bool { return len(wakes(items)) == 2 })
	if _, kept := e.subscription(res.Subscription.ID); kept {
		t.Error("it stayed after its wake")
	}
}

// Every source at subscribe time but pull requests (TestSubscribeAsksGitHub): refused,
// fired at once as before, or kept with a warning.
func TestSubscribeCannotFire(t *testing.T) {
	tests := []struct {
		name   string
		runs   map[string]ActionRun
		status string // the plugin's; "" for running
		o      func(e *env, target Thread) SubscribeOptions

		wantErr  error
		wantHas  string // in the refusal or the warning
		wantWarn bool
		wantFire bool
	}{
		{name: "thread that never existed", wantErr: ErrNotFound,
			o: func(*env, Thread) SubscribeOptions { return SubscribeOptions{TargetThreadID: "s-nope"} }},
		{name: "archived thread", wantErr: ErrFailedPrecondition, wantHas: "unarchive it first",
			o: func(e *env, t Thread) SubscribeOptions {
				if _, err := e.m.Archive(e.ctx(), t.ID, true); err != nil {
					e.t.Fatal(err)
				}
				return SubscribeOptions{TargetThreadID: t.ID}
			}},
		{name: "stopped thread, already settled: fires", wantFire: true,
			o: func(_ *env, t Thread) SubscribeOptions { return SubscribeOptions{TargetThreadID: t.ID} }},
		{name: "stopped thread, error: warned", wantWarn: true, wantHas: "after someone sends it a message",
			o: func(_ *env, t Thread) SubscribeOptions {
				return SubscribeOptions{TargetThreadID: t.ID, Condition: CondError}
			}},
		{name: "run nobody knows", wantErr: ErrNotFound, runs: map[string]ActionRun{},
			o: func(*env, Thread) SubscribeOptions { return SubscribeOptions{TargetRunID: "r-1"} }},
		{name: "run already finished: fires", wantFire: true, runs: map[string]ActionRun{"r-1": {ID: "r-1", Finished: true}},
			o: func(*env, Thread) SubscribeOptions { return SubscribeOptions{TargetRunID: "r-1"} }},
		{name: "run still going", runs: map[string]ActionRun{"r-1": {ID: "r-1"}},
			o: func(*env, Thread) SubscribeOptions { return SubscribeOptions{TargetRunID: "r-1"} }},
		{name: "plugin running",
			o: func(*env, Thread) SubscribeOptions { return SubscribeOptions{TargetPlugin: "hello/tick"} }},
		{name: "plugin starting", status: "starting",
			o: func(*env, Thread) SubscribeOptions { return SubscribeOptions{TargetPlugin: "hello/tick"} }},
		{name: "plugin crashed: warned", status: "crashed", wantWarn: true, wantHas: "is crashed",
			o: func(*env, Thread) SubscribeOptions { return SubscribeOptions{TargetPlugin: "hello/tick"} }},
		{name: "plugin source unknown", wantErr: ErrNotFound,
			o: func(*env, Thread) SubscribeOptions { return SubscribeOptions{TargetPlugin: "hello/nope"} }},
		{name: "timer in the past", wantErr: ErrInvalidArgument,
			o: func(e *env, _ Thread) SubscribeOptions {
				return SubscribeOptions{TargetAt: e.m.opts.Now().Add(-time.Second)}
			}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			runs := &fakeRuns{runs: tt.runs}
			e := newEnv(t, runs.opts)
			pw := &statusPluginWakes{status: tt.status}
			e.m.SetPluginWakes(pw)
			parent, target := e.stopped("parent"), e.stopped("target")
			o := tt.o(e, target)
			o.SubscriberID = parent.ID
			res, err := e.m.Subscribe(e.ctx(), o)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("err = %v, want %v", err, tt.wantErr)
			}
			if tt.wantErr != nil {
				if !strings.Contains(err.Error(), tt.wantHas) {
					t.Errorf("err = %q, want %q in it", err, tt.wantHas)
				}
				if subs, _ := e.m.Subscriptions(e.ctx(), parent.ID); len(subs) != 0 {
					t.Errorf("a refusal kept %+v", subs)
				}
				return
			}
			if res.Fired != tt.wantFire {
				t.Errorf("fired = %v", res.Fired)
			}
			if got := len(res.Warnings) > 0; got != tt.wantWarn {
				t.Errorf("warnings = %q", res.Warnings)
			}
			if tt.wantWarn && !strings.Contains(strings.Join(res.Warnings, "\n"), tt.wantHas) {
				t.Errorf("warnings = %q, want %q in them", res.Warnings, tt.wantHas)
			}
		})
	}
}

// statusPluginWakes is fakePluginWakes with the plugin in state status ("" running).
type statusPluginWakes struct {
	fakePluginWakes
	status string
}

func (f *statusPluginWakes) Describe(target string) (string, string) {
	name, status := f.fakePluginWakes.Describe(target)
	if f.status != "" {
		status = f.status
	}
	return name, status
}
