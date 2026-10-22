package api

import (
	"context"
	"errors"
	"slices"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/presence"
)

// changeLog records a presence tracker's changes as "from>to".
type changeLog struct {
	mu  sync.Mutex
	got []string
}

func (l *changeLog) record(from, to presence.State) {
	l.mu.Lock()
	l.got = append(l.got, from.String()+">"+to.String())
	l.mu.Unlock()
}

func (l *changeLog) all() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return slices.Clone(l.got)
}

func TestClientsPresence(t *testing.T) {
	type op struct {
		do      string // join, leave, set
		id      string
		visible bool
		focused bool
	}
	none := presence.State{}
	bg := presence.State{Kind: presence.Background}
	fg := presence.State{Kind: presence.Foreground}
	att := presence.State{Kind: presence.Foreground, Attended: true}
	tests := []struct {
		name    string
		ops     []op
		want    presence.State
		changes []string
		setOK   bool // the last set found its client
	}{
		{name: "nobody", want: none},
		{name: "one visible", ops: []op{{"join", "a", true, false}}, want: fg, changes: []string{"none>foreground"}},
		{name: "one hidden", ops: []op{{"join", "a", false, false}}, want: bg, changes: []string{"none>background"}},
		{name: "hidden then shown", ops: []op{{"join", "a", false, false}, {"set", "a", true, false}},
			want: fg, changes: []string{"none>background", "background>foreground"}, setOK: true},
		{name: "shown then hidden", ops: []op{{"join", "a", true, false}, {"set", "a", false, false}},
			want: bg, changes: []string{"none>foreground", "foreground>background"}, setOK: true},
		{name: "same state again: no change", ops: []op{{"join", "a", true, true}, {"set", "a", true, true}},
			want: att, changes: []string{"none>foreground+attended"}, setOK: true},
		{name: "two clients, one hidden: foreground", ops: []op{{"join", "a", true, false}, {"join", "b", false, false}},
			want: fg, changes: []string{"none>foreground"}},
		{name: "two clients, the visible one hides", ops: []op{{"join", "a", true, false}, {"join", "b", false, false}, {"set", "a", false, false}},
			want: bg, changes: []string{"none>foreground", "foreground>background"}, setOK: true},
		{name: "two clients, the visible one leaves", ops: []op{{"join", "a", true, false}, {"join", "b", false, false}, {"leave", "a", false, false}},
			want: bg, changes: []string{"none>foreground", "foreground>background"}},
		{name: "last one leaves", ops: []op{{"join", "a", false, false}, {"leave", "a", false, false}},
			want: none, changes: []string{"none>background", "background>none"}},
		{name: "unknown id", ops: []op{{"join", "a", false, false}, {"set", "zz", true, true}},
			want: bg, changes: []string{"none>background"}, setOK: false},
		{name: "after leave the id is unknown", ops: []op{{"join", "a", false, false}, {"leave", "a", false, false}, {"set", "a", true, true}},
			want: none, changes: []string{"none>background", "background>none"}, setOK: false},
		{name: "a stream without an id counts", ops: []op{{"join", "", true, true}},
			want: att, changes: []string{"none>foreground+attended"}},
		{name: "an empty id cannot be set", ops: []op{{"join", "", false, false}, {"set", "", true, true}},
			want: bg, changes: []string{"none>background"}, setOK: false},
		{name: "a reused id replaces; the first's leave keeps the second", ops: []op{{"join", "a", false, false}, {"join", "a", true, false}, {"leave", "a", false, false}},
			want: fg, changes: []string{"none>background", "background>foreground"}},
		// Focus: attended only while one client is visible and focused at once.
		{name: "visible and focused: attended", ops: []op{{"join", "a", true, true}}, want: att, changes: []string{"none>foreground+attended"}},
		{name: "visible but unfocused (another app active): not attended", ops: []op{{"join", "a", true, true}, {"set", "a", true, false}},
			want: fg, changes: []string{"none>foreground+attended", "foreground+attended>foreground"}, setOK: true},
		{name: "focused but hidden (minimized or covered): not attended", ops: []op{{"join", "a", false, true}},
			want: bg, changes: []string{"none>background"}},
		{name: "focus returns: attended again", ops: []op{{"join", "a", true, false}, {"set", "a", true, true}},
			want: att, changes: []string{"none>foreground", "foreground>foreground+attended"}, setOK: true},
		{name: "hidden then shown while focused", ops: []op{{"join", "a", false, true}, {"set", "a", true, true}},
			want: att, changes: []string{"none>background", "background>foreground+attended"}, setOK: true},
		{name: "two clients: one visible unfocused, one focused hidden: not attended", ops: []op{{"join", "a", true, false}, {"join", "b", false, true}},
			want: fg, changes: []string{"none>foreground"}},
		{name: "two clients: the attended one leaves", ops: []op{{"join", "a", true, true}, {"join", "b", true, false}, {"leave", "a", false, false}},
			want: fg, changes: []string{"none>foreground+attended", "foreground+attended>foreground"}},
		{name: "two clients: one stays attended while the other hides", ops: []op{{"join", "a", true, true}, {"join", "b", true, true}, {"set", "a", false, false}},
			want: att, changes: []string{"none>foreground+attended"}, setOK: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			log := &changeLog{}
			c := NewClients(nil)
			c.Tracker().Subscribe(log.record)
			leaves := map[string][]func(){}
			setOK := false
			for _, o := range tt.ops {
				st := presence.Client{Visible: o.visible, Focused: o.focused}
				switch o.do {
				case "join":
					leaves[o.id] = append(leaves[o.id], c.Join(o.id, st))
				case "leave":
					leaves[o.id][0]()
					leaves[o.id] = leaves[o.id][1:]
				case "set":
					setOK = c.SetState(o.id, st)
				}
			}
			if got := c.Presence(); got != tt.want {
				t.Errorf("presence = %v, want %v", got, tt.want)
			}
			if got := c.Tracker().Current(); got != tt.want {
				t.Errorf("tracker = %v, want %v", got, tt.want)
			}
			if got := log.all(); !slices.Equal(got, tt.changes) {
				t.Errorf("changes = %v, want %v", got, tt.changes)
			}
			if setOK != tt.setOK {
				t.Errorf("set found = %t, want %t", setOK, tt.setOK)
			}
		})
	}
}

// Windows counts the joined GUI streams: with an id or without, a reused id once.
func TestClientsWindows(t *testing.T) {
	c := NewClients(nil)
	if n := c.Windows(); n != 0 {
		t.Fatalf("windows = %d with nobody", n)
	}
	leaveA := c.Join("a", presence.Client{Visible: true})
	leaveAnon := c.Join("", presence.Client{})
	c.Join("b", presence.Client{})
	c.Join("b", presence.Client{Visible: true}) // replaces the first b
	if n := c.Windows(); n != 3 {
		t.Errorf("windows = %d, want 3", n)
	}
	leaveA()
	leaveAnon()
	if n := c.Windows(); n != 1 {
		t.Errorf("windows = %d after two left, want 1", n)
	}
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// Watch registers GUI streams (not CLI or unspecified ones) with their visibility and
// focus until they end, and SetClientState updates both for an open one.
func TestEventsClientState(t *testing.T) {
	f := newEventsFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	open := func(req *v1.WatchEventsRequest) (*eventStream, context.CancelFunc) {
		t.Helper()
		sctx, stop := context.WithCancel(ctx)
		req.Sources = []v1.EventSource{v1.EventSource_EVENT_SOURCE_SETTINGS}
		s, err := f.client.Watch(sctx, connect.NewRequest(req))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = s.Close() })
		e := &eventStream{t: t, s: s}
		e.next() // the snapshot: the stream has joined
		return e, stop
	}
	set := func(id string, visible bool, focused ...bool) error {
		_, err := f.client.SetClientState(ctx, connect.NewRequest(&v1.SetClientStateRequest{ClientId: id, Visible: visible, Focused: len(focused) > 0 && focused[0]}))
		return err
	}

	_, stopCLI := open(&v1.WatchEventsRequest{ClientKind: v1.ClientKind_CLIENT_KIND_CLI, ClientId: "cli", Visible: true})
	_, stopAny := open(&v1.WatchEventsRequest{ClientId: "unspecified", Visible: true})
	if p := f.clients.Presence(); p.Kind != presence.None {
		t.Fatalf("presence with CLI streams only = %v, want none", p)
	}
	if err := set("cli", false); connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("SetClientState for a CLI stream: %v, want NotFound", err)
	}
	stopCLI()
	stopAny()

	_, stopA := open(&v1.WatchEventsRequest{ClientKind: v1.ClientKind_CLIENT_KIND_GUI, ClientId: "a", Visible: false})
	if p := f.clients.Presence(); p.Kind != presence.Background {
		t.Fatalf("presence = %v, want background", p)
	}
	if err := set("a", true); err != nil {
		t.Fatal(err)
	}
	if err := set("a", true, true); err != nil {
		t.Fatal(err)
	}
	if p := f.clients.Presence(); !p.Attended {
		t.Fatalf("presence = %v, want attended", p)
	}
	if err := set("a", true, false); err != nil { // another app became active
		t.Fatal(err)
	}
	_, stopB := open(&v1.WatchEventsRequest{ClientKind: v1.ClientKind_CLIENT_KIND_GUI, ClientId: "b", Visible: false, Focused: true})
	if p := f.clients.Presence(); p != (presence.State{Kind: presence.Foreground}) {
		t.Fatalf("presence = %v, want foreground, not attended (b is focused but hidden)", p)
	}
	stopA()
	eventually(t, "a's stream to leave", func() bool { return f.clients.Presence().Kind == presence.Background })
	if err := set("a", true); connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("SetClientState after the stream ended: %v, want NotFound", err)
	}
	if err := set("", true); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("SetClientState without an id: %v, want InvalidArgument", err)
	}
	stopB()
	eventually(t, "b's stream to leave", func() bool { return f.clients.Presence().Kind == presence.None })
	want := []string{"none>background", "background>foreground", "foreground>foreground+attended",
		"foreground+attended>foreground", "foreground>background", "background>none"}
	if got := f.presence.all(); !slices.Equal(got, want) {
		t.Errorf("changes = %v, want %v", got, want)
	}
}

// Without a registry nothing is recorded and SetClientState finds no stream.
func TestEventsClientStateWithoutRegistry(t *testing.T) {
	h := NewEvents(EventsDeps{})
	_, err := h.SetClientState(context.Background(), connect.NewRequest(&v1.SetClientStateRequest{ClientId: "a", Visible: true}))
	var ce *connect.Error
	if !errors.As(err, &ce) || ce.Code() != connect.CodeNotFound {
		t.Errorf("err = %v, want NotFound", err)
	}
}
