package api

import (
	"context"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/search"
)

// SearchActivitySource is what EventService's search source reads (*search.Store).
type SearchActivitySource interface {
	Activity() search.Activity
}

var _ SearchActivitySource = (*search.Store)(nil)

// searchSource is EventService's search source: the sidebar row's SearchActivity, on
// connect and per change (docs/notes/search-sidebar-row.md). It rides the one event
// stream: the GUI has five stream slots, and the row is on screen all session.
type searchSource struct {
	store SearchActivitySource
	bus   *bus.Bus
}

func (searchSource) kind() v1.EventSource { return v1.EventSource_EVENT_SOURCE_SEARCH }

func (s searchSource) topics() []topic {
	return []topic{busTopic(s.bus, watchBuffer, func(a search.Activity) *v1.Event {
		return &v1.Event{Event: &v1.Event_Search{Search: searchActivityToProto(a)}}
	})}
}

func (s searchSource) snapshot(context.Context) []*v1.Event {
	return []*v1.Event{{Event: &v1.Event_Search{Search: searchActivityToProto(s.store.Activity())}}}
}

func searchActivityToProto(a search.Activity) *v1.SearchActivity {
	return &v1.SearchActivity{
		Running: int32(a.Running), RunningId: a.RunningID,
		UnseenId: a.UnseenID, UnseenStatus: searchStatuses[a.UnseenStatus], UnseenHits: int32(a.UnseenHits),
	}
}
