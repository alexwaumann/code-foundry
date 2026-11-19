package api

import (
	"context"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/page"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// pageSource is EventService's page source (docs/notes/page-access-live.md): which pages
// to read again, never their answer. The page store publishes page.Changed for a new owner
// or answer; a removed thread's pages lose their owner in the removal's own transaction
// (ON DELETE CASCADE), which the page store does not see, so thread.Removed is carried as
// PageEvent.removed_thread. Its snapshot asks for every page again: a client that missed
// events, or just connected, cannot know which changed.
type pageSource struct {
	bus *bus.Bus
}

func (pageSource) kind() v1.EventSource { return v1.EventSource_EVENT_SOURCE_PAGE }

func pageWrap(e *v1.PageEvent) *v1.Event { return &v1.Event{Event: &v1.Event_Page{Page: e}} }

func (s pageSource) topics() []topic {
	return []topic{
		busTopic(s.bus, watchBuffer, func(ev page.Changed) *v1.Event { return pageWrap(&v1.PageEvent{Paths: []string{ev.Path}}) }),
		busTopic(s.bus, watchBuffer, func(ev thread.Event) *v1.Event {
			if r, ok := ev.(thread.Removed); ok {
				return pageWrap(&v1.PageEvent{RemovedThread: r.ID})
			}
			return nil
		}),
	}
}

func (pageSource) snapshot(context.Context) []*v1.Event {
	return []*v1.Event{pageWrap(&v1.PageEvent{All: true})}
}
