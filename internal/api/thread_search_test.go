package api

import (
	"context"
	"slices"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/internal/store/thread/threadtest"
)

// Search maps the includes to the store's flags and the store's result to the API; an
// empty query is INVALID_ARGUMENT.
func TestSearch(t *testing.T) {
	b := bus.New()
	fake := threadtest.New(b)
	at := time.UnixMilli(1_800_000_000_000)
	one := thread.Thread{ID: "s-1", Name: "Fix login", LastActivityAt: at, ArchivedAt: at}
	fake.SetSearch(thread.SearchResult{CaseSensitive: true, TotalHits: 7, TotalThreads: 2, Truncated: true,
		Threads: []thread.ThreadNameMatch{{Thread: one, Ranges: []thread.MatchRange{{Start: 4, End: 9}}}},
		Groups: []thread.SearchGroup{{Thread: one, TotalHits: 6, Hits: []thread.SearchHit{{ThreadID: "s-1", ItemID: "u1", Ordinal: 3,
			Kind: thread.KindQuestion, Speaker: thread.SpeakerQuestion, ParentToolUseID: "toolu_1", CreatedAt: at, Snippet: "…the login",
			Ranges: []thread.MatchRange{{Start: 5, End: 10}}}}}}})
	h := NewThread(fake, b)
	ctx := context.Background()
	res, err := h.Search(ctx, connect.NewRequest(&v1.SearchThreadsRequest{Query: "login",
		Include:    []v1.SearchInclude{v1.SearchInclude_SEARCH_INCLUDE_CHILDREN, v1.SearchInclude_SEARCH_INCLUDE_OWNED, v1.SearchInclude_SEARCH_INCLUDE_UNSPECIFIED},
		ProjectIds: []string{"api"}, Limit: 20, PerThread: 2}))
	if err != nil {
		t.Fatal(err)
	}
	if calls := fake.Calls(); !slices.Equal(calls, []string{"Search login children owned projects=api limit=20 per=2"}) {
		t.Errorf("calls %q", calls)
	}
	m := res.Msg
	if !m.GetCaseSensitive() || m.GetNamesOnly() || m.GetTotalHits() != 7 || m.GetTotalThreads() != 2 || !m.GetTruncated() {
		t.Errorf("response flags %v", m)
	}
	if n := m.GetThreads(); len(n) != 1 || n[0].GetThreadId() != "s-1" || n[0].GetName() != "Fix login" || !n[0].GetArchived() ||
		n[0].GetRanges()[0].GetStart() != 4 || n[0].GetRanges()[0].GetEnd() != 9 || !n[0].GetLastActivityAt().AsTime().Equal(at) {
		t.Errorf("threads %v", n)
	}
	g := m.GetGroups()
	if len(g) != 1 || g[0].GetThreadId() != "s-1" || g[0].GetThreadName() != "Fix login" || !g[0].GetArchived() || g[0].GetTotalHits() != 6 {
		t.Fatalf("groups %v", g)
	}
	hit := g[0].GetHits()[0]
	if hit.GetItemId() != "u1" || hit.GetOrdinal() != 3 || hit.GetSpeaker() != v1.SearchSpeaker_SEARCH_SPEAKER_QUESTION || hit.GetSnippet() != "…the login" ||
		hit.GetRanges()[0].GetStart() != 5 || hit.GetParentToolUseId() != "toolu_1" || !hit.GetCreatedAt().AsTime().Equal(at) {
		t.Errorf("hit %v", hit)
	}
	if _, err := h.Search(ctx, connect.NewRequest(&v1.SearchThreadsRequest{Query: " "})); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("empty query: err %v, want INVALID_ARGUMENT", err)
	}
}
