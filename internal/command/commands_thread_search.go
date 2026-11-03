package command

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"text/tabwriter"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// SearchBackend backs thread.search.
type SearchBackend interface {
	Search(context.Context, *connect.Request[v1.SearchThreadsRequest]) (*connect.Response[v1.SearchThreadsResponse], error)
}

// SearchIncludes are thread.search's --include values.
var SearchIncludes = []string{"children", "subagents", "owned"}

var searchIncludes = map[string]v1.SearchInclude{
	"children":  v1.SearchInclude_SEARCH_INCLUDE_CHILDREN,
	"subagents": v1.SearchInclude_SEARCH_INCLUDE_SUBAGENTS,
	"owned":     v1.SearchInclude_SEARCH_INCLUDE_OWNED,
}

// searchSpeakerWords are the speakers as thread.read names them.
var searchSpeakerWords = map[v1.SearchSpeaker]string{
	v1.SearchSpeaker_SEARCH_SPEAKER_USER:      "you",
	v1.SearchSpeaker_SEARCH_SPEAKER_ASSISTANT: "claude",
	v1.SearchSpeaker_SEARCH_SPEAKER_QUESTION:  "question",
}

// threadSearch is thread.search: threads by name and messages by their text
// (docs/notes/search-3-index.md).
func threadSearch(b SearchBackend) Command {
	return Command{
		Name:      "thread.search",
		NoPalette: true,
		ReadOnly:  true,
		Title:     "Search Threads",
		Description: "Find threads by name and messages by their text (the user's, Claude's replies, questions and answers; " +
			"not tool calls) in the threads the sidebar shows, archived too. All words must occur (\"a phrase\" is one); a " +
			"capital makes it case-sensitive; words under 3 characters match names only. Hits print as `#<ordinal> <speaker> " +
			"<age> <snippet>` by thread: thread.read --since reads around one.",
		Category:     "Thread",
		NoKeybinding: true,
		Args: []ArgSpec{
			{Name: "query", Type: String, Required: true, Positional: true, Rest: true, Description: "The words to find"},
			{Name: "include", Type: String, Description: "Also: children (hidden child threads), subagents, owned (plugins' threads); comma-separated"},
			{Name: "all", Type: Bool, Description: "Include all three"},
			{Name: "project", Type: String, Description: "Only threads in these projects (comma-separated)"},
			{Name: "limit", Type: Int, Default: "50", Description: "Most hits (and names) shown, up to 500"},
			{Name: "per-thread", Type: Int, Default: "5", Description: "Most hits shown per thread"},
		},
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			if a.Int("limit") < 1 || a.Int("limit") > 500 {
				return Result{}, InvalidArg("limit", "limit must be 1 to 500, not %d", a.Int("limit"))
			}
			if a.Int("per-thread") < 1 {
				return Result{}, InvalidArg("per-thread", "per-thread must be 1 or more, not %d", a.Int("per-thread"))
			}
			if strings.TrimSpace(strings.ReplaceAll(a.String("query"), `"`, "")) == "" {
				return Result{}, InvalidArg("query", "query must have a word")
			}
			req := &v1.SearchThreadsRequest{Query: a.String("query"), ProjectIds: projectRefs(a.String("project")),
				Limit: int32(a.Int("limit")), PerThread: int32(a.Int("per-thread"))}
			names := splitList(a.String("include"))
			if a.Bool("all") {
				names = SearchIncludes
			}
			for _, n := range names {
				inc, ok := searchIncludes[n]
				if !ok {
					return Result{}, InvalidArg("include", "include takes %s, not %q", strings.Join(SearchIncludes, ", "), n)
				}
				if !slices.Contains(req.Include, inc) {
					req.Include = append(req.Include, inc)
				}
			}
			res, err := b.Search(ctx, connect.NewRequest(req))
			if err != nil {
				return Result{}, err
			}
			return Result{Message: FormatSearch(res.Msg, time.Now()), JSON: res.Msg}, nil
		},
	}
}

// FormatSearch renders thread.search: the matching thread names, then each thread's hits
// under a line naming it, and how to read around a hit.
func FormatSearch(res *v1.SearchThreadsResponse, now time.Time) string {
	var sb strings.Builder
	threadName := func(id, name string, archived bool) string {
		if name == "" {
			name = "(unnamed)"
		}
		if archived {
			name += " (archived)"
		}
		return id + "  " + name
	}
	if len(res.GetThreads()) > 0 {
		sb.WriteString("Thread names:\n")
		for _, t := range res.GetThreads() {
			fmt.Fprintf(&sb, "  %s\n", threadName(t.GetThreadId(), t.GetName(), t.GetArchived()))
		}
	}
	switch {
	case res.GetNamesOnly():
		if len(res.GetThreads()) == 0 {
			return "no thread names match (messages need a word of 3 characters or more)"
		}
		sb.WriteString("(messages need a word of 3 characters or more)")
		return sb.String()
	case len(res.GetGroups()) == 0:
		if len(res.GetThreads()) == 0 {
			return "no matches"
		}
		sb.WriteString("no messages match")
		return sb.String()
	}
	if sb.Len() > 0 {
		sb.WriteString("\n")
	}
	shown := 0
	for _, g := range res.GetGroups() {
		shown += len(g.GetHits())
	}
	fmt.Fprintf(&sb, "Messages: %d in %s", res.GetTotalHits(), plural(int(res.GetTotalThreads()), "thread"))
	if shown < int(res.GetTotalHits()) {
		fmt.Fprintf(&sb, " (%d shown)", shown)
	}
	if res.GetTruncated() {
		sb.WriteString("; more matched than a search reads, these are among the newest: narrow the query")
	}
	sb.WriteString("\n")
	for _, g := range res.GetGroups() {
		fmt.Fprintf(&sb, "\n%s  (%s)\n", threadName(g.GetThreadId(), g.GetThreadName(), g.GetArchived()), plural(int(g.GetTotalHits()), "hit"))
		tw := tabwriter.NewWriter(&sb, 0, 4, 2, ' ', 0)
		for _, h := range g.GetHits() {
			who := searchSpeakerWords[h.GetSpeaker()]
			if h.GetParentToolUseId() != "" {
				who = "subagent " + who
			}
			// The snippet whole: the daemon cut it around its matches already.
			fmt.Fprintf(tw, "  #%d\t%s\t%s\t%s\n", h.GetOrdinal(), who, age(h.GetCreatedAt().AsTime(), now), h.GetSnippet())
		}
		_ = tw.Flush()
	}
	sb.WriteString("\nRead around a hit: code-foundry thread read --id <thread> --since <#N-3> --last 6")
	return sb.String()
}
