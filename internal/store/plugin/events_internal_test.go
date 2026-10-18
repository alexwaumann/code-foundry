package plugin

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// fakeFeed is an EventFeed whose subscriptions the test drives with emit.
type fakeFeed struct {
	mu    sync.Mutex
	sends map[string]func(FeedEvent) // by source
	snaps int
}

func (f *fakeFeed) Feed(ctx context.Context, sources []string, send func(FeedEvent)) error {
	for _, s := range sources {
		if s == "bogus" {
			return fmt.Errorf("unknown event source %q", s)
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, s := range sources {
		f.sends[s] = send
		send(FeedEvent{Source: s, Snapshot: true, Event: json.RawMessage(`{"snapshot":"` + s + `"}`)})
	}
	go func() {
		<-ctx.Done()
		f.mu.Lock()
		defer f.mu.Unlock()
		for _, s := range sources {
			delete(f.sends, s)
		}
	}()
	return nil
}

func (f *fakeFeed) Snapshot(_ context.Context, source string) []FeedEvent {
	f.mu.Lock()
	f.snaps++
	f.mu.Unlock()
	return []FeedEvent{{Source: source, Snapshot: true, Event: json.RawMessage(`{"resync":"` + source + `"}`)}}
}

func (f *fakeFeed) emit(source string, ev string) bool {
	f.mu.Lock()
	send := f.sends[source]
	f.mu.Unlock()
	if send == nil {
		return false
	}
	send(FeedEvent{Source: source, Event: json.RawMessage(ev)})
	return true
}

// pumpRig is an event pump writing into a pipe the test reads (or does not).
type pumpRig struct {
	a    *actor
	feed *fakeFeed
	pump *eventPump
	r    *io.PipeReader
	logs *logBuffer
}

func newPumpRig(t *testing.T) *pumpRig {
	t.Helper()
	m := &Manager{opts: Options{Now: time.Now}, log: slog.New(slog.DiscardHandler)}
	logs := newLogBuffer(filepath.Join(t.TempDir(), "p.log"), 1<<20, 1000, time.Now)
	t.Cleanup(logs.close)
	a := &actor{m: m, name: "p", logs: logs}
	r, w := io.Pipe()
	in, inW := io.Pipe() // the plugin never writes: the Conn stays open
	conn := pluginsdk.NewConn(in, w, pluginsdk.ConnOptions{})
	feed := &fakeFeed{sends: map[string]func(FeedEvent){}}
	p := newEventPump(a, conn, feed)
	t.Cleanup(func() {
		p.close()
		_ = r.Close()
		_ = inW.Close()
		_ = conn.Close()
	})
	return &pumpRig{a: a, feed: feed, pump: p, r: r, logs: logs}
}

// read returns the next n events/event params from the pipe.
func (g *pumpRig) read(t *testing.T, sc *bufio.Scanner, n int) []pluginsdk.Event {
	t.Helper()
	var out []pluginsdk.Event
	for len(out) < n && sc.Scan() {
		var w struct {
			Method string          `json:"method"`
			Params pluginsdk.Event `json:"params"`
		}
		if err := json.Unmarshal(sc.Bytes(), &w); err != nil {
			t.Fatal(err)
		}
		if w.Method != pluginsdk.MethodEventsEvent {
			t.Fatalf("method %q", w.Method)
		}
		out = append(out, w.Params)
	}
	if len(out) < n {
		t.Fatalf("read %d events, want %d (%v)", len(out), n, sc.Err())
	}
	return out
}

// Fan-out: a subscription gets each source's snapshot, then live events, in order;
// unsubscribing stops them.
func TestEventPumpFanOut(t *testing.T) {
	g := newPumpRig(t)
	sc := bufio.NewScanner(g.r)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	if _, err := g.pump.subscribe([]string{"bogus"}); pluginsdk.ErrorCode(err) != pluginsdk.CodeInvalidParams {
		t.Fatalf("bogus source: %v", err)
	}
	a, err := g.pump.subscribe([]string{"threads", "gh"})
	if err != nil {
		t.Fatal(err)
	}
	g.feed.emit("threads", `{"n":1}`)
	g.feed.emit("gh", `{"n":2}`)
	got := g.read(t, sc, 4)
	want := []string{`threads true {"snapshot":"threads"}`, `gh true {"snapshot":"gh"}`, `threads false {"n":1}`, `gh false {"n":2}`}
	for i, ev := range got {
		if ev.Subscription != a {
			t.Errorf("event %d of %q, want %q", i, ev.Subscription, a)
		}
		if s := fmt.Sprintf("%s %v %s", []string{"threads", "gh", "threads", "gh"}[i], ev.Snapshot, ev.Event); s != want[i] {
			t.Errorf("event %d = %s, want %s", i, s, want[i])
		}
	}
	if !g.pump.drop(a) || g.pump.drop(a) {
		t.Fatal("drop: want true once")
	}
	// The subscription's context ended: the feed lets go of it.
	deadline := time.Now().Add(2 * time.Second)
	for g.feed.emit("threads", `{"n":3}`) {
		if time.Now().After(deadline) {
			t.Fatal("the feed still sends after unsubscribe")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// Backpressure: while the plugin does not read, the pump holds back at the high water
// mark, the queue drops its oldest events (counted, logged), and once the plugin reads
// again the source's snapshot follows the rest.
func TestEventPumpBackpressure(t *testing.T) {
	g := newPumpRig(t)
	id, err := g.pump.subscribe([]string{"threads"})
	if err != nil {
		t.Fatal(err)
	}
	big := `{"pad":"` + strings.Repeat("x", 4<<10) + `"}`
	total := eventQueueMax + (eventHighWater / len(big)) + 500
	for range total {
		g.feed.emit("threads", big)
	}
	g.pump.mu.Lock()
	dropped, queued, dirty := g.pump.dropped, len(g.pump.q), g.pump.dirty[subSource{id, "threads"}]
	g.pump.mu.Unlock()
	if dropped == 0 || queued > eventQueueMax || !dirty {
		t.Fatalf("dropped %d, queued %d (max %d), dirty %v", dropped, queued, eventQueueMax, dirty)
	}
	// The plugin reads again: everything left arrives, then the resync snapshot.
	sc := bufio.NewScanner(g.r)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	var last pluginsdk.Event
	n := 0
	for sc.Scan() {
		var w struct {
			Params pluginsdk.Event `json:"params"`
		}
		if err := json.Unmarshal(sc.Bytes(), &w); err != nil {
			t.Fatal(err)
		}
		n++
		last = w.Params
		if w.Params.Snapshot && strings.Contains(string(w.Params.Event), "resync") {
			break
		}
	}
	if !last.Snapshot || string(last.Event) != `{"resync":"threads"}` {
		t.Fatalf("last event = %+v after %d", last, n)
	}
	if want := total + 1 - int(dropped) + 1; n != want { // + the first snapshot, + the resync
		t.Errorf("read %d events, want %d (%d sent, %d dropped)", n, want, total, dropped)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		var lines []string
		for _, l := range g.logs.tail(0) {
			lines = append(lines, l.Text)
		}
		if strings.Contains(strings.Join(lines, "\n"), "events: dropped") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("no drop line in the log: %q", lines)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
