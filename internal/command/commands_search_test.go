package command_test

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// searchBackend answers StartAgent and Report, recording the report.
type searchBackend struct {
	codefoundryv1connect.UnimplementedSearchServiceHandler
	report *v1.ReportSearchHitRequest
	left   int32
}

func (b *searchBackend) StartAgent(_ context.Context, req *connect.Request[v1.StartAgentSearchRequest]) (*connect.Response[v1.StartAgentSearchResponse], error) {
	return connect.NewResponse(&v1.StartAgentSearchResponse{Entry: &v1.SearchEntry{Id: "q-1", Mode: v1.SearchMode_SEARCH_MODE_AGENT,
		Query: req.Msg.GetQuestion(), Status: v1.SearchStatus_SEARCH_STATUS_RUNNING}}), nil
}

func (b *searchBackend) Report(_ context.Context, req *connect.Request[v1.ReportSearchHitRequest]) (*connect.Response[v1.ReportSearchHitResponse], error) {
	b.report = req.Msg
	return connect.NewResponse(&v1.ReportSearchHitResponse{Left: b.left,
		Hit: &v1.AgentSearchHit{N: 2, ThreadId: req.Msg.GetThreadId(), ThreadName: "Poller design", Ordinal: 12}}), nil
}

func TestSearchCommands(t *testing.T) {
	b := &searchBackend{left: 3}
	r := command.NewRegistry()
	done := &v1.SearchEntry{Id: "q-1", Mode: v1.SearchMode_SEARCH_MODE_AGENT, Status: v1.SearchStatus_SEARCH_STATUS_DONE, DurationMs: 34_000,
		Searches: 3, ThreadsRead: 1, CostUsd: 0.0412, ClaudeSessionId: "sid", Answer: "It skips reruns [1].",
		Hits: []*v1.AgentSearchHit{{N: 1, ThreadId: "s-a", ThreadName: "Poller design", Ordinal: 12, Quote: "do not refetch", Why: "the decision"}}}
	if err := command.RegisterSearch(r, command.SearchDeps{Search: b, Wait: func(context.Context, string) (*v1.SearchEntry, error) { return done, nil }}); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	res, err := r.Invoke(ctx, command.Context{}, "search.agent", map[string]string{"question": "where?"})
	if err != nil {
		t.Fatal(err)
	}
	want := "q-1  done in 34s · 3 searches, read 1 thread · $0.0412\n" +
		"[1] Poller design #12 (s-a): \"do not refetch\" — the decision\n\n" +
		"It skips reruns [1].\n\n" +
		"Continue it as a thread: code-foundry search promote q-1"
	if res.Message != want {
		t.Errorf("search.agent:\n%s\nwant\n%s", res.Message, want)
	}
	for _, tt := range []struct {
		left int32
		msg  string
	}{
		{3, `hit [2] accepted: #12 of "Poller design" (s-b); 3 more allowed`},
		{0, `hit [2] accepted: #12 of "Poller design" (s-b); that was the last one a search keeps: write your answer now`},
	} {
		b.left = tt.left
		res, err = r.Invoke(ctx, command.Context{}, "search.report", map[string]string{"search": "q-1", "thread": "s-b", "item": "#12",
			"quote": "it's here", "why": "because"})
		if err != nil {
			t.Fatal(err)
		}
		if res.Message != tt.msg {
			t.Errorf("search.report = %q, want %q", res.Message, tt.msg)
		}
	}
	if b.report.GetItem() != "#12" || b.report.GetQuote() != "it's here" || b.report.GetSearchId() != "q-1" {
		t.Errorf("report request = %v", b.report)
	}
	if _, err := r.Invoke(ctx, command.Context{}, "search.report", map[string]string{"search": "q-1", "thread": "s-b", "item": "#12", "quote": "x"}); err == nil ||
		!strings.Contains(err.Error(), "why") {
		t.Errorf("report without --why = %v", err)
	}
}

// search.report's help names the quote lengths VerifyQuote enforces (and the run's
// prompt, which reads the constants).
func TestSearchReportQuoteRange(t *testing.T) {
	r := command.NewRegistry()
	if err := command.RegisterSearch(r, command.SearchDeps{}); err != nil {
		t.Fatal(err)
	}
	c, _ := r.Get("search.report")
	want := fmt.Sprintf("(%d to %d characters)", thread.MinQuoteRunes, thread.MaxQuoteRunes)
	for _, a := range c.Args {
		if a.Name == "quote" && !strings.Contains(a.Description, want) {
			t.Errorf("--quote help = %q, want %q", a.Description, want)
		}
	}
}
