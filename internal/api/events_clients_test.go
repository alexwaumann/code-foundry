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
	"github.com/alexwaumann/code-foundry/internal/store/gh"
)

// changeLog records a Clients registry's presence changes as "from>to".
type changeLog struct {
	mu  sync.Mutex
	got []string
}

func (l *changeLog) record(from, to gh.Presence) {
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
	}
	tests := []struct {
		name    string
		ops     []op
		want    gh.Presence
		changes []string
		setOK   bool // the last set found its client
	}{
		{name: "nobody", want: gh.PresenceNone},
		{name: "one visible", ops: []op{{"join", "a", true}}, want: gh.PresenceForeground, changes: []string{"none>foreground"}},
		{name: "one hidden", ops: []op{{"join", "a", false}}, want: gh.PresenceBackground, changes: []string{"none>background"}},
		{name: "hidden then shown", ops: []op{{"join", "a", false}, {"set", "a", true}},
			want: gh.PresenceForeground, changes: []string{"none>background", "background>foreground"}, setOK: true},
		{name: "shown then hidden", ops: []op{{"join", "a", true}, {"set", "a", false}},
			want: gh.PresenceBackground, changes: []string{"none>foreground", "foreground>background"}, setOK: true},
		{name: "same visibility again: no change", ops: []op{{"join", "a", true}, {"set", "a", true}},
			want: gh.PresenceForeground, changes: []string{"none>foreground"}, setOK: true},
		{name: "two clients, one hidden: foreground", ops: []op{{"join", "a", true}, {"join", "b", false}},
			want: gh.PresenceForeground, changes: []string{"none>foreground"}},
		{name: "two clients, the visible one hides", ops: []op{{"join", "a", true}, {"join", "b", false}, {"set", "a", false}},
			want: gh.PresenceBackground, changes: []string{"none>foreground", "foreground>background"}, setOK: true},
		{name: "two clients, the visible one leaves", ops: []op{{"join", "a", true}, {"join", "b", false}, {"leave", "a", false}},
			want: gh.PresenceBackground, changes: []string{"none>foreground", "foreground>background"}},
		{name: "last one leaves", ops: []op{{"join", "a", false}, {"leave", "a", false}},
			want: gh.PresenceNone, changes: []string{"none>background", "background>none"}},
		{name: "unknown id", ops: []op{{"join", "a", false}, {"set", "zz", true}},
			want: gh.PresenceBackground, changes: []string{"none>background"}, setOK: false},
		{name: "after leave the id is unknown", ops: []op{{"join", "a", false}, {"leave", "a", false}, {"set", "a", true}},
			want: gh.PresenceNone, changes: []string{"none>background", "background>none"}, setOK: false},
		{name: "a stream without an id counts", ops: []op{{"join", "", true}},
			want: gh.PresenceForeground, changes: []string{"none>foreground"}},
		{name: "an empty id cannot be set", ops: []op{{"join", "", false}, {"set", "", true}},
			want: gh.PresenceBackground, changes: []string{"none>background"}, setOK: false},
		{name: "a reused id replaces; the first's leave keeps the second", ops: []op{{"join", "a", false}, {"join", "a", true}, {"leave", "a", false}},
			want: gh.PresenceForeground, changes: []string{"none>background", "background>foreground"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			log := &changeLog{}
			c := NewClients(log.record)
			leaves := map[string][]func(){}
			setOK := false
			for _, o := range tt.ops {
				switch o.do {
				case "join":
					leaves[o.id] = append(leaves[o.id], c.Join(o.id, o.visible))
				case "leave":
					leaves[o.id][0]()
					leaves[o.id] = leaves[o.id][1:]
				case "set":
					setOK = c.SetVisible(o.id, o.visible)
				}
			}
			if got := c.Presence(); got != tt.want {
				t.Errorf("presence = %v, want %v", got, tt.want)
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

// Watch registers GUI streams (not CLI or unspecified ones) until they end, and
// SetClientState updates the visibility of an open one.
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
	set := func(id string, visible bool) error {
		_, err := f.client.SetClientState(ctx, connect.NewRequest(&v1.SetClientStateRequest{ClientId: id, Visible: visible}))
		return err
	}

	_, stopCLI := open(&v1.WatchEventsRequest{ClientKind: v1.ClientKind_CLIENT_KIND_CLI, ClientId: "cli", Visible: true})
	_, stopAny := open(&v1.WatchEventsRequest{ClientId: "unspecified", Visible: true})
	if p := f.clients.Presence(); p != gh.PresenceNone {
		t.Fatalf("presence with CLI streams only = %v, want none", p)
	}
	if err := set("cli", false); connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("SetClientState for a CLI stream: %v, want NotFound", err)
	}
	stopCLI()
	stopAny()

	_, stopA := open(&v1.WatchEventsRequest{ClientKind: v1.ClientKind_CLIENT_KIND_GUI, ClientId: "a", Visible: false})
	if p := f.clients.Presence(); p != gh.PresenceBackground {
		t.Fatalf("presence = %v, want background", p)
	}
	if err := set("a", true); err != nil {
		t.Fatal(err)
	}
	_, stopB := open(&v1.WatchEventsRequest{ClientKind: v1.ClientKind_CLIENT_KIND_GUI, ClientId: "b", Visible: false})
	if p := f.clients.Presence(); p != gh.PresenceForeground {
		t.Fatalf("presence = %v, want foreground", p)
	}
	stopA()
	eventually(t, "a's stream to leave", func() bool { return f.clients.Presence() == gh.PresenceBackground })
	if err := set("a", true); connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("SetClientState after the stream ended: %v, want NotFound", err)
	}
	if err := set("", true); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("SetClientState without an id: %v, want InvalidArgument", err)
	}
	stopB()
	eventually(t, "b's stream to leave", func() bool { return f.clients.Presence() == gh.PresenceNone })
	want := []string{"none>background", "background>foreground", "foreground>background", "background>none"}
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
