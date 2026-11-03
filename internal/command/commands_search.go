package command

import (
	"context"
	"fmt"
	"strings"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
)

// search.* (docs/notes/search-5-agent-daemon.md): the search dialog's history and its
// Agent mode. search.report is the hidden run's own verb; the rest are the GUI's and the
// CLI's. Only search.clear is in the palette: the others take a question or an opaque id,
// and the dialog offers them on its rows.

// SearchServiceBackend is the slice of SearchService the search.* commands need, in
// generated Connect signatures (see TerminalBackend for why).
type SearchServiceBackend interface {
	StartAgent(context.Context, *connect.Request[v1.StartAgentSearchRequest]) (*connect.Response[v1.StartAgentSearchResponse], error)
	Stop(context.Context, *connect.Request[v1.StopSearchRequest]) (*connect.Response[v1.StopSearchResponse], error)
	ListRecent(context.Context, *connect.Request[v1.ListRecentSearchesRequest]) (*connect.Response[v1.ListRecentSearchesResponse], error)
	Get(context.Context, *connect.Request[v1.GetSearchRequest]) (*connect.Response[v1.GetSearchResponse], error)
	OpenHit(context.Context, *connect.Request[v1.OpenSearchHitRequest]) (*connect.Response[v1.OpenSearchHitResponse], error)
	MarkSeen(context.Context, *connect.Request[v1.MarkSearchSeenRequest]) (*connect.Response[v1.MarkSearchSeenResponse], error)
	RecordFind(context.Context, *connect.Request[v1.RecordFindSearchRequest]) (*connect.Response[v1.RecordFindSearchResponse], error)
	Forget(context.Context, *connect.Request[v1.ForgetSearchRequest]) (*connect.Response[v1.ForgetSearchResponse], error)
	Clear(context.Context, *connect.Request[v1.ClearSearchesRequest]) (*connect.Response[v1.ClearSearchesResponse], error)
	Promote(context.Context, *connect.Request[v1.PromoteSearchRequest]) (*connect.Response[v1.PromoteSearchResponse], error)
	Report(context.Context, *connect.Request[v1.ReportSearchHitRequest]) (*connect.Response[v1.ReportSearchHitResponse], error)
}

var (
	_ SearchServiceBackend = codefoundryv1connect.SearchServiceHandler(nil)
	_ SearchServiceBackend = codefoundryv1connect.SearchServiceClient(nil)
)

// SearchDeps are the search.* commands' dependencies. Nil Search makes them fail with
// Unimplemented.
type SearchDeps struct {
	Search SearchServiceBackend
	// Wait blocks until a search has ended (search.agent waits for its answer); nil:
	// search.agent returns the running search.
	Wait func(ctx context.Context, id string) (*v1.SearchEntry, error)
}

const searchCategory = "Search"

// RegisterSearch registers the search.* commands.
func RegisterSearch(r *Registry, d SearchDeps) error {
	b := d.Search
	if b == nil {
		b = codefoundryv1connect.UnimplementedSearchServiceHandler{}
	}
	idArg := ArgSpec{Name: "id", Type: String, Required: true, Positional: true, Description: "The search's id (q-…; search.recent lists them)"}
	entryResult := func(e *v1.SearchEntry) Result {
		return Result{Message: FormatSearchEntry(e, time.Now()), JSON: e}
	}
	return r.RegisterAll(
		Command{
			Name:      "search.agent",
			NoPalette: true,
			Title:     "Agent Search",
			Description: "Ask a question about your earlier threads in your own words: a hidden run on the utility model searches them " +
				"and reports the messages that answer it, each verified by a quote, with a short answer. Runs up to 2 minutes; " +
				"`search promote` continues it as a thread.",
			Category:     searchCategory,
			NoKeybinding: true,
			Args:         []ArgSpec{{Name: "question", Type: String, Required: true, Positional: true, Rest: true, Description: "The question"}},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := b.StartAgent(ctx, connect.NewRequest(&v1.StartAgentSearchRequest{Question: a.String("question")}))
				if err != nil {
					return Result{}, err
				}
				e := res.Msg.GetEntry()
				if d.Wait == nil {
					return entryResult(e), nil
				}
				done, err := d.Wait(ctx, e.GetId())
				if err != nil {
					return Result{}, err
				}
				return entryResult(done), nil
			},
		},
		Command{
			Name:         "search.stop",
			NoPalette:    true,
			Title:        "Stop Agent Search",
			Description:  "Stop a running agent search; it keeps the hits it reported.",
			Category:     searchCategory,
			NoKeybinding: true,
			Args:         []ArgSpec{idArg},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := b.Stop(ctx, connect.NewRequest(&v1.StopSearchRequest{Id: a.String("id")}))
				if err != nil {
					return Result{}, err
				}
				return entryResult(res.Msg.GetEntry()), nil
			},
		},
		Command{
			Name:         "search.recent",
			NoPalette:    true,
			ReadOnly:     true,
			Title:        "Recent Searches",
			Description:  "List the search history, newest first: agent searches and the Find searches whose results you opened (the last 50).",
			Category:     searchCategory,
			NoKeybinding: true,
			Run: func(ctx context.Context, _ Context, _ Args) (Result, error) {
				res, err := b.ListRecent(ctx, connect.NewRequest(&v1.ListRecentSearchesRequest{}))
				if err != nil {
					return Result{}, err
				}
				return Result{Message: FormatSearchHistory(res.Msg.GetEntries(), time.Now()), JSON: res.Msg}, nil
			},
		},
		Command{
			Name:         "search.get",
			NoPalette:    true,
			ReadOnly:     true,
			Title:        "Show Search",
			Description:  "Show one search of the history: an agent search's steps, verified hits and answer.",
			Category:     searchCategory,
			NoKeybinding: true,
			Args:         []ArgSpec{idArg},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := b.Get(ctx, connect.NewRequest(&v1.GetSearchRequest{Id: a.String("id")}))
				if err != nil {
					return Result{}, err
				}
				return entryResult(res.Msg.GetEntry()), nil
			},
		},
		Command{
			Name:         "search.open-hit",
			NoPalette:    true,
			Title:        "Mark Search Hit Opened",
			Description:  "Mark an agent search's hit opened (the search dialog does when you follow its link).",
			Category:     searchCategory,
			NoKeybinding: true,
			Args:         []ArgSpec{idArg, {Name: "hit", Type: Int, Required: true, Description: "The hit's number ([n])"}},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := b.OpenHit(ctx, connect.NewRequest(&v1.OpenSearchHitRequest{Id: a.String("id"), N: int32(a.Int("hit"))}))
				if err != nil {
					return Result{}, err
				}
				return Result{Message: fmt.Sprintf("hit [%d] of %s opened", a.Int("hit"), a.String("id")), JSON: res.Msg.GetEntry()}, nil
			},
		},
		Command{
			Name:         "search.seen",
			NoPalette:    true,
			Title:        "Mark Search Seen",
			Description:  "Mark a finished agent search's result seen (the search dialog does when it shows it).",
			Category:     searchCategory,
			NoKeybinding: true,
			Args:         []ArgSpec{idArg},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := b.MarkSeen(ctx, connect.NewRequest(&v1.MarkSearchSeenRequest{Id: a.String("id")}))
				if err != nil {
					return Result{}, err
				}
				return Result{Message: a.String("id") + " seen", JSON: res.Msg.GetEntry()}, nil
			},
		},
		Command{
			Name:         "search.find",
			NoPalette:    true,
			Title:        "Record Find Search",
			Description:  "Record a Find search in the history (the search dialog does when you open one of its results); the same query again moves it to the top.",
			Category:     searchCategory,
			NoKeybinding: true,
			Args:         []ArgSpec{{Name: "query", Type: String, Required: true, Positional: true, Rest: true, Description: "The query"}},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := b.RecordFind(ctx, connect.NewRequest(&v1.RecordFindSearchRequest{Query: a.String("query")}))
				if err != nil {
					return Result{}, err
				}
				return Result{Message: "recorded " + res.Msg.GetEntry().GetId(), JSON: res.Msg.GetEntry()}, nil
			},
		},
		Command{
			Name:         "search.forget",
			NoPalette:    true,
			Title:        "Forget Search",
			Description:  "Remove a search from the history; an agent search is stopped first and its run's transcript deleted.",
			Category:     searchCategory,
			NoKeybinding: true,
			Args:         []ArgSpec{idArg},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				if _, err := b.Forget(ctx, connect.NewRequest(&v1.ForgetSearchRequest{Id: a.String("id")})); err != nil {
					return Result{}, err
				}
				return Result{Message: "forgot " + a.String("id")}, nil
			},
		},
		Command{
			Name:         "search.clear",
			Title:        "Clear Search History",
			Description:  "Forget every search of the history; running agent searches are stopped and their transcripts deleted.",
			Category:     searchCategory,
			NoKeybinding: true,
			Confirm:      "Clear the search history? Every agent search's transcript is deleted too.",
			ConfirmLabel: "Clear history",
			Run: func(ctx context.Context, _ Context, _ Args) (Result, error) {
				res, err := b.Clear(ctx, connect.NewRequest(&v1.ClearSearchesRequest{}))
				if err != nil {
					return Result{}, err
				}
				return Result{Message: "forgot " + searchesWord(int(res.Msg.GetRemoved())), JSON: res.Msg}, nil
			},
		},
		Command{
			Name:      "search.promote",
			NoPalette: true,
			Title:     "Continue Search as Thread",
			Description: "Continue a finished agent search as a thread without a project: it keeps everything the search read, " +
				"runs on your default model with full tools, and starts with the question and the hits.",
			Category:     searchCategory,
			NoKeybinding: true,
			Args:         []ArgSpec{idArg},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := b.Promote(ctx, connect.NewRequest(&v1.PromoteSearchRequest{Id: a.String("id")}))
				if err != nil {
					return Result{}, err
				}
				return Result{Message: "continued as thread " + res.Msg.GetThreadId(), JSON: res.Msg}, nil
			},
		},
		Command{
			Name:      "search.report",
			NoPalette: true,
			Title:     "Report Search Hit",
			Description: "Agent search's own verb: report a message that answers the question, with an exact quote from it. " +
				"Refused, with why, when the quote is not in that message.",
			Category:     searchCategory,
			NoKeybinding: true,
			Args: []ArgSpec{
				{Name: "search", Type: String, Required: true, Description: "The search's id"},
				{Name: "thread", Type: String, Required: true, Description: "The thread's id"},
				{Name: "item", Type: String, Required: true, Description: "The message: #N as thread search and thread read print it, or its item id"},
				{Name: "quote", Type: String, Required: true, Description: "Words copied exactly from the message (10 to 300 characters)"},
				{Name: "why", Type: String, Required: true, Description: "One short line: why it answers the question"},
			},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := b.Report(ctx, connect.NewRequest(&v1.ReportSearchHitRequest{SearchId: a.String("search"), ThreadId: a.String("thread"),
					Item: a.String("item"), Quote: a.String("quote"), Why: a.String("why")}))
				if err != nil {
					return Result{}, err
				}
				h := res.Msg.GetHit()
				msg := fmt.Sprintf("hit [%d] accepted: #%d of %s", h.GetN(), h.GetOrdinal(), cmpName(h.GetThreadName(), h.GetThreadId()))
				if res.Msg.GetLeft() == 0 {
					msg += "; that was the last one a search keeps: write your answer now"
				} else {
					msg += fmt.Sprintf("; %d more allowed", res.Msg.GetLeft())
				}
				return Result{Message: msg, JSON: res.Msg}, nil
			},
		},
	)
}

// searchesWord is "1 search", "3 searches".
func searchesWord(n int) string {
	if n == 1 {
		return "1 search"
	}
	return fmt.Sprintf("%d searches", n)
}

func cmpName(name, id string) string {
	if name == "" {
		return id
	}
	return fmt.Sprintf("%q (%s)", name, id)
}

var searchStatusWords = map[v1.SearchStatus]string{
	v1.SearchStatus_SEARCH_STATUS_RUNNING: "running",
	v1.SearchStatus_SEARCH_STATUS_DONE:    "done",
	v1.SearchStatus_SEARCH_STATUS_FAILED:  "failed",
	v1.SearchStatus_SEARCH_STATUS_STOPPED: "stopped",
}

// FormatSearchHistory renders search.recent: one line per entry.
func FormatSearchHistory(list []*v1.SearchEntry, now time.Time) string {
	if len(list) == 0 {
		return "no searches"
	}
	var b strings.Builder
	for _, e := range list {
		if e.GetMode() == v1.SearchMode_SEARCH_MODE_FIND {
			fmt.Fprintf(&b, "%s  find    %-8s  %s\n", e.GetId(), age(e.GetCreatedAt().AsTime(), now), e.GetQuery())
			continue
		}
		status := searchStatusWords[e.GetStatus()]
		if e.GetUnseen() {
			status += "*"
		}
		fmt.Fprintf(&b, "%s  agent   %-8s  %s (%s, %s)\n", e.GetId(), age(e.GetCreatedAt().AsTime(), now), e.GetQuery(), status, plural(len(e.GetHits()), "hit"))
	}
	return strings.TrimRight(b.String(), "\n")
}

// FormatSearchEntry renders one search: an agent search's summary line, hits and answer.
func FormatSearchEntry(e *v1.SearchEntry, now time.Time) string {
	if e.GetMode() == v1.SearchMode_SEARCH_MODE_FIND {
		return fmt.Sprintf("%s  find  %s  %s", e.GetId(), age(e.GetCreatedAt().AsTime(), now), e.GetQuery())
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%s  %s", e.GetId(), searchStatusWords[e.GetStatus()])
	if e.GetDurationMs() > 0 {
		fmt.Fprintf(&b, " in %s", (time.Duration(e.GetDurationMs()) * time.Millisecond).Round(time.Second))
	}
	fmt.Fprintf(&b, " · %s, read %s", searchesWord(int(e.GetSearches())), plural(int(e.GetThreadsRead()), "thread"))
	if e.GetCostUsd() > 0 {
		fmt.Fprintf(&b, " · $%.4f", e.GetCostUsd())
	}
	if e.GetError() != "" {
		b.WriteString(" · " + e.GetError())
	}
	b.WriteString("\n")
	for _, h := range e.GetHits() {
		b.WriteString(FormatSearchHit(h) + "\n")
	}
	if len(e.GetHits()) == 0 && e.GetStatus() != v1.SearchStatus_SEARCH_STATUS_RUNNING {
		b.WriteString("no verified hits\n")
	}
	if a := e.GetAnswer(); a != "" {
		b.WriteString("\n" + a + "\n")
	}
	if e.GetPromotedThreadId() != "" {
		b.WriteString("\ncontinued as thread " + e.GetPromotedThreadId())
	} else if e.GetStatus() != v1.SearchStatus_SEARCH_STATUS_RUNNING && e.GetClaudeSessionId() != "" {
		b.WriteString("\nContinue it as a thread: code-foundry search promote " + e.GetId())
	}
	return strings.TrimRight(b.String(), "\n")
}

// FormatSearchHit renders one verified hit: `[n] <thread> #N (<id>): "<quote>" — <why>`.
func FormatSearchHit(h *v1.AgentSearchHit) string {
	name := h.GetThreadName()
	if name == "" {
		name = "(unnamed)"
	}
	return fmt.Sprintf("[%d] %s #%d (%s): %q — %s", h.GetN(), name, h.GetOrdinal(), h.GetThreadId(), h.GetQuote(), h.GetWhy())
}
