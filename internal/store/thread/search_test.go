package thread

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/project"
)

// search runs q and fails the test on an error.
func (e *env) search(q SearchQuery) SearchResult {
	e.t.Helper()
	res, err := e.m.Search(e.ctx(), q)
	if err != nil {
		e.t.Fatal(err)
	}
	return res
}

// hitsOf is a result's hits as "<thread name>:<item id>", group by group.
func hitsOf(res SearchResult) []string {
	var out []string
	for _, g := range res.Groups {
		for _, h := range g.Hits {
			out = append(out, g.Thread.Name+":"+h.ItemID)
		}
	}
	return out
}

// sortedHits is hitsOf sorted, for scope checks that do not test the order.
func sortedHits(res SearchResult) []string {
	out := hitsOf(res)
	sort.Strings(out)
	return out
}

// countDocs is how many search documents there are.
func (e *env) countDocs() int {
	e.t.Helper()
	var n int
	if err := e.m.opts.DB.QueryRowContext(e.ctx(), `SELECT COUNT(*) FROM search_docs`).Scan(&n); err != nil {
		e.t.Fatal(err)
	}
	return n
}

// docID is item id's search document, 0 when it has none.
func (e *env) docID(itemID string) int64 {
	e.t.Helper()
	var id int64
	err := e.m.opts.DB.QueryRowContext(e.ctx(), `SELECT id FROM search_docs WHERE item_id = ?`, itemID).Scan(&id)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		e.t.Fatal(err)
	}
	return id
}

// Default scope and the flags that widen it: hidden children, plugins' threads,
// subagents, a project filter; archived threads and shown orphans count; tool output and
// the like are never found.
func TestSearchScopes(t *testing.T) {
	e := newEnv(t)
	api := filepath.Join(t.TempDir(), "api")
	if err := os.MkdirAll(api, 0o755); err != nil {
		t.Fatal(err)
	}
	e.projects.Put(project.Project{ID: "r2", Path: api, Name: "api", Git: true, Worktrees: []project.Worktree{{ProjectID: "r2", Path: api, IsMain: true}}})
	top := e.connected(CreateOptions{Name: "Top"})
	archived := e.connected(CreateOptions{Name: "Archived"})
	child := e.connected(CreateOptions{Name: "Child", CreatedBy: top.ID})
	gone := e.connected(CreateOptions{Name: "Gone"})
	orphan := e.connected(CreateOptions{Name: "Orphan", CreatedBy: gone.ID})
	owned := e.connected(CreateOptions{Name: "Owned", Owner: "plugin:demo"})
	other := e.connected(CreateOptions{Name: "Other", ProjectID: "r2"})
	for _, s := range []Thread{top, archived, child, gone, orphan, owned, other} {
		e.putItems(s.ID, Item{ID: s.Name + "-u", Kind: KindUserMessage, Text: "the needle in " + s.Name})
	}
	e.putItems(top.ID,
		Item{ID: "top-sub", Kind: KindAssistantText, Text: "a subagent's needle", ParentToolUseID: "toolu_agent"},
		Item{ID: "top-tool", Kind: KindToolCall, Tool: &ToolCall{Name: "Bash", InputJSON: `{"command":"grep needle"}`, Status: ToolDone, Output: "needle"}},
		Item{ID: "top-think", Kind: KindThinking, Text: "needle"},
		Item{ID: "top-note", Kind: KindNote, Text: "needle"},
	)
	if _, err := e.m.Archive(e.ctx(), archived.ID, true); err != nil {
		t.Fatal(err)
	}
	// Removing a creator shows its child; the child is not removed with it here because
	// it was moved out of the cascade's reach first: its creator is another thread.
	if _, ok := e.m.update(orphan.ID, false, func(rec *record) { rec.s.CreatedBy = "s-removed-long-ago" }); !ok {
		t.Fatal("no orphan")
	}
	if err := e.m.Remove(e.ctx(), gone.ID); err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name string
		q    SearchQuery
		want []string
	}{
		{"the user's threads: top-level, archived, orphans", SearchQuery{Query: "needle"},
			[]string{"Archived:Archived-u", "Orphan:Orphan-u", "Other:Other-u", "Top:Top-u"}},
		{"hidden children", SearchQuery{Query: "needle", Children: true},
			[]string{"Archived:Archived-u", "Child:Child-u", "Orphan:Orphan-u", "Other:Other-u", "Top:Top-u"}},
		{"plugins' threads", SearchQuery{Query: "needle", Owned: true},
			[]string{"Archived:Archived-u", "Orphan:Orphan-u", "Other:Other-u", "Owned:Owned-u", "Top:Top-u"}},
		{"subagents", SearchQuery{Query: "needle", Subagents: true},
			[]string{"Archived:Archived-u", "Orphan:Orphan-u", "Other:Other-u", "Top:Top-u", "Top:top-sub"}},
		{"everything", SearchQuery{Query: "needle", Children: true, Owned: true, Subagents: true},
			[]string{"Archived:Archived-u", "Child:Child-u", "Orphan:Orphan-u", "Other:Other-u", "Owned:Owned-u", "Top:Top-u", "Top:top-sub"}},
		{"a project by name", SearchQuery{Query: "needle", ProjectIDs: []string{"api"}}, []string{"Other:Other-u"}},
		{"a project by id", SearchQuery{Query: "needle", ProjectIDs: []string{"r1"}},
			[]string{"Archived:Archived-u", "Orphan:Orphan-u", "Top:Top-u"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := sortedHits(e.search(tt.q))
			if !slices.Equal(got, tt.want) {
				t.Errorf("hits %q, want %q", got, tt.want)
			}
		})
	}

	// Thread names follow the same scope.
	for _, tt := range []struct {
		q    SearchQuery
		want []string
	}{
		{SearchQuery{Query: "h"}, []string{"Archived", "Orphan", "Other"}},
		{SearchQuery{Query: "h", Children: true}, []string{"Archived", "Child", "Orphan", "Other"}},
	} {
		var names []string
		for _, n := range e.search(tt.q).Threads {
			names = append(names, n.Thread.Name)
		}
		sort.Strings(names)
		if !slices.Equal(names, tt.want) {
			t.Errorf("names for %+v: %q, want %q", tt.q, names, tt.want)
		}
	}
	if _, err := e.m.Search(e.ctx(), SearchQuery{Query: "needle", ProjectIDs: []string{"nope"}}); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("unknown project: err %v, want ErrInvalidArgument", err)
	}
	if _, err := e.m.Search(e.ctx(), SearchQuery{Query: "  "}); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("empty query: err %v, want ErrInvalidArgument", err)
	}
}

// Smart case, short queries (names only), short terms checked in Go, the result's
// shape: speakers, snippets, ranges, totals, the order of groups, the limits.
func TestSearchQueries(t *testing.T) {
	e := newEnv(t)
	login := e.connected(CreateOptions{Name: "Fix the Login redirect"})
	ui := e.connected(CreateOptions{Name: "UI polish"})
	questions := `{"questions":[{"question":"Which database for the login sessions?","options":[{"label":"SQLite"}]}]}`
	e.putItems(login.ID,
		Item{ID: "l1", Kind: KindUserMessage, Text: "the Login page redirects twice"},
		Item{ID: "l2", Kind: KindAssistantText, Text: "Fixed: login.go now redirects once."},
		Item{ID: "l3", Kind: KindQuestion, Request: &Request{RequestID: "r1", InputJSON: questions, State: RequestPending}},
	)
	e.putItems(ui.ID,
		Item{ID: "u1", Kind: KindUserMessage, Text: "tidy the ui of the login form"},
		Item{ID: "u2", Kind: KindAssistantText, Text: "done"},
	)

	res := e.search(SearchQuery{Query: "login"})
	if res.CaseSensitive || res.NamesOnly || res.Truncated || res.TotalHits != 4 || res.TotalThreads != 2 {
		t.Fatalf("login: cs %v names-only %v truncated %v hits %d threads %d; want 4 hits in 2 threads", res.CaseSensitive,
			res.NamesOnly, res.Truncated, res.TotalHits, res.TotalThreads)
	}
	// Every hit is a whole word: the thread with the newest one first.
	if got, want := hitsOf(res), []string{ui.Name + ":u1", login.Name + ":l1", login.Name + ":l2", login.Name + ":l3"}; !slices.Equal(got, want) {
		t.Fatalf("hits %q, want %q", got, want)
	}
	g := res.Groups[1]
	if g.Thread.ID != login.ID || g.TotalHits != 3 || len(g.Hits) != 3 {
		t.Fatalf("second group %s: %d hits (%d shown); want %s with 3", g.Thread.Name, g.TotalHits, len(g.Hits), login.Name)
	}
	speakers := []Speaker{g.Hits[0].Speaker, g.Hits[1].Speaker, g.Hits[2].Speaker}
	if !slices.Equal(speakers, []Speaker{SpeakerUser, SpeakerAssistant, SpeakerQuestion}) {
		t.Errorf("speakers %q: want user, assistant, question in conversation order", speakers)
	}
	h := g.Hits[0]
	if h.Snippet != "the Login page redirects twice" || len(h.Ranges) != 1 || h.Ranges[0] != (MatchRange{4, 9}) || h.Ordinal == 0 ||
		h.CreatedAt.IsZero() || h.Kind != KindUserMessage || h.ThreadID != login.ID {
		t.Errorf("hit %+v", h)
	}
	if len(res.Threads) != 1 || res.Threads[0].Thread.ID != login.ID || res.Threads[0].Ranges[0] != (MatchRange{8, 13}) {
		t.Errorf("names %+v; want the login thread, Login at 8", res.Threads)
	}
	// A whole word beats a newer word start: the login thread's "redirect" is inside
	// "redirects", the UI thread's newer one whole.
	e.putItems(ui.ID, Item{ID: "u3", Kind: KindAssistantText, Text: "no redirect here"})
	e.putItems(login.ID, Item{ID: "l4", Kind: KindAssistantText, Text: "redirects are fine now"})
	if got, want := hitsOf(e.search(SearchQuery{Query: "redirect"})), []string{ui.Name + ":u3", login.Name + ":l1", login.Name + ":l2", login.Name + ":l4"}; !slices.Equal(got, want) {
		t.Errorf("redirect: %q, want %q", got, want)
	}
	if got, want := hitsOf(e.search(SearchQuery{Query: "redirect", PerThread: 1})), []string{ui.Name + ":u3", login.Name + ":l4"}; !slices.Equal(got, want) {
		t.Errorf("redirect, one per thread (the newest of the best tier): %q, want %q", got, want)
	}

	// A capital: exact case, in messages and names.
	res = e.search(SearchQuery{Query: "Login"})
	if !res.CaseSensitive || !slices.Equal(hitsOf(res), []string{login.Name + ":l1"}) || len(res.Threads) != 1 {
		t.Errorf("Login: cs %v hits %q names %d; want only l1 and the name", res.CaseSensitive, hitsOf(res), len(res.Threads))
	}
	if res.TotalHits != 1 || res.TotalThreads != 1 {
		t.Errorf("Login totals %d/%d, want 1/1", res.TotalHits, res.TotalThreads)
	}

	// Below the index's three characters: thread names only.
	res = e.search(SearchQuery{Query: "ui"})
	if !res.NamesOnly || len(res.Groups) != 0 || len(res.Threads) != 1 || res.Threads[0].Thread.ID != ui.ID {
		t.Errorf("ui: names-only %v groups %d names %+v; want the UI thread's name only", res.NamesOnly, len(res.Groups), res.Threads)
	}
	// A short term beside a long one is checked against the text.
	res = e.search(SearchQuery{Query: "ui login"})
	if !slices.Equal(hitsOf(res), []string{ui.Name + ":u1"}) || res.TotalHits != 1 {
		t.Errorf("ui login: %q (%d); want u1 alone", hitsOf(res), res.TotalHits)
	}
	// A phrase.
	if got := hitsOf(e.search(SearchQuery{Query: `"redirects once"`})); !slices.Equal(got, []string{login.Name + ":l2"}) {
		t.Errorf("phrase: %q", got)
	}
	// File names and partial words.
	if got := hitsOf(e.search(SearchQuery{Query: "gin.g"})); !slices.Equal(got, []string{login.Name + ":l2"}) {
		t.Errorf("partial file name: %q", got)
	}

	// Limits: per thread, then in all; the totals still count everything.
	res = e.search(SearchQuery{Query: "login", PerThread: 1})
	if got := hitsOf(res); len(got) != 2 || res.TotalHits != 4 || res.Groups[1].TotalHits != 3 {
		t.Errorf("per thread 1: %q, %d hits, second group %d; want one per thread, 4, 3", got, res.TotalHits, res.Groups[1].TotalHits)
	}
	res = e.search(SearchQuery{Query: "login", Limit: 2})
	if got := hitsOf(res); len(got) != 2 || len(res.Groups) != 2 || res.TotalHits != 4 || res.TotalThreads != 2 {
		t.Errorf("limit 2: %q in %d groups, totals %d/%d; want u1 then the login thread's best, totals 4/2", got, len(res.Groups), res.TotalHits, res.TotalThreads)
	}

	// More matches than a search reads: the newest documents, and the result says so.
	defer func(n int) { maxSearchCandidates = n }(maxSearchCandidates)
	maxSearchCandidates = 2
	res = e.search(SearchQuery{Query: "login"})
	if got := sortedHits(res); !res.Truncated || !slices.Equal(got, []string{login.Name + ":l3", ui.Name + ":u1"}) {
		t.Errorf("truncated %v, hits %q; want the two newest documents, l3 and u1", res.Truncated, got)
	}
	maxSearchCandidates = 4
	if res = e.search(SearchQuery{Query: "login"}); res.Truncated || res.TotalHits != 4 {
		t.Errorf("exactly the limit: truncated %v, %d hits", res.Truncated, res.TotalHits)
	}
}

// Items are indexed on the write path: new items and in-place rewrites (a question's
// answers); a removed thread's documents go with it.
func TestSearchWritePath(t *testing.T) {
	e := newEnv(t)
	s := e.connected(CreateOptions{Name: "Q"})
	questions := `{"questions":[{"question":"Which database?","options":[{"label":"SQLite"},{"label":"Postgres"}]}]}`
	e.putItems(s.ID, Item{ID: "q-r1", Kind: KindQuestion, Request: &Request{RequestID: "r1", InputJSON: questions, State: RequestPending}})
	if got := hitsOf(e.search(SearchQuery{Query: "database"})); !slices.Equal(got, []string{"Q:q-r1"}) {
		t.Fatalf("the question: %q", got)
	}
	if got := hitsOf(e.search(SearchQuery{Query: "sqlite"})); len(got) != 0 {
		t.Fatalf("an option nobody chose is found: %q", got)
	}
	log, err := e.m.thread(e.ctx(), s.ID)
	if err != nil {
		t.Fatal(err)
	}
	w := itemWriter{log: log, save: func(it Item) { e.m.saveItem(s.ID, it) }}
	w.change("q-r1", func(it *Item) {
		it.Request.State, it.Request.Answers = RequestAllowed, map[string]string{"Which database?": "SQLite"}
	})
	if got := hitsOf(e.search(SearchQuery{Query: "sqlite"})); !slices.Equal(got, []string{"Q:q-r1"}) {
		t.Fatalf("the answer after the rewrite: %q", got)
	}
	// A tool call's rewrite indexes nothing.
	before := e.countDocs()
	e.putItems(s.ID, Item{ID: "t1", Kind: KindToolCall, Tool: &ToolCall{Name: "Bash", Status: ToolRunning}})
	w.change("t1", func(it *Item) { it.Tool.Status, it.Tool.Output = ToolDone, "database" })
	if n := e.countDocs(); n != before {
		t.Errorf("documents %d after a tool call, want %d", n, before)
	}
	if err := e.m.Remove(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	if n := e.countDocs(); n != 0 {
		t.Errorf("documents after removing the thread: %d, want 0", n)
	}
	var fts int
	if err := e.m.opts.DB.QueryRowContext(e.ctx(), `SELECT COUNT(*) FROM search_fts WHERE search_fts MATCH '"database"'`).Scan(&fts); err != nil {
		t.Fatal(err)
	}
	if fts != 0 {
		t.Errorf("the index still matches %d documents of the removed thread", fts)
	}
}

// waitHits searches until the hits are want (a fork's copy is written after its spawn).
func (e *env) waitHits(q SearchQuery, want []string) {
	e.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		got := hitsOf(e.search(q))
		if slices.Equal(got, want) {
			return
		}
		if time.Now().After(deadline) {
			e.t.Fatalf("hits %q, want %q", got, want)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// A fork's copies keep their item ids: one hit per item, under the oldest thread holding
// it in scope (the original, archived too), moving to the fork when the original is
// removed, with no document rewritten.
func TestSearchForks(t *testing.T) {
	e := newEnv(t)
	s := e.connected(CreateOptions{Name: "Original"})
	e.resumable(s.ID)
	e.putItems(s.ID, Item{ID: "u1", Kind: KindUserMessage, Text: "the needle before the fork"}, Item{ID: "turn-1", Kind: KindTurnEnd, Turn: &TurnEnd{Subtype: "success"}})
	f, err := e.m.Fork(e.ctx(), s.ID, "Fork")
	if err != nil {
		t.Fatal(err)
	}
	e.waitFor(f.ID, "fork connected", func(s Thread) bool { return s.State == StateConnected })
	e.waitItems(f.ID, "the copy", func(items []Item) bool { return len(items) > 0 })
	var held int
	deadline := time.Now().Add(5 * time.Second)
	for held < 2 && time.Now().Before(deadline) {
		if err := e.m.opts.DB.QueryRowContext(e.ctx(), `SELECT COUNT(*) FROM thread_items WHERE item_id = 'u1'`).Scan(&held); err != nil {
			t.Fatal(err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if held != 2 {
		t.Fatalf("u1 has %d rows; want the original's and the fork's", held)
	}
	e.putItems(f.ID, Item{ID: "f1", Kind: KindUserMessage, Text: "the needle after the fork"})
	doc := e.docID("u1")

	q := SearchQuery{Query: "needle"}
	e.waitHits(q, []string{"Fork:f1", "Original:u1"})
	if res := e.search(q); res.TotalHits != 2 {
		t.Errorf("total hits %d, want 2: the copy is not counted", res.TotalHits)
	}
	if _, err := e.m.Archive(e.ctx(), s.ID, true); err != nil {
		t.Fatal(err)
	}
	e.waitHits(q, []string{"Fork:f1", "Original:u1"})
	if err := e.m.Remove(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	res := e.search(q)
	if got := hitsOf(res); !slices.Equal(got, []string{"Fork:f1", "Fork:u1"}) && !slices.Equal(got, []string{"Fork:u1", "Fork:f1"}) {
		t.Fatalf("after removing the original: %q; want both under the fork", got)
	}
	if got := e.docID("u1"); got != doc {
		t.Errorf("u1's document %d, want %d unchanged", got, doc)
	}
	// The fork's own copy is the holder now; it keeps its ordinal.
	for _, h := range res.Groups[0].Hits {
		if h.ItemID == "u1" && h.Ordinal != 1 {
			t.Errorf("u1's ordinal in the fork %d, want 1", h.Ordinal)
		}
	}
}

// An older hidden child's copy does not hide the hit from the default scope: the oldest
// holder in scope gets it (the user forked a child to take its work over).
func TestSearchForkOfAHiddenChild(t *testing.T) {
	e := newEnv(t)
	lead := e.connected(CreateOptions{Name: "Lead"})
	child := e.connected(CreateOptions{Name: "Child", CreatedBy: lead.ID})
	taken := e.connected(CreateOptions{Name: "Taken over"})
	it := Item{ID: "u1", Kind: KindUserMessage, Text: "the needle"}
	e.putItems(child.ID, it)
	e.putItems(taken.ID, it)
	if got := hitsOf(e.search(SearchQuery{Query: "needle"})); !slices.Equal(got, []string{"Taken over:u1"}) {
		t.Errorf("default scope: %q", got)
	}
	if got := hitsOf(e.search(SearchQuery{Query: "needle", Children: true})); !slices.Equal(got, []string{"Child:u1"}) {
		t.Errorf("with children: %q", got)
	}
}

// Options.Unindexed keeps a thread out: no documents, never a holder.
func TestSearchUnindexed(t *testing.T) {
	e := newEnv(t, func(o *Options) { o.Unindexed = func(t Thread) bool { return t.Name == "Hidden run" } })
	hidden := e.connected(CreateOptions{Name: "Hidden run"})
	shown := e.connected(CreateOptions{Name: "Shown"})
	e.putItems(hidden.ID, Item{ID: "h1", Kind: KindUserMessage, Text: "the needle, hidden"})
	if n := e.countDocs(); n != 0 {
		t.Errorf("documents %d for an unindexed thread, want 0", n)
	}
	e.putItems(shown.ID, Item{ID: "s1", Kind: KindUserMessage, Text: "the needle, shown"})
	e.putItems(hidden.ID, Item{ID: "s1", Kind: KindUserMessage, Text: "the needle, shown"})
	if got := hitsOf(e.search(SearchQuery{Query: "needle", Children: true, Owned: true})); !slices.Equal(got, []string{"Shown:s1"}) {
		t.Errorf("hits %q, want the shown thread's only", got)
	}
	if res := e.search(SearchQuery{Query: "hidden"}); len(res.Threads) != 0 {
		t.Errorf("names %+v: an unindexed thread is found by name", res.Threads)
	}
}

// Threads from before the index are indexed at startup from search_backfill, and the
// list empties.
func TestSearchBackfill(t *testing.T) {
	e := newEnv(t)
	a := e.connected(CreateOptions{Name: "A"})
	b := e.connected(CreateOptions{Name: "B"})
	off := searchIndex{off: true} // saved as before migration 0054
	for i, s := range []Thread{a, b} {
		it := Item{ID: s.Name + "-u", Ordinal: int64(100 + i), Kind: KindUserMessage, Text: "an old needle in " + s.Name,
			CreatedAt: time.Now(), UpdatedAt: time.Now()}
		if err := saveItem(e.ctx(), e.m.opts.DB, s.ID, it, off); err != nil {
			t.Fatal(err)
		}
	}
	tool := Item{ID: "a-tool", Ordinal: 200, Kind: KindToolCall, Tool: &ToolCall{Name: "Bash", Output: "needle"}, CreatedAt: time.Now(), UpdatedAt: time.Now()}
	if err := saveItem(e.ctx(), e.m.opts.DB, a.ID, tool, off); err != nil {
		t.Fatal(err)
	}
	if got := hitsOf(e.search(SearchQuery{Query: "needle"})); len(got) != 0 {
		t.Fatalf("hits before the backfill: %q", got)
	}
	if _, err := e.m.opts.DB.ExecContext(e.ctx(), `INSERT INTO search_backfill (thread_id) VALUES (?), (?)`, a.ID, b.ID); err != nil {
		t.Fatal(err)
	}
	e.restart()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		var left int
		if err := e.m.opts.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM search_backfill`).Scan(&left); err != nil {
			t.Fatal(err)
		}
		if left == 0 {
			break
		}
		if ctx.Err() != nil {
			t.Fatalf("%d threads left to index", left)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if got := sortedHits(e.search(SearchQuery{Query: "needle"})); !slices.Equal(got, []string{"A:A-u", "B:B-u"}) {
		t.Errorf("hits after the backfill: %q", got)
	}
	if n := e.countDocs(); n != 2 {
		t.Errorf("documents %d, want 2 (the tool call is not indexed)", n)
	}
	// Indexing again changes nothing.
	if n, err := e.m.backfillThread(e.ctx(), a.ID); err != nil || n != 1 || e.countDocs() != 2 {
		t.Errorf("a second backfill: %d, %v, %d documents", n, err, e.countDocs())
	}
}
