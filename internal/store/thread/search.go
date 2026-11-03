package thread

import (
	"cmp"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/workspace"
)

// Thread search (docs/notes/search-3-index.md): thread names and the indexed text of
// thread items (search_index.go, search_extract.go), for thread.search and the GUI's Find.
//
// Scope: by default the user's threads, what the sidebar can show: threads no plugin owns
// that are in the sidebar (InSidebar: no creator, or a creator that is gone), archived and
// snoozed ones and Ember's chat included, and their own items, not their subagents'.
// SearchQuery widens it. A thread Options.Unindexed keeps out is never in it.
//
// Forks: a fork's copies of its parent's items keep their ids, and the index has one
// document per id. A hit is attributed to the oldest thread in scope whose copy of the
// item matches (by CreatedAt), so a forked conversation is found once, under the original
// while it exists (archived counts) and under the fork once it is gone, with nothing
// re-indexed.

// Search sizes.
const (
	DefaultSearchLimit     = 50
	MaxSearchLimit         = 500
	DefaultSearchPerThread = 5
)

// maxSearchCandidates is how many of the index's matching documents a search reads at
// most, newest first (docs/notes/search-3-index.md: reading every match of a common word
// in a large database takes seconds). A variable for tests.
var maxSearchCandidates = 5000

// SearchQuery is Search's question.
type SearchQuery struct {
	// Query: terms, all of which must occur (search_match.go). Required.
	Query string
	// Children: also child threads whose creator still exists (hidden from the sidebar).
	Children bool
	// Subagents: also the items of the threads' subagents.
	Subagents bool
	// Owned: also threads a plugin owns.
	Owned bool
	// ProjectIDs: only threads whose project set has one of these (ids, names, or paths
	// inside a project); none: every project, and threads without one.
	ProjectIDs []string
	// Limit: at most this many message hits in all, and this many thread names
	// (DefaultSearchLimit when 0 or less, capped at MaxSearchLimit).
	Limit int
	// PerThread: at most this many hits per thread (DefaultSearchPerThread when 0 or
	// less, capped at Limit); a group's TotalHits counts them all.
	PerThread int
}

// SearchResult is Search's answer.
type SearchResult struct {
	// CaseSensitive: the query has an upper-case letter, so matches are exact.
	CaseSensitive bool
	// NamesOnly: every term is shorter than three characters, below what the index
	// holds: only thread names were searched.
	NamesOnly bool
	// Threads are the threads in scope whose name matches, most recently active first.
	Threads []ThreadNameMatch
	// Groups are the message hits by thread, the group with the best hit first: a hit's
	// tier (every term a whole word, then at a word's start, then inside one), then the
	// newer.
	Groups []SearchGroup
	// TotalHits and TotalThreads count every hit and every thread with one, beyond
	// Limit and PerThread.
	TotalHits    int
	TotalThreads int
	// Truncated: more than maxSearchCandidates documents in scope matched in the index;
	// the hits and totals are those among the newest that many (a common word: refine the
	// query).
	Truncated bool
}

// ThreadNameMatch is a thread whose name matches.
type ThreadNameMatch struct {
	Thread Thread
	// Ranges are the matches in Thread.Name.
	Ranges []MatchRange
}

// SearchGroup is one thread's message hits.
type SearchGroup struct {
	Thread Thread
	// TotalHits is how many of the thread's items match (Hits has at most PerThread).
	TotalHits int
	// Hits are the best PerThread (tier, then the newest), in conversation order.
	Hits []SearchHit
}

// SearchHit is one item that matches.
type SearchHit struct {
	ThreadID string
	ItemID   string
	// Ordinal is the item's in ThreadID's log (thread.read --since <ordinal-1> --last 1
	// reads it; a fork's copy has its own).
	Ordinal int64
	Kind    ItemKind
	Speaker Speaker
	// ParentToolUseID is the Agent call a subagent's item belongs to; "" for the thread's own.
	ParentToolUseID string
	CreatedAt       time.Time
	// Snippet is the item's text on one line, cut around its first match; Ranges are the
	// matches in it.
	Snippet string
	Ranges  []MatchRange
	// doc is the item's search document; line its text on one line (searchLine), which
	// Ranges index until the snippet is cut; tier the hit's quality (searchQuery.tier).
	doc  int64
	line []rune
	tier int
}

// Search implements Store.
func (m *Manager) Search(ctx context.Context, q SearchQuery) (SearchResult, error) {
	sq := parseSearch(q.Query)
	if len(sq.terms) == 0 {
		return SearchResult{}, fmt.Errorf("%w: a query is required", ErrInvalidArgument)
	}
	limit := q.Limit
	if limit <= 0 {
		limit = DefaultSearchLimit
	}
	limit = min(limit, MaxSearchLimit)
	per := q.PerThread
	if per <= 0 {
		per = DefaultSearchPerThread
	}
	per = min(per, limit)
	snap := m.Snapshot()
	scope, err := m.searchScope(snap, q)
	if err != nil {
		return SearchResult{}, err
	}
	res := SearchResult{CaseSensitive: sq.caseSensitive, NamesOnly: sq.fts == "", Threads: nameMatches(scope, sq, limit),
		Groups: []SearchGroup{}}
	if res.NamesOnly || len(scope) == 0 {
		return res, nil
	}
	hits, truncated, err := searchHits(ctx, m.opts.DB, sq, scope, q.Subagents)
	if err != nil {
		return SearchResult{}, err
	}
	res.Truncated = truncated
	res.Groups, res.TotalHits, res.TotalThreads = groupHits(scope, hits, limit, per)
	return res, nil
}

// searchScope is the threads q searches, by id.
func (m *Manager) searchScope(snap *Snapshot, q SearchQuery) (map[string]Thread, error) {
	var set []string
	for _, ref := range q.ProjectIDs {
		ref = strings.TrimSpace(ref)
		if ref == "" {
			continue
		}
		if m.opts.Projects != nil { // without a project store (tests): an id
			r, err := workspace.ResolveProject(m.opts.Projects.Snapshot(), ref)
			if err != nil {
				return nil, listRefError("project", ref, err)
			}
			ref = r.ID
		}
		set = append(set, ref)
	}
	exists := Known(snap.Threads)
	out := map[string]Thread{}
	for _, t := range snap.Threads {
		switch {
		case t.Owner != "" && !q.Owned,
			!q.Children && !t.InSidebar(exists),
			len(set) > 0 && !slices.ContainsFunc(t.ProjectIDs, func(id string) bool { return slices.Contains(set, id) }),
			m.opts.Unindexed != nil && m.opts.Unindexed(t):
			continue
		}
		out[t.ID] = t
	}
	return out, nil
}

// nameMatches returns the threads of scope whose name matches sq, most recently active
// first, at most limit.
func nameMatches(scope map[string]Thread, sq searchQuery, limit int) []ThreadNameMatch {
	out := []ThreadNameMatch{}
	for _, t := range scope {
		if r := sq.matchText(t.Name); r != nil {
			out = append(out, ThreadNameMatch{Thread: t, Ranges: r})
		}
	}
	slices.SortFunc(out, func(a, b ThreadNameMatch) int {
		if c := b.Thread.LastActivityAt.Compare(a.Thread.LastActivityAt); c != 0 {
			return c
		}
		return strings.Compare(a.Thread.ID, b.Thread.ID)
	})
	return out[:min(len(out), limit)]
}

// searchHits returns the items the index matches among the newest maxSearchCandidates
// matching documents in scope (a document's rowid grows with its first save; truncated
// says more matched), one per item id. The scope is applied inside the capped subquery: a
// document counts only when a thread of scope holds it (its own item, or a subagent's with
// subagents), so text out of scope never takes a place. Each hit goes to the oldest
// thread of scope whose own copy of the item matches sq (smart case, short terms; a
// holder whose text does not match, its document being from another copy, is no hit).
func searchHits(ctx context.Context, db *sql.DB, sq searchQuery, scope map[string]Thread, subagents bool) (hits []SearchHit, truncated bool, err error) {
	ids := make([]string, 0, len(scope))
	for id := range scope {
		ids = append(ids, id)
	}
	scopeJSON, err := json.Marshal(ids)
	if err != nil {
		return nil, false, fmt.Errorf("thread: search: %w", err)
	}
	rows, err := db.QueryContext(ctx, `SELECT d.id, ti.thread_id, ti.item_id, ti.ordinal, ti.kind, ti.parent_tool_use_id,
			ti.created_at, ti.updated_at, ti.data
		FROM search_docs d
		JOIN thread_items ti ON ti.item_id = d.item_id
		WHERE ti.thread_id IN (SELECT value FROM json_each(?2)) AND (?3 OR ti.parent_tool_use_id = '')
		AND d.id IN (SELECT search_fts.rowid FROM search_fts WHERE search_fts MATCH ?1
			AND EXISTS (SELECT 1 FROM search_docs s JOIN thread_items h ON h.item_id = s.item_id
				WHERE s.id = search_fts.rowid AND h.thread_id IN (SELECT value FROM json_each(?2)) AND (?3 OR h.parent_tool_use_id = ''))
			ORDER BY search_fts.rowid DESC LIMIT ?4)`,
		sq.fts, string(scopeJSON), subagents, maxSearchCandidates+1)
	if err != nil {
		return nil, false, fmt.Errorf("thread: search: %w", err)
	}
	defer func() { _ = rows.Close() }()
	byItem := map[string]SearchHit{}
	docs := map[int64]bool{}
	var oldest int64 = -1
	for rows.Next() {
		var h SearchHit
		var doc, created, updated int64
		var kind, data string
		if err := rows.Scan(&doc, &h.ThreadID, &h.ItemID, &h.Ordinal, &kind, &h.ParentToolUseID,
			&created, &updated, &data); err != nil {
			return nil, false, fmt.Errorf("thread: search: %w", err)
		}
		docs[doc] = true
		if oldest < 0 || doc < oldest {
			oldest = doc
		}
		t, ok := scope[h.ThreadID]
		if !ok || (h.ParentToolUseID != "" && !subagents) {
			continue
		}
		if prev, ok := byItem[h.ItemID]; ok && !olderThread(t, scope[prev.ThreadID]) {
			continue
		}
		// Match this holder's own copy before it can take the hit: an older holder whose
		// copy differs (a question answered in only one of them) must not hide a younger
		// one whose copy matches.
		it, err := decodeItem(h.ItemID, h.Ordinal, kind, h.ParentToolUseID, created, updated, data)
		if err != nil {
			return nil, false, fmt.Errorf("thread: search: %w", err)
		}
		text, sp, _ := itemSearchText(it)
		line := []rune(text)
		ranges := sq.matchRunes(line)
		if ranges == nil {
			continue
		}
		h.doc, h.Kind, h.CreatedAt, h.Speaker, h.line, h.Ranges = doc, it.Kind, it.CreatedAt, sp, line, ranges
		h.tier = sq.tier(line)
		byItem[h.ItemID] = h
	}
	if err := rows.Err(); err != nil {
		return nil, false, fmt.Errorf("thread: search: %w", err)
	}
	truncated = len(docs) > maxSearchCandidates
	out := make([]SearchHit, 0, len(byItem))
	for _, h := range byItem {
		if truncated && h.doc == oldest {
			continue // the one past the limit, read to tell
		}
		out = append(out, h)
	}
	return out, truncated, nil
}

// olderThread reports whether a is older than b (CreatedAt, then id): the holder a hit
// goes to.
func olderThread(a, b Thread) bool {
	if c := a.CreatedAt.Compare(b.CreatedAt); c != 0 {
		return c < 0
	}
	return a.ID < b.ID
}

// betterHit orders hits best first: the better tier, then the newer (created, then the
// later document: times are kept in milliseconds).
func betterHit(a, b SearchHit) int {
	if c := cmp.Compare(a.tier, b.tier); c != 0 {
		return c
	}
	if c := b.CreatedAt.Compare(a.CreatedAt); c != 0 {
		return c
	}
	if c := cmp.Compare(b.doc, a.doc); c != 0 {
		return c
	}
	return strings.Compare(a.ItemID, b.ItemID)
}

// groupHits groups hits by thread, the group with the best hit first (tier, then the
// newest such hit), keeps the best per of each, shown in conversation order, at most limit
// in all, each with its snippet. It returns the groups and how many hits and threads
// there are in all.
func groupHits(scope map[string]Thread, hits []SearchHit, limit, per int) ([]SearchGroup, int, int) {
	byThread := map[string][]SearchHit{}
	for _, h := range hits {
		byThread[h.ThreadID] = append(byThread[h.ThreadID], h)
	}
	ids := make([]string, 0, len(byThread))
	for id, hs := range byThread {
		slices.SortFunc(hs, betterHit)
		ids = append(ids, id)
	}
	slices.SortFunc(ids, func(a, b string) int {
		if c := betterHit(byThread[a][0], byThread[b][0]); c != 0 {
			return c
		}
		return strings.Compare(a, b)
	})
	out := []SearchGroup{}
	left := limit
	for _, id := range ids {
		if left == 0 {
			break
		}
		hs := byThread[id]
		shown := slices.Clone(hs[:min(len(hs), per, left)])
		left -= len(shown)
		for i := range shown {
			shown[i].Snippet, shown[i].Ranges = cutSnippet(shown[i].line, shown[i].Ranges)
		}
		slices.SortFunc(shown, func(a, b SearchHit) int { return cmp.Compare(a.Ordinal, b.Ordinal) })
		out = append(out, SearchGroup{Thread: scope[id], TotalHits: len(hs), Hits: shown})
	}
	return out, len(hits), len(ids)
}
