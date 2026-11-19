package thread

import (
	"context"
	"errors"
	"maps"
	"slices"
	"strings"
	"testing"
	"time"
)

// The thread store's side of a snooze until an event (snooze_event.go).

const snoozePR = "acme/web#7"

// eventSnoozed is a stopped thread snoozed until ev.
func (e *env) eventSnoozed(ev EventSnooze) Thread {
	e.t.Helper()
	s := e.stopped("waiting")
	got, err := e.m.SnoozeUntilEvent(e.ctx(), s.ID, ev)
	if err != nil {
		e.t.Fatalf("SnoozeUntilEvent: %v", err)
	}
	if !got.Snoozed() || got.SnoozeEvent == nil || got.SavedAt.IsZero() || !got.SnoozedUntil.IsZero() {
		e.t.Fatalf("snoozed = %+v", got)
	}
	return got
}

// snoozeSubs are the store's snooze subscriptions, in memory.
func (e *env) snoozeSubs() []Subscription {
	s := e.m.subs
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []Subscription
	for _, r := range s.byID {
		if r.snooze != nil {
			out = append(out, r.s)
		}
	}
	return out
}

// woken waits for thread id's snooze to have ended by its event.
func (e *env) woken(id string) Thread {
	e.t.Helper()
	return e.waitFor(id, "the snooze to end", func(s Thread) bool { return !s.Snoozed() && s.StatusReason == ReasonSnoozeEnded })
}

func TestSnoozeUntilEventRefusals(t *testing.T) {
	open := PullRequestInfo{Slug: "acme/web", Number: 7, State: "open", Checks: pending4, Title: "Fix login"}
	tests := []struct {
		name string
		pr   PullRequestInfo
		ev   EventSnooze
		code error
		says string
	}{
		{name: "nothing", ev: EventSnooze{}, code: ErrInvalidArgument, says: "give a pull request or a plugin"},
		{name: "both", ev: EventSnooze{PullRequest: snoozePR, Plugin: "hello/tick"}, code: ErrInvalidArgument},
		{name: "changed", pr: open, ev: EventSnooze{PullRequest: snoozePR, Condition: CondChanged}, code: ErrInvalidArgument, says: "not \"changed\""},
		{name: "a thread condition", pr: open, ev: EventSnooze{PullRequest: snoozePR, Condition: CondSettled}, code: ErrInvalidArgument},
		{name: "args on a pull request", pr: open, ev: EventSnooze{PullRequest: snoozePR, Args: map[string]string{"a": "b"}}, code: ErrInvalidArgument},
		{name: "a condition on a plugin", ev: EventSnooze{Plugin: "hello/tick", Condition: CondMerged}, code: ErrInvalidArgument},
		{name: "not a plugin source", ev: EventSnooze{Plugin: "hello"}, code: ErrInvalidArgument},
		{name: "unknown plugin source", ev: EventSnooze{Plugin: "hello/nope"}, code: ErrNotFound},
		{name: "a short number with no pull request", ev: EventSnooze{PullRequest: "#7"}, code: ErrInvalidArgument, says: "give owner/name#7"},
		{name: "not on GitHub", ev: EventSnooze{PullRequest: "acme/web#9"}, code: ErrFailedPrecondition, says: "could not check"},
		{name: "checks already finished", pr: PullRequestInfo{Slug: "acme/web", Number: 7, State: "open", Checks: failed4},
			ev: EventSnooze{PullRequest: snoozePR}, code: ErrFailedPrecondition, says: "checks on #7 already finished (3 passed, 1 failed); there is nothing to wait for"},
		{name: "checks already passed", pr: PullRequestInfo{Slug: "acme/web", Number: 7, State: "open", Checks: passed4},
			ev: EventSnooze{PullRequest: snoozePR, Condition: CondChecksPassed}, code: ErrFailedPrecondition, says: "already passed (4 of 4)"},
		{name: "already merged", pr: PullRequestInfo{Slug: "acme/web", Number: 7, State: "merged"},
			ev: EventSnooze{PullRequest: snoozePR, Condition: CondMerged}, code: ErrFailedPrecondition, says: "#7 is already merged"},
		{name: "merged, waiting for a review", pr: PullRequestInfo{Slug: "acme/web", Number: 7, State: "merged"},
			ev: EventSnooze{PullRequest: snoozePR, Condition: CondReview}, code: ErrFailedPrecondition, says: "#7 is merged, so it can no longer be reviewed"},
		{name: "closed, waiting for the merge", pr: PullRequestInfo{Slug: "acme/web", Number: 7, State: "closed"},
			ev: EventSnooze{PullRequest: snoozePR, Condition: CondMerged}, code: ErrFailedPrecondition, says: "#7 is closed, so it can no longer be merged"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var prs *fakePRs
			if tt.pr.Number != 0 {
				prs = newFakePRs(tt.pr)
			} else {
				prs = newFakePRs()
			}
			e := newEnv(t, prs.opts)
			e.m.SetPluginWakes(&fakePluginWakes{})
			s := e.stopped("x")
			_, err := e.m.SnoozeUntilEvent(e.ctx(), s.ID, tt.ev)
			if !errors.Is(err, tt.code) || !strings.Contains(err.Error(), tt.says) {
				t.Fatalf("err = %v, want %v saying %q", err, tt.code, tt.says)
			}
			if got, _ := e.m.Get(e.ctx(), s.ID); got.Snoozed() || got.SnoozeEvent != nil {
				t.Errorf("a refusal snoozed it: %+v", got)
			}
			if subs := e.snoozeSubs(); len(subs) != 0 {
				t.Errorf("a refusal kept %+v", subs)
			}
		})
	}
}

// Each condition a snooze takes ends it on the poll's change that meets it, saying what
// happened; nothing is sent to the thread, and the wake limit plays no part.
func TestSnoozeUntilPullRequestEvent(t *testing.T) {
	push := PullRequestChange{Kind: PRChangeHeadPushed, OldHeadSHA: "a", NewHeadSHA: "b"}
	review := func() PullRequestEvent {
		ev := prEvent(pending4, PullRequestChange{Kind: PRChangeReviews, OldCount: 0, NewCount: 1})
		ev.PullRequest.LatestReviews = []PRReview{{Author: "octocat", State: "CHANGES_REQUESTED"}}
		return ev
	}
	tests := []struct {
		cond Condition
		ev   PullRequestEvent
		want string
	}{
		{CondChecksDone, prEvent(failed4, checksChange(pending4, failed4)), "Checks failed on #7 (1 of 4)"},
		{CondChecksPassed, prEvent(passed4, checksChange(pending4, passed4)), "Checks passed on #7 (4 of 4)"},
		{CondChecksFailed, prEvent(failed4, checksChange(pending4, failed4)), "Checks failed on #7 (1 of 4)"},
		{CondReview, review(), "#7 was reviewed (changes requested by octocat)"},
		{CondComment, prEvent(pending4, PullRequestChange{Kind: PRChangeComments, OldCount: 1, NewCount: 2}), "#7 got a new comment"},
		{CondReviewRequested, prEvent(pending4, PullRequestChange{Kind: PRChangeReviewRequested, Requested: []string{"a"}}), "A review was requested on #7"},
		{CondHeadPushed, prEvent(pending4, push), "New commits were pushed to #7"},
		{CondMerged, stateEvent("merged", PRChangeMerged), "#7 was merged"},
		{CondClosed, stateEvent("closed", PRChangeClosed), "#7 was closed"},
	}
	for _, tt := range tests {
		t.Run(string(tt.cond), func(t *testing.T) {
			prs := newFakePRs(PullRequestInfo{Slug: "acme/web", Number: 7, State: "open", Checks: pending4, Title: "Fix login"})
			clk := newTestClock()
			e := newEnv(t, prs.opts, clk.opts(), func(o *Options) { o.WakeLimit = 1 })
			s := e.eventSnoozed(EventSnooze{PullRequest: "https://github.com/Acme/web/pull/7", Condition: tt.cond})
			if ev := s.SnoozeEvent; ev.Target != snoozePR || ev.Condition != tt.cond || ev.Title != "Fix login" || ev.Kind != TargetPullRequest {
				t.Errorf("event = %+v", ev)
			}
			if subs, _ := e.m.Subscriptions(e.ctx(), s.ID); len(subs) != 0 {
				t.Errorf("listed %+v", subs)
			}
			if w := watchedNow(prs); !slices.Equal(w, []string{snoozePR}) {
				t.Errorf("watched %q", w)
			}
			// Another pull request's change, and a change this condition ignores, leave it.
			other := prEvent(pending4, PullRequestChange{Kind: PRChangeTitle})
			other.PullRequest.Number = 8
			e.m.PullRequestChanged(other)
			e.m.PullRequestChanged(prEvent(pending4, PullRequestChange{Kind: PRChangeDraft}))
			if got, _ := e.m.Get(e.ctx(), s.ID); !got.Snoozed() {
				t.Fatalf("woken by a change that does not meet %s", tt.cond)
			}
			at := clk.advance(time.Minute)
			e.m.PullRequestChanged(tt.ev)
			got := e.woken(s.ID)
			if got.SnoozeEndedBy != tt.want || got.Status != StatusNeedsAttention || !got.StatusChangedAt.Equal(at) || got.SnoozeEvent != nil {
				t.Errorf("woken = %s %q at %v, ended by %q, event %+v; want %q", got.Status, got.StatusReason, got.StatusChangedAt, got.SnoozeEndedBy, got.SnoozeEvent, tt.want)
			}
			if subs := e.snoozeSubs(); len(subs) != 0 {
				t.Errorf("left %+v", subs)
			}
			if w := watchedNow(prs); len(w) != 0 {
				t.Errorf("still watched %q", w)
			}
			if n := len(wakes(e.items(s.ID).Items)); n != 0 {
				t.Errorf("%d wakes sent", n)
			}
			e.restart(prs.opts, clk.opts())
			if got, _ := e.m.Get(e.ctx(), s.ID); got.SnoozeEndedBy != tt.want || got.StatusReason != ReasonSnoozeEnded {
				t.Errorf("after a restart = %q %q", got.StatusReason, got.SnoozeEndedBy)
			}
		})
	}
}

// A close or merge that leaves the event unable to happen ends the snooze, saying so.
func TestSnoozeUntilEventCannotHappen(t *testing.T) {
	tests := []struct {
		cond Condition
		ev   PullRequestEvent
		want string
	}{
		{CondMerged, stateEvent("closed", PRChangeClosed), "#7 was closed, so it can no longer be merged"},
		{CondChecksDone, stateEvent("merged", PRChangeMerged), "#7 was merged, so it can no longer finish its checks"},
		{CondReview, stateEvent("closed", PRChangeClosed), "#7 was closed, so it can no longer be reviewed"},
	}
	for _, tt := range tests {
		t.Run(string(tt.cond), func(t *testing.T) {
			prs := newFakePRs(PullRequestInfo{Slug: "acme/web", Number: 7, State: "open", Checks: pending4})
			e := newEnv(t, prs.opts)
			s := e.eventSnoozed(EventSnooze{PullRequest: snoozePR, Condition: tt.cond})
			e.m.PullRequestChanged(tt.ev)
			if got := e.woken(s.ID); got.SnoozeEndedBy != tt.want {
				t.Errorf("ended by %q, want %q", got.SnoozeEndedBy, tt.want)
			}
		})
	}
}

// A snooze on a plugin's wake source: armed with the plugin like a subscription, ended by
// a fire that matches its args (counted as delivered), or by the source going away. The
// user's are remembered, newest first; a thread's own are not.
func TestSnoozeUntilPlugin(t *testing.T) {
	e := newEnv(t)
	pw := &fakePluginWakes{}
	e.m.SetPluginWakes(pw)
	a := e.eventSnoozed(EventSnooze{Plugin: "hello/tick", Args: map[string]string{"every": "1h"}})
	ev := a.SnoozeEvent
	if ev.Kind != TargetPlugin || ev.Condition != CondFired || ev.Title != "tick" || ev.PluginName != "Hello" || ev.Args["every"] != "1h" {
		t.Errorf("event = %+v", ev)
	}
	if ev.Label() != "tick" || ev.WaitingFor() != "tick (Hello)" {
		t.Errorf("label %q, waiting for %q", ev.Label(), ev.WaitingFor())
	}
	pw.waitNotes(t, "+"+ev.SubscriptionID)
	if subs := e.m.PluginSubscriptions("hello"); len(subs) != 1 || subs[0].SubscriberID != a.ID {
		t.Errorf("re-arm list %+v", subs)
	}
	if n := e.m.FirePlugin("hello", "Hello", "tick", map[string]string{"every": "2s"}, "tick 1", nil); n != 0 {
		t.Errorf("another every woke %d", n)
	}
	if n := e.m.FirePlugin("hello", "Hello", "tick", map[string]string{"every": "1h"}, "deploy finished", nil); n != 1 {
		t.Errorf("fire woke %d, want 1", n)
	}
	if got := e.woken(a.ID); got.SnoozeEndedBy != "Hello: deploy finished" {
		t.Errorf("ended by %q", got.SnoozeEndedBy)
	}
	pw.waitNotes(t, "+"+ev.SubscriptionID, "-"+ev.SubscriptionID)

	b := e.eventSnoozed(EventSnooze{Plugin: "hello/gone"})
	if n := e.m.PluginWakesGone("hello", "Hello", nil, "the plugin was disabled"); n != 1 {
		t.Errorf("gone %d", n)
	}
	if got := e.woken(b.ID); got.SnoozeEndedBy != "Hello: gone can no longer fire (the plugin was disabled)" {
		t.Errorf("ended by %q", got.SnoozeEndedBy)
	}
	for _, id := range []string{a.ID, b.ID} {
		if n := len(wakes(e.items(id).Items)); n != 0 {
			t.Errorf("%s: %d wakes sent", id, n)
		}
	}

	c := e.stopped("self")
	if _, err := e.m.SnoozeUntilEvent(AskedBy(e.ctx(), c.ID), c.ID, EventSnooze{Plugin: "hello/thread"}); err != nil {
		t.Fatal(err)
	}
	evs, err := e.m.SnoozeEvents(e.ctx(), c.ID)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"hello/gone", "hello/tick"}; !slices.Equal(evs.RecentPlugins, want) {
		t.Errorf("recent %q, want %q (the user's, newest first; not the thread's own)", evs.RecentPlugins, want)
	}
}

// The recent list keeps the latest use of each source, newest first, at most ten.
func TestRecentSnoozes(t *testing.T) {
	clk := newTestClock()
	e := newEnv(t, clk.opts())
	for i, target := range []string{"a/x", "b/x", "c/x", "a/x", "d/x", "e/x", "f/x", "g/x", "h/x", "i/x", "j/x", "k/x"} {
		e.m.noteRecentSnooze(target, clk.advance(time.Duration(i+1)*time.Second))
	}
	got, err := loadRecentSnoozes(e.ctx(), e.m.opts.DB)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"k/x", "j/x", "i/x", "h/x", "g/x", "f/x", "e/x", "d/x", "a/x", "c/x"}
	if !slices.Equal(got, want) {
		t.Errorf("recent %q, want %q", got, want)
	}
}

// The wait survives a restart: the subscription is armed again, the pull request watched,
// and the next change ends it.
func TestSnoozeUntilEventRestart(t *testing.T) {
	prs := newFakePRs(PullRequestInfo{Slug: "acme/web", Number: 7, State: "open", Checks: pending4, Title: "Fix login"})
	e := newEnv(t, prs.opts)
	s := e.eventSnoozed(EventSnooze{PullRequest: snoozePR, Condition: CondMerged})
	e.restart(prs.opts)
	got, _ := e.m.Get(e.ctx(), s.ID)
	if !got.Snoozed() || got.SnoozeEvent == nil || got.SnoozeEvent.Title != "Fix login" || got.SnoozeEvent.SubscriptionID != s.SnoozeEvent.SubscriptionID ||
		!got.SnoozeEvent.Since.Equal(s.SnoozeEvent.Since) {
		t.Fatalf("after a restart = %+v", got.SnoozeEvent)
	}
	if w := watchedNow(prs); !slices.Equal(w, []string{snoozePR}) {
		t.Errorf("watched %q", w)
	}
	e.m.PullRequestChanged(stateEvent("merged", PRChangeMerged))
	if got := e.woken(s.ID); got.SnoozeEndedBy != "#7 was merged" {
		t.Errorf("ended by %q", got.SnoozeEndedBy)
	}
}

// Every other end of the snooze drops the event: an unsnooze, a timed snooze, a save, a
// pin, an archive and the user's message. Nothing is left watched or listed.
func TestSnoozeUntilEventDropped(t *testing.T) {
	tests := []struct {
		name string
		act  func(e *env, id string)
		// snoozed: still put away afterwards (another form).
		snoozed bool
	}{
		{name: "unsnooze", act: func(e *env, id string) { e.must(e.m.Snooze(e.ctx(), id, time.Time{})) }},
		{name: "timed snooze", snoozed: true, act: func(e *env, id string) { e.must(e.m.Snooze(e.ctx(), id, time.Now().Add(time.Hour))) }},
		{name: "save", snoozed: true, act: func(e *env, id string) { e.must(e.m.SaveForLater(e.ctx(), id)) }},
		{name: "pin", act: func(e *env, id string) { e.must(e.m.Pin(e.ctx(), id, true)) }},
		{name: "archive", act: func(e *env, id string) {
			_, err := e.m.Archive(e.ctx(), id, true)
			if err != nil {
				e.t.Fatal(err)
			}
		}},
		{name: "another event", snoozed: true, act: func(e *env, id string) {
			e.must(e.m.SnoozeUntilEvent(e.ctx(), id, EventSnooze{PullRequest: snoozePR, Condition: CondReview}))
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			prs := newFakePRs(PullRequestInfo{Slug: "acme/web", Number: 7, State: "open", Checks: pending4})
			e := newEnv(t, prs.opts)
			s := e.eventSnoozed(EventSnooze{PullRequest: snoozePR, Condition: CondMerged})
			first := s.SnoozeEvent.SubscriptionID
			tt.act(e, s.ID)
			got, _ := e.m.Get(e.ctx(), s.ID)
			if got.Snoozed() != tt.snoozed {
				t.Errorf("snoozed = %v", got.Snoozed())
			}
			if tt.name != "another event" {
				if got.SnoozeEvent != nil || len(e.snoozeSubs()) != 0 || len(watchedNow(prs)) != 0 {
					t.Errorf("left event %+v, subs %+v, watched %q", got.SnoozeEvent, e.snoozeSubs(), watchedNow(prs))
				}
			} else if subs := e.snoozeSubs(); len(subs) != 1 || subs[0].ID == first || subs[0].Condition != CondReview {
				t.Errorf("subs %+v", subs)
			}
			if tt.name != "another event" {
				// The old subscription's event no longer ends anything.
				e.m.PullRequestChanged(stateEvent("merged", PRChangeMerged))
				time.Sleep(20 * time.Millisecond)
				if got, _ := e.m.Get(e.ctx(), s.ID); got.SnoozeEndedBy != "" {
					t.Errorf("ended by %q", got.SnoozeEndedBy)
				}
			}
			e.restart(prs.opts)
			if got, _ := e.m.Get(e.ctx(), s.ID); (got.SnoozeEvent != nil) != (tt.name == "another event") {
				t.Errorf("after a restart event = %+v", got.SnoozeEvent)
			}
		})
	}
}

// watchedNow is the last set WatchPullRequests got.
func watchedNow(prs *fakePRs) []string {
	w, _ := prs.lastWatched()
	return w
}

func (e *env) must(_ Thread, err error) {
	e.t.Helper()
	if err != nil {
		e.t.Fatal(err)
	}
}

// A thread snoozes itself until its checks pass ("snooze this thread until checks pass on
// #7"): it keeps running, at its prompt; the event marks it snooze ended on its runner.
func TestSnoozeUntilEventItself(t *testing.T) {
	prs := newFakePRs(PullRequestInfo{Slug: "acme/web", Number: 7, State: "open", Checks: pending4})
	e := newEnv(t, prs.opts, func(o *Options) {
		o.ThreadPullRequests = func(context.Context, Thread) []string { return []string{snoozePR} }
	})
	s := e.connected(CreateOptions{Name: "self"})
	got, err := e.m.SnoozeUntilEvent(AskedBy(e.ctx(), s.ID), s.ID, EventSnooze{PullRequest: "#7", Condition: CondChecksPassed})
	if err != nil {
		t.Fatal(err)
	}
	if got.State != StateConnected || got.SnoozeEvent == nil || got.SnoozeEvent.Target != snoozePR {
		t.Fatalf("snoozed = %s %+v", got.State, got.SnoozeEvent)
	}
	e.m.PullRequestChanged(prEvent(passed4, checksChange(pending4, passed4)))
	woke := e.woken(s.ID)
	if woke.State != StateConnected || woke.SnoozeEndedBy != "Checks passed on #7 (4 of 4)" {
		t.Errorf("woken = %s %q", woke.State, woke.SnoozeEndedBy)
	}
}

// fakeSources is fakePluginWakes with the menu's sources.
type fakeSources struct {
	fakePluginWakes
	sources []PluginSource
}

func (f *fakeSources) Sources(context.Context, Thread) []PluginSource { return f.sources }

// The events read: open, non-draft pull requests newest first with their pending
// conditions only; the running plugins' sources; the recent list.
func TestSnoozeEvents(t *testing.T) {
	prs := newFakePRs(
		PullRequestInfo{Slug: "acme/web", Number: 7, State: "open", Checks: pending4, Title: "Seven"},
		PullRequestInfo{Slug: "acme/web", Number: 12, State: "open", Checks: passed4, ReviewDecision: "APPROVED", Title: "Twelve"},
		PullRequestInfo{Slug: "acme/web", Number: 9, State: "open", Draft: true, Checks: pending4},
		PullRequestInfo{Slug: "acme/web", Number: 3, State: "merged"},
		PullRequestInfo{Slug: "acme/api", Number: 2, State: "open", Title: "No checks"},
	)
	e := newEnv(t, prs.opts, func(o *Options) {
		o.ThreadPullRequests = func(context.Context, Thread) []string {
			return []string{"acme/web#7", "acme/web#12", "acme/web#9", "acme/web#3", "acme/api#2", "acme/web#404"}
		}
	})
	src := PluginSource{Target: "hello/tick", Title: "Tick", PluginName: "Hello", Args: map[string]string{"every": "10s"}}
	e.m.SetPluginWakes(&fakeSources{sources: []PluginSource{src}})
	s := e.stopped("x")
	got, err := e.m.SnoozeEvents(e.ctx(), s.ID)
	if err != nil {
		t.Fatal(err)
	}
	all := []Condition{CondChecksDone, CondReview, CondMerged, CondComment, CondHeadPushed, CondClosed, CondReviewRequested}
	want := []SnoozePullRequest{
		{Target: "acme/web#12", Number: 12, Title: "Twelve", Conditions: []Condition{CondMerged, CondComment, CondHeadPushed, CondClosed, CondReviewRequested}},
		{Target: "acme/web#7", Number: 7, Title: "Seven", Conditions: all},
		{Target: "acme/api#2", Number: 2, Title: "No checks", Conditions: all[1:]},
	}
	if !slices.EqualFunc(got.PullRequests, want, func(a, b SnoozePullRequest) bool {
		return a.Target == b.Target && a.Number == b.Number && a.Title == b.Title && slices.Equal(a.Conditions, b.Conditions)
	}) {
		t.Errorf("pull requests\n got %+v\nwant %+v", got.PullRequests, want)
	}
	if len(got.Plugins) != 1 || got.Plugins[0].Target != src.Target || !maps.Equal(got.Plugins[0].Args, src.Args) {
		t.Errorf("plugins %+v", got.Plugins)
	}
	if _, err := e.m.SnoozeEvents(e.ctx(), "s-nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown: %v", err)
	}
	// The title and plugin name of a snooze come from the sources.
	snoozed, err := e.m.SnoozeUntilEvent(e.ctx(), s.ID, EventSnooze{Plugin: "hello/tick"})
	if err != nil {
		t.Fatal(err)
	}
	if ev := snoozed.SnoozeEvent; ev.Title != "Tick" || ev.PluginName != "Hello" || ev.WaitingFor() != "Tick (Hello)" {
		t.Errorf("event %+v", ev)
	}
}

func TestSnoozeEventWords(t *testing.T) {
	tests := []struct {
		ev            SnoozeEvent
		label, waiter string
	}{
		{SnoozeEvent{Kind: TargetPullRequest, Target: "acme/web#812", Condition: CondChecksDone}, "#812 checks", "checks finish on #812"},
		{SnoozeEvent{Kind: TargetPullRequest, Target: "acme/web#790", Condition: CondMerged}, "#790 merged", "#790 is merged"},
		{SnoozeEvent{Kind: TargetPullRequest, Target: "acme/web#5", Condition: CondReview}, "#5 review", "#5 is reviewed"},
		{SnoozeEvent{Kind: TargetPullRequest, Target: "acme/web#5", Condition: CondReviewRequested}, "#5 review request", "a review is requested on #5"},
		{SnoozeEvent{Kind: TargetPlugin, Target: "vercel/deploy", Title: "Deploy finished", PluginName: "Vercel"}, "deploy", "Deploy finished (Vercel)"},
	}
	for _, tt := range tests {
		if got := tt.ev.Label(); got != tt.label {
			t.Errorf("Label(%s %s) = %q, want %q", tt.ev.Target, tt.ev.Condition, got, tt.label)
		}
		if got := tt.ev.WaitingFor(); got != tt.waiter {
			t.Errorf("WaitingFor(%s %s) = %q, want %q", tt.ev.Target, tt.ev.Condition, got, tt.waiter)
		}
	}
}

// The wake limit does not swallow a snooze's end: a thread whose wakes are spent still wakes
// from its snooze when the event happens.
func TestSnoozeUntilEventPastTheWakeLimit(t *testing.T) {
	prs := newFakePRs(PullRequestInfo{Slug: "acme/web", Number: 7, State: "open", Checks: pending4})
	e, parent := limited(t, prs, newTestClock())
	spend(e, parent)
	if _, err := e.m.SnoozeUntilEvent(e.ctx(), parent.ID, EventSnooze{PullRequest: snoozePR, Condition: CondMerged}); err != nil {
		t.Fatal(err)
	}
	e.m.PullRequestChanged(stateEvent("merged", PRChangeMerged))
	// The spent wake started the thread: it may still be working, and then keeps its own
	// status (as a timed wake leaves it), so wait for the snooze itself to end.
	e.waitFor(parent.ID, "the snooze to end", func(s Thread) bool { return !s.Snoozed() && s.SnoozeEndedBy == "#7 was merged" })
}
