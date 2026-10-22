package api

import (
	"context"
	"errors"
	"sync"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/presence"
)

// Clients is the registry of GUI clients holding an EventService.Watch stream, with
// whether each one's window is visible and focused. It is the one writer of the
// daemon's presence (internal/presence): its Kind paces the GitHub poll and its
// Attended decides whether an open thread view counts as the user seeing the thread
// (docs/notes/gh-poll-tiers.md, docs/notes/alerts-foreground.md). Nothing about it is
// stored. CLI and unspecified clients are not counted.
type Clients struct {
	mu      sync.Mutex
	byID    map[string]*guiClient
	anon    map[*guiClient]bool // GUI streams without a client_id
	tracker *presence.Tracker
}

type guiClient struct{ state presence.Client }

// NewClients returns an empty registry that writes tracker (a fresh one when nil).
// The tracker's subscribers are called after each change with the registry locked, so
// changes arrive in order: they must not call back into the registry.
func NewClients(tracker *presence.Tracker) *Clients {
	if tracker == nil {
		tracker = presence.New()
	}
	return &Clients{byID: map[string]*guiClient{}, anon: map[*guiClient]bool{}, tracker: tracker}
}

// Tracker is the presence this registry writes.
func (c *Clients) Tracker() *presence.Tracker { return c.tracker }

// Presence is the state the registry's clients make (presence.Of).
func (c *Clients) Presence() presence.State {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.presenceLocked()
}

// Windows is the number of GUI streams joined now: one per open window (ui.presence).
func (c *Clients) Windows() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.byID) + len(c.anon)
}

func (c *Clients) presenceLocked() presence.State {
	all := make([]presence.Client, 0, len(c.byID)+len(c.anon))
	for _, g := range c.byID {
		all = append(all, g.state)
	}
	for g := range c.anon {
		all = append(all, g.state)
	}
	return presence.Of(all)
}

// change runs fn with the registry locked and hands the resulting state to the tracker,
// which tells its subscribers when it changed.
func (c *Clients) change(fn func()) {
	c.mu.Lock()
	defer c.mu.Unlock()
	fn()
	c.tracker.Set(c.presenceLocked())
}

// Join registers a GUI stream and returns the function that removes it. A second
// stream with the same id replaces the first (ids are per stream, so only a broken
// client reuses one); the first's leave then leaves the second alone.
func (c *Clients) Join(id string, state presence.Client) (leave func()) {
	g := &guiClient{state: state}
	c.change(func() {
		if id == "" {
			c.anon[g] = true
		} else {
			c.byID[id] = g
		}
	})
	return func() {
		c.change(func() {
			if id == "" {
				delete(c.anon, g)
			} else if c.byID[id] == g {
				delete(c.byID, id)
			}
		})
	}
}

// SetState updates a joined client's window state. It reports false when no open
// stream has that id.
func (c *Clients) SetState(id string, state presence.Client) bool {
	ok := false
	c.change(func() {
		if g := c.byID[id]; g != nil && id != "" {
			g.state, ok = state, true
		}
	})
	return ok
}

// joinClient registers the stream's client when it is a GUI; the returned function
// removes it again.
func (h *Events) joinClient(req *v1.WatchEventsRequest) func() {
	if h.deps.Clients == nil || req.GetClientKind() != v1.ClientKind_CLIENT_KIND_GUI {
		return func() {}
	}
	return h.deps.Clients.Join(req.GetClientId(), presence.Client{Visible: req.GetVisible(), Focused: req.GetFocused()})
}

// SetClientState implements codefoundryv1connect.EventServiceHandler.
func (h *Events) SetClientState(_ context.Context, req *connect.Request[v1.SetClientStateRequest]) (*connect.Response[v1.SetClientStateResponse], error) {
	id := req.Msg.GetClientId()
	if id == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("client_id is required"))
	}
	state := presence.Client{Visible: req.Msg.GetVisible(), Focused: req.Msg.GetFocused()}
	if h.deps.Clients == nil || !h.deps.Clients.SetState(id, state) {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("no open Watch stream has this client_id"))
	}
	return connect.NewResponse(&v1.SetClientStateResponse{}), nil
}
