package api

import (
	"context"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// searchIncludes sets the store's scope flag for each SearchInclude.
var searchIncludes = map[v1.SearchInclude]func(*thread.SearchQuery){
	v1.SearchInclude_SEARCH_INCLUDE_CHILDREN:  func(q *thread.SearchQuery) { q.Children = true },
	v1.SearchInclude_SEARCH_INCLUDE_SUBAGENTS: func(q *thread.SearchQuery) { q.Subagents = true },
	v1.SearchInclude_SEARCH_INCLUDE_OWNED:     func(q *thread.SearchQuery) { q.Owned = true },
}

// searchSpeakers maps the store's speakers to the API's.
var searchSpeakers = map[thread.Speaker]v1.SearchSpeaker{
	thread.SpeakerUser:      v1.SearchSpeaker_SEARCH_SPEAKER_USER,
	thread.SpeakerAssistant: v1.SearchSpeaker_SEARCH_SPEAKER_ASSISTANT,
	thread.SpeakerQuestion:  v1.SearchSpeaker_SEARCH_SPEAKER_QUESTION,
}

// Search finds threads by name and items by their visible text (docs/notes/search-3-index.md).
func (h *Thread) Search(ctx context.Context, req *connect.Request[v1.SearchThreadsRequest]) (*connect.Response[v1.SearchThreadsResponse], error) {
	m := req.Msg
	q := thread.SearchQuery{Query: m.GetQuery(), ProjectIDs: m.GetProjectIds(), Limit: int(m.GetLimit()), PerThread: int(m.GetPerThread())}
	for _, inc := range m.GetInclude() {
		if set, ok := searchIncludes[inc]; ok {
			set(&q)
		}
	}
	res, err := h.store.Search(ctx, q)
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(searchResponse(res)), nil
}

// searchResponse is res on the API.
func searchResponse(res thread.SearchResult) *v1.SearchThreadsResponse {
	out := &v1.SearchThreadsResponse{CaseSensitive: res.CaseSensitive, NamesOnly: res.NamesOnly, TotalHits: int32(res.TotalHits),
		TotalThreads: int32(res.TotalThreads), Truncated: res.Truncated,
		Threads: make([]*v1.SearchThreadName, 0, len(res.Threads)), Groups: make([]*v1.SearchThreadGroup, 0, len(res.Groups))}
	for _, n := range res.Threads {
		out.Threads = append(out.Threads, &v1.SearchThreadName{ThreadId: n.Thread.ID, Name: n.Thread.Name, Ranges: matchRanges(n.Ranges),
			Archived: !n.Thread.ArchivedAt.IsZero(), LastActivityAt: timestamppb.New(n.Thread.LastActivityAt)})
	}
	for _, g := range res.Groups {
		pg := &v1.SearchThreadGroup{ThreadId: g.Thread.ID, ThreadName: g.Thread.Name, Archived: !g.Thread.ArchivedAt.IsZero(),
			TotalHits: int32(g.TotalHits), Hits: make([]*v1.SearchHit, 0, len(g.Hits))}
		for _, h := range g.Hits {
			pg.Hits = append(pg.Hits, &v1.SearchHit{ThreadId: h.ThreadID, ItemId: h.ItemID, Ordinal: h.Ordinal, Speaker: searchSpeakers[h.Speaker],
				CreatedAt: timestamppb.New(h.CreatedAt), Snippet: h.Snippet, Ranges: matchRanges(h.Ranges), ParentToolUseId: h.ParentToolUseID})
		}
		out.Groups = append(out.Groups, pg)
	}
	return out
}

func matchRanges(rs []thread.MatchRange) []*v1.SearchMatchRange {
	out := make([]*v1.SearchMatchRange, len(rs))
	for i, r := range rs {
		out[i] = &v1.SearchMatchRange{Start: int32(r.Start), End: int32(r.End)}
	}
	return out
}
