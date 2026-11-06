package api

import (
	"context"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/internal/store/thread/threadtest"
	"github.com/alexwaumann/code-foundry/internal/wstunnel"
	"github.com/alexwaumann/code-foundry/internal/wstunnel/wstunneltest"
)

// threadLog applies a Watch's events as stores/thread.ts does: a snapshot replaces, and an event
// the log already has is dropped.
type threadLog struct {
	t     *testing.T
	seq   uint64
	order []string
	text  map[string]string
}

func (l *threadLog) apply(ev *v1.ThreadEvent) {
	switch e := ev.GetEvent().(type) {
	case *v1.ThreadEvent_Snapshot:
		l.seq = e.Snapshot.GetSeq()
		l.order = nil
		l.text = map[string]string{}
		for _, it := range e.Snapshot.GetItems() {
			l.order = append(l.order, it.GetId())
			l.text[it.GetId()] = it.GetAssistantText().GetText()
		}
	case *v1.ThreadEvent_Appended:
		if l.next(e.Appended.GetSeq()) {
			it := e.Appended.GetItem()
			if _, dup := l.text[it.GetId()]; dup {
				l.t.Errorf("item %s came twice", it.GetId())
			}
			l.order = append(l.order, it.GetId())
			l.text[it.GetId()] = it.GetAssistantText().GetText()
		}
	case *v1.ThreadEvent_Delta:
		if l.next(e.Delta.GetSeq()) {
			l.text[e.Delta.GetItemId()] += e.Delta.GetText()
		}
	}
}

// next reports whether an event with seq applies. Every event here is this thread's, so past
// the snapshot the sequence has no holes.
func (l *threadLog) next(seq uint64) bool {
	if seq <= l.seq {
		return false
	}
	if seq != l.seq+1 {
		l.t.Errorf("seq %d follows %d: events were lost", seq, l.seq)
	}
	l.seq = seq
	return true
}

// A turn streaming through clients that keep losing their socket, each way a socket goes: the
// log that ends up on screen is the daemon's, with nothing lost, doubled or out of order.
func TestWatchThreadAcrossTunnelReconnects(t *testing.T) {
	b := bus.New()
	fake := threadtest.New(b)
	route := NewThread(fake, b).Route()
	mux := http.NewServeMux()
	mux.Handle(route.Path, route.Handler)
	tunnel := wstunnel.New(wstunnel.Options{
		AllowOrigin:  func(string) bool { return true },
		Next:         mux,
		Log:          slog.New(slog.DiscardHandler),
		FinalTimeout: 100 * time.Millisecond,
	})
	front := http.NewServeMux()
	front.Handle(wstunnel.Prefix, tunnel)
	srv := httptest.NewServer(front)
	t.Cleanup(srv.Close)

	fake.Put(thread.Thread{ID: "s1", State: thread.StateConnected})
	fake.AppendItem("s1", thread.Item{ID: "m0", Kind: thread.KindAssistantText})
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	const events = 3000
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		for i := 1; i <= events; i++ {
			if i%25 == 0 {
				fake.AppendItem("s1", thread.Item{ID: fmt.Sprintf("m%d", i), Kind: thread.KindAssistantText})
			} else {
				fake.AppendText("s1", fmt.Sprintf("<%d>", i))
			}
			if i%10 == 0 {
				time.Sleep(time.Millisecond)
			}
		}
	}()

	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/stream" + codefoundryv1connect.ThreadServiceWatchThreadProcedure
	body, err := wstunneltest.Body(&v1.WatchThreadRequest{ThreadId: "s1"})
	if err != nil {
		t.Fatal(err)
	}
	open := func() *wstunneltest.Client {
		t.Helper()
		c, _, err := wstunneltest.Dial{URL: url, Origins: []string{"http://x"}}.Open(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if err := c.Send(ctx, wstunneltest.Headers(""), body); err != nil {
			t.Fatal(err)
		}
		if _, err := c.ReadHead(ctx); err != nil {
			t.Fatal(err)
		}
		return c
	}
	// read takes one event; false for a stream with nothing more to say for now, which loses it.
	read := func(c *wstunneltest.Client, log *threadLog) bool {
		t.Helper()
		quiet, cancel := context.WithTimeout(ctx, 200*time.Millisecond)
		defer cancel()
		f, err := c.ReadFrame(quiet)
		if quiet.Err() != nil {
			return false
		}
		if err != nil {
			t.Fatal(err)
		}
		if f.End() {
			t.Fatalf("the stream ended: %s", f.Payload)
		}
		var ev v1.ThreadEvent
		if err := proto.Unmarshal(f.Payload, &ev); err != nil {
			t.Fatal(err)
		}
		log.apply(&ev)
		return true
	}

	log := &threadLog{t: t, text: map[string]string{}}
	var reconnects int
	for running := true; running; {
		select {
		case <-finished:
			running = false
		default:
		}
		c := open()
		reconnects++
		for n := rand.IntN(60); n >= 0 && read(c, log); n-- {
		}
		switch reconnects % 3 {
		case 0: // a resync or a tab switch
			_ = c.Conn.Close(websocket.StatusNormalClosure, "")
		case 1: // a socket that died
			_ = c.Conn.CloseNow()
		case 2: // a count that is not one: what an old daemon saw of a new page
			_ = c.Conn.Write(ctx, websocket.MessageText, []byte("nope"))
			_ = c.Conn.CloseNow()
		}
	}

	want, err := fake.Items(ctx, "s1")
	if err != nil {
		t.Fatal(err)
	}
	c := open()
	defer func() { _ = c.Conn.CloseNow() }()
	for log.seq < want.Seq {
		if !read(c, log) {
			t.Fatalf("stopped at seq %d of %d", log.seq, want.Seq)
		}
	}
	var order []string
	for _, it := range want.Items {
		order = append(order, it.ID)
		if log.text[it.ID] != it.Text {
			t.Errorf("item %s is %q, want %q", it.ID, log.text[it.ID], it.Text)
		}
	}
	if !slices.Equal(log.order, order) {
		t.Errorf("order %v, want %v", log.order, order)
	}
	if reconnects < 10 {
		t.Errorf("only %d reconnects", reconnects)
	}
	t.Logf("%d events, %d items, %d reconnects", want.Seq, len(order), reconnects)
}
