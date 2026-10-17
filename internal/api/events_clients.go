package api

import (
	"context"
	"errors"
	"sync"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
)

// Clients is the registry of GUI clients holding an EventService.Watch stream, with
// whether each one's window is visible. Its presence paces the GitHub poll
// (gh.Options.Presence); nothing about it is stored. CLI and unspecified clients are
// not counted.
type Clients struct {
	mu       sync.Mutex
	byID     map[string]*guiClient
	anon     map[*guiClient]bool // GUI streams without a client_id
	onChange func(from, to gh.Presence)
}

type guiClient struct{ visible bool }

// NewClients returns an empty registry. onChange (may be nil) is called after each
// change of Presence with the registry locked, so calls arrive in order: it must not
// call back into the registry.
func NewClients(onChange func(from, to gh.Presence)) *Clients {
	return &Clients{byID: map[string]*guiClient{}, anon: map[*guiClient]bool{}, onChange: onChange}
}

// Presence is foreground when any GUI client is visible, background when GUI clients
// are connected but all are hidden, none without GUI clients.
func (c *Clients) Presence() gh.Presence {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.presenceLocked()
}

func (c *Clients) presenceLocked() gh.Presence {
	if len(c.byID)+len(c.anon) == 0 {
		return gh.PresenceNone
	}
	for _, g := range c.byID {
		if g.visible {
			return gh.PresenceForeground
		}
	}
	for g := range c.anon {
		if g.visible {
			return gh.PresenceForeground
		}
	}
	return gh.PresenceBackground
}

// change runs fn with the registry locked and reports the presence change it caused.
func (c *Clients) change(fn func()) {
	c.mu.Lock()
	defer c.mu.Unlock()
	from := c.presenceLocked()
	fn()
	if to := c.presenceLocked(); to != from && c.onChange != nil {
		c.onChange(from, to)
	}
}

// Join registers a GUI stream and returns the function that removes it. A second
// stream with the same id replaces the first (ids are per stream, so only a broken
// client reuses one); the first's leave then leaves the second alone.
func (c *Clients) Join(id string, visible bool) (leave func()) {
	g := &guiClient{visible: visible}
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

// SetVisible updates a joined client's visibility. It reports false when no open
// stream has that id.
func (c *Clients) SetVisible(id string, visible bool) bool {
	ok := false
	c.change(func() {
		if g := c.byID[id]; g != nil && id != "" {
			g.visible, ok = visible, true
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
	return h.deps.Clients.Join(req.GetClientId(), req.GetVisible())
}

// SetClientState implements codefoundryv1connect.EventServiceHandler.
func (h *Events) SetClientState(_ context.Context, req *connect.Request[v1.SetClientStateRequest]) (*connect.Response[v1.SetClientStateResponse], error) {
	id := req.Msg.GetClientId()
	if id == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("client_id is required"))
	}
	if h.deps.Clients == nil || !h.deps.Clients.SetVisible(id, req.Msg.GetVisible()) {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("no open Watch stream has this client_id"))
	}
	return connect.NewResponse(&v1.SetClientStateResponse{}), nil
}
