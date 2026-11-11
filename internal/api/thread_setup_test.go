package api

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/internal/store/thread/threadtest"
)

func TestThreadSetupRPCs(t *testing.T) {
	fake, c := newThreadServer(t)
	fake.Put(thread.Thread{ID: "s1"})
	fake.KeptWorktrees = []string{"/w/kept"}
	fake.SetupDraft = thread.SetupDraft{DraftJSON: `{"d":1}`, Error: "git says no", Kept: []string{"/w/kept"},
		First:  &thread.SetupMessage{Text: "do x", ComposerText: "do <x>", Attachments: []string{"/a.png"}},
		Queued: []thread.SetupMessage{{Text: "and y"}, {Text: "and z", Attachments: []string{"/b.png"}}}}
	ctx := context.Background()

	retried, err := c.RetrySetup(ctx, connect.NewRequest(&v1.RetryThreadSetupRequest{Id: "s1"}))
	if err != nil || retried.Msg.GetThread().GetId() != "s1" {
		t.Fatalf("RetrySetup = %+v, %v", retried, err)
	}
	cancelled, err := c.CancelSetup(ctx, connect.NewRequest(&v1.CancelThreadSetupRequest{Id: "s1"}))
	if err != nil || cancelled.Msg.GetThread().GetId() != "s1" || !slices.Equal(cancelled.Msg.GetKeptWorktrees(), []string{"/w/kept"}) {
		t.Fatalf("CancelSetup = %+v, %v", cancelled, err)
	}
	discarded, err := c.DiscardSetup(ctx, connect.NewRequest(&v1.DiscardThreadSetupRequest{Id: "s1"}))
	if err != nil {
		t.Fatal(err)
	}
	m := discarded.Msg
	if m.GetDraftJson() != `{"d":1}` || m.GetError() != "git says no" || !slices.Equal(m.GetKeptWorktrees(), []string{"/w/kept"}) {
		t.Errorf("DiscardSetup = %+v", m)
	}
	if f := m.GetFirst(); f.GetText() != "do x" || f.GetComposerText() != "do <x>" || !slices.Equal(f.GetAttachments(), []string{"/a.png"}) {
		t.Errorf("first %+v", f)
	}
	if q := m.GetQueued(); len(q) != 2 || q[1].GetText() != "and z" || !slices.Equal(q[1].GetAttachments(), []string{"/b.png"}) {
		t.Errorf("queued %+v", q)
	}
	if !slices.Equal(fake.Calls(), []string{"RetrySetup s1", "CancelSetup s1", "DiscardSetup s1"}) {
		t.Errorf("calls %q", fake.Calls())
	}
	for name, call := range map[string]func() error{
		"retry": func() error {
			_, err := c.RetrySetup(ctx, connect.NewRequest(&v1.RetryThreadSetupRequest{Id: "gone"}))
			return err
		},
		"cancel": func() error {
			_, err := c.CancelSetup(ctx, connect.NewRequest(&v1.CancelThreadSetupRequest{Id: "gone"}))
			return err
		},
		"discard": func() error {
			_, err := c.DiscardSetup(ctx, connect.NewRequest(&v1.DiscardThreadSetupRequest{Id: "gone"}))
			return err
		},
	} {
		var ce *connect.Error
		if err := call(); !errors.As(err, &ce) || ce.Code() != connect.CodeNotFound {
			t.Errorf("%s: %v", name, err)
		}
	}
}

// A setup's background flag and phase reach the client.
func TestThreadSetupOnTheWire(t *testing.T) {
	s := &thread.Setup{Phase: thread.SetupCancelled, Background: true}
	p := setupToProto(s)
	if !p.GetBackground() || p.GetPhase() != v1.ThreadSetupPhase_THREAD_SETUP_PHASE_CANCELLED {
		t.Errorf("setup %+v", p)
	}
}

// An item that leaves the log can only be told by a new snapshot: a retried setup takes
// back its turn end.
func TestWatchThreadSnapshotAfterItemsReset(t *testing.T) {
	b := bus.New()
	fake := threadtest.New(b)
	srv := serveOnce(t, (&Thread{store: fake, bus: b, beat: time.Hour}).Route(), make(chan struct{}))
	c := codefoundryv1connect.NewThreadServiceClient(srv.Client(), srv.URL)
	fake.Put(thread.Thread{ID: "s1", State: thread.StateConnected})
	fake.PutItems("s1", thread.Item{ID: "u1", Kind: thread.KindUserMessage}, thread.Item{ID: "end", Kind: thread.KindTurnEnd})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	stream, err := c.WatchThread(ctx, connect.NewRequest(&v1.WatchThreadRequest{ThreadId: "s1"}))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = stream.Close() }()
	if !stream.Receive() || len(stream.Msg().GetSnapshot().GetItems()) != 2 {
		t.Fatalf("no snapshot: %v", stream.Err())
	}
	fake.PutItems("s1", thread.Item{ID: "u1", Kind: thread.KindUserMessage})
	bus.Publish[thread.ThreadEvent](b, thread.ItemsReset{ThreadID: "other", Seq: 1000})
	bus.Publish[thread.ThreadEvent](b, thread.ItemsReset{ThreadID: "s1", Seq: 1000})
	if !stream.Receive() {
		t.Fatalf("no new snapshot: %v", stream.Err())
	}
	if n := len(stream.Msg().GetSnapshot().GetItems()); stream.Msg().GetSnapshot() == nil || n != 1 {
		t.Fatalf("want a snapshot of 1 item, got %v", stream.Msg())
	}
}
