package api

import (
	"context"
	"fmt"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/store/repo"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

func (f *eventsFixture) watchSince(t *testing.T, ctx context.Context, since uint64, sources ...v1.EventSource) *eventStream {
	t.Helper()
	s, err := f.client.Watch(ctx, connect.NewRequest(&v1.WatchEventsRequest{Sources: sources, SinceSeq: since}))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return &eventStream{t: t, s: s}
}

// nextLive skips heartbeats.
func (e *eventStream) nextLive() *v1.Event {
	e.t.Helper()
	for {
		if ev := e.next(); ev.GetHeartbeat() == nil {
			return ev
		}
	}
}

func repoNamed(name string) repo.Repo { return repo.Repo{ID: name, Name: name, Path: "/code/" + name} }

// One event has one seq on every stream; seqs grow by one per published event, whatever
// the source; snapshots carry none.
func TestEventsSeqSharedAcrossClients(t *testing.T) {
	f := newEventsFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	a := f.watch(t, ctx, v1.EventSource_EVENT_SOURCE_REPO, v1.EventSource_EVENT_SOURCE_THREAD_LIST)
	b := f.watch(t, ctx, v1.EventSource_EVENT_SOURCE_REPO, v1.EventSource_EVENT_SOURCE_THREAD_LIST)
	for _, s := range []*eventStream{a, b} {
		for _, want := range []string{"repo.snapshot(0)", "thread.snapshot(0)"} {
			ev := s.next()
			if got := describe(ev); got != want || ev.GetSeq() != 0 {
				t.Fatalf("snapshot %q seq %d, want %q seq 0", got, ev.GetSeq(), want)
			}
		}
	}
	f.repo.Put(repoNamed("one"))
	f.th.Put(thread.Thread{ID: "s1", State: thread.StateConnected, Status: thread.StatusBusy})
	f.repo.Put(repoNamed("two"))

	type seen struct {
		what string
		seq  uint64
	}
	read := func(s *eventStream) map[string]uint64 {
		out := map[string]uint64{}
		for range 3 {
			ev := s.nextLive()
			out[describe(ev)] = ev.GetSeq()
		}
		return out
	}
	gotA, gotB := read(a), read(b)
	if fmt.Sprint(gotA) != fmt.Sprint(gotB) {
		t.Fatalf("streams disagree: %v vs %v", gotA, gotB)
	}
	// Order across sources is not kept, but within one it is, and the three seqs are 1..3.
	if gotA["repo.updated one"] >= gotA["repo.updated two"] {
		t.Errorf("repo seqs out of order: %v", gotA)
	}
	sum := uint64(0)
	for _, s := range gotA {
		if s == 0 || s > 3 {
			t.Fatalf("seq %d outside 1..3: %v", s, gotA)
		}
		sum += s
	}
	if sum != 6 {
		t.Errorf("seqs %v, want 1, 2 and 3", gotA)
	}
}

// A client that resumes gets exactly the events after its seq (of its sources), no
// snapshot, then live events.
func TestEventsResumeReplaysMissed(t *testing.T) {
	f := newEventsFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	first := f.watch(t, ctx, v1.EventSource_EVENT_SOURCE_REPO)
	first.next() // snapshot
	f.repo.Put(repoNamed("one"))
	ev := first.nextLive()
	last := ev.GetSeq()
	if describe(ev) != "repo.updated one" || last == 0 {
		t.Fatalf("got %q seq %d", describe(ev), last)
	}
	// Missed by a client that disconnected after "one": a repo, a thread (not asked
	// for), and another repo.
	f.repo.Put(repoNamed("two"))
	f.th.Put(thread.Thread{ID: "s1", State: thread.StateConnected})
	f.repo.Put(repoNamed("three"))
	for range 2 {
		first.nextLive() // the hub has numbered them
	}

	s := f.watchSince(t, ctx, last, v1.EventSource_EVENT_SOURCE_REPO)
	var got []string
	prev := last
	for range 2 {
		ev := s.next()
		if ev.GetSeq() <= prev {
			t.Fatalf("seq %d after %d", ev.GetSeq(), prev)
		}
		prev = ev.GetSeq()
		got = append(got, describe(ev))
	}
	if want := "[repo.updated two repo.updated three]"; fmt.Sprint(got) != want {
		t.Fatalf("replay = %v, want %s", got, want)
	}
	f.repo.Put(repoNamed("four"))
	if ev := s.nextLive(); describe(ev) != "repo.updated four" || ev.GetSeq() <= prev {
		t.Fatalf("live %q seq %d, want repo.updated four after seq %d", describe(ev), ev.GetSeq(), prev)
	}
	prev = f.events.eventHub().lastSeq()

	// Resuming at the newest seq replays nothing and goes on live.
	cur := f.watchSince(t, ctx, prev, v1.EventSource_EVENT_SOURCE_REPO)
	f.repo.Put(repoNamed("five"))
	if got := describe(cur.nextLive()); got != "repo.updated five" {
		t.Fatalf("after resuming at the head: %q", got)
	}
}

// A seq the hub no longer holds (overwritten, or ahead of its counter as after a daemon
// restart) starts the stream over: snapshots, then live.
func TestEventsResumeOutsideLogFallsBack(t *testing.T) {
	f := newEventsFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	first := f.watch(t, ctx, v1.EventSource_EVENT_SOURCE_REPO)
	first.next()
	f.repo.Put(repoNamed("r"))
	first.nextLive()

	ahead := f.watchSince(t, ctx, 1_000_000, v1.EventSource_EVENT_SOURCE_REPO)
	if ev := ahead.next(); describe(ev) != "repo.snapshot(1)" || ev.GetSeq() != 0 {
		t.Fatalf("ahead: first %q seq %d, want the snapshot", describe(ev), ev.GetSeq())
	}

	// Overflow the log (or the hub's own subscription, which starts the log over: either
	// way seq 1 is gone).
	for i := 0; f.floor() <= 1; i++ {
		if i > 4*eventLogSize {
			t.Fatalf("the log still holds seq 1 after %d events", i)
		}
		f.repo.Put(repo.Repo{ID: "r", Name: fmt.Sprint(i)})
		if i >= eventLogSize {
			time.Sleep(time.Millisecond) // let the hub catch up
		}
	}
	old := f.watchSince(t, ctx, 1, v1.EventSource_EVENT_SOURCE_REPO)
	if ev := old.next(); describe(ev) != "repo.snapshot(1)" || ev.GetSeq() != 0 {
		t.Fatalf("too old: first %q seq %d, want the snapshot", describe(ev), ev.GetSeq())
	}
	f.repo.Put(repoNamed("after"))
	if got := describe(old.nextLive()); got != "repo.updated after" {
		t.Fatalf("then live: %q", got)
	}
}

// floor is the hub's oldest resumable seq.
func (f *eventsFixture) floor() uint64 {
	h := f.events.eventHub()
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.floor
}

// UI intents are delivered live with a seq but never replayed, and the hub listens for
// them only while a stream wants them, so Emit still counts connected windows.
func TestEventsTransientTopics(t *testing.T) {
	f := newEventsFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	emit := func(q string) int {
		return command.BusEmitter{Bus: f.bus}.Emit(&v1.UiIntent{Intent: &v1.UiIntent_OpenPalette_{OpenPalette: &v1.UiIntent_OpenPalette{Query: q}}})
	}
	sctx, stop := context.WithCancel(ctx)
	s := f.watch(t, sctx, v1.EventSource_EVENT_SOURCE_UI, v1.EventSource_EVENT_SOURCE_REPO)
	s.next() // repo snapshot
	f.repo.Put(repoNamed("a"))
	before := s.nextLive()
	if describe(before) != "repo.updated a" {
		t.Fatalf("got %q", describe(before))
	}
	if n := emit("one"); n != 1 {
		t.Fatalf("Emit with a stream delivered to %d, want 1", n)
	}
	if ev := s.nextLive(); describe(ev) != "ui.palette one" || ev.GetSeq() <= before.GetSeq() {
		t.Fatalf("got %q seq %d", describe(ev), ev.GetSeq())
	}
	f.repo.Put(repoNamed("b"))
	if got := describe(s.nextLive()); got != "repo.updated b" {
		t.Fatalf("got %q", got)
	}
	stop()
	deadline := time.Now().Add(5 * time.Second)
	for emit("nobody") != 0 {
		if time.Now().After(deadline) {
			t.Fatal("the hub still listens for intents after the last stream left")
		}
		time.Sleep(10 * time.Millisecond)
	}
	// A resume from before the intent replays the repo event after it only.
	r := f.watchSince(t, ctx, before.GetSeq(), v1.EventSource_EVENT_SOURCE_UI, v1.EventSource_EVENT_SOURCE_REPO)
	if got := describe(r.next()); got != "repo.updated b" {
		t.Fatalf("replay = %q, want repo.updated b", got)
	}
}
