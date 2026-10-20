package thread

import (
	"context"
	"slices"
	"strings"
)

// Child threads' links (docs/notes/linked-prs-children.md).
//
// A thread's links include every link of the threads it created (CreatedBy), and of
// theirs, transitively. The union is materialized: when a thread gains a link, each
// ancestor up its CreatedBy chain gains a copy (LinkChild, ViaThreadID the direct child
// at that hop, LinkedAt the original's), under the usual rules: deduplicated by URL
// (a URL the ancestor has keeps its row), first-seen order, never removed. Every
// consumer reads LinkedPullRequests unchanged.
//
// A fork (ParentID) inherits nothing and a fork of a child is not a child: a fork has
// no CreatedBy. An archived child still counts; a removed one leaves its copies behind
// (they are the ancestor's rows) and ends the chain, as does a creator that is gone.

// asChildLinks returns copies of links as the ancestor's, come through via.
func asChildLinks(links []LinkedPullRequest, via string) []LinkedPullRequest {
	out := make([]LinkedPullRequest, len(links))
	for i, l := range links {
		l.Source, l.ViaThreadID = LinkChild, via
		out[i] = l
	}
	return out
}

// addLinksLocked merges links into rec, persists the new ones and publishes rec once
// if any was new. Returns what was new. Callers hold m.mu.
func (m *Manager) addLinksLocked(rec *record, links []LinkedPullRequest) []LinkedPullRequest {
	merged, added := mergeLinks(rec.s.LinkedPullRequests, links)
	if len(added) == 0 {
		return nil
	}
	if err := saveLinks(context.Background(), m.opts.DB, rec.s.ID, added); err != nil {
		m.log.Error("persist linked pull requests", "thread", rec.s.ID, "err", err)
	}
	rec.s.LinkedPullRequests = merged
	m.commitLocked(rec, false)
	return added
}

// propagateLinksLocked copies links, just added to thread id, to each ancestor up its
// CreatedBy chain. The whole set goes up every hop (an ancestor that has a URL keeps
// its row and the chain goes on), so a chain is whole even where an intermediate
// thread linked the pull request itself. Stops at a thread with no creator, a creator
// that is gone, or a cycle. Callers hold m.mu.
func (m *Manager) propagateLinksLocked(id string, links []LinkedPullRequest) {
	if len(links) == 0 {
		return
	}
	seen := map[string]bool{id: true}
	for child := id; ; {
		rec, ok := m.recs[child]
		if !ok {
			return
		}
		up := rec.s.CreatedBy
		if up == "" || seen[up] {
			return
		}
		seen[up] = true
		parent, ok := m.recs[up]
		if !ok {
			return
		}
		m.addLinksLocked(parent, asChildLinks(links, child))
		child = up
	}
}

// foldChildLinks is the one-time backfill for links that predate propagation: every
// thread gets the links of its descendants it lacks, in LinkedAt order, persisted.
// Idempotent: once folded, nothing is new and nothing is written. Runs in New before
// the first snapshot, so it publishes nothing. A thread whose rows cannot be saved
// keeps its links as loaded and is folded again on the next start.
func (m *Manager) foldChildLinks(ctx context.Context) {
	ids := make([]string, 0, len(m.recs))
	for id := range m.recs {
		ids = append(ids, id)
	}
	slices.SortFunc(ids, func(a, b string) int {
		if c := m.recs[a].s.CreatedAt.Compare(m.recs[b].s.CreatedAt); c != 0 {
			return c
		}
		return strings.Compare(a, b)
	})
	kids := map[string][]string{}
	for _, id := range ids {
		if up := m.recs[id].s.CreatedBy; up != "" && up != id && m.recs[up] != nil {
			kids[up] = append(kids[up], id)
		}
	}
	threads, total := 0, 0
	for _, id := range ids {
		if len(kids[id]) == 0 {
			continue
		}
		// Every descendant's links, each tagged with the direct child it is under.
		var cand []LinkedPullRequest
		seen := map[string]bool{id: true}
		for _, via := range kids[id] {
			queue := []string{via}
			for len(queue) > 0 {
				d := queue[0]
				queue = queue[1:]
				if seen[d] {
					continue
				}
				seen[d] = true
				cand = append(cand, asChildLinks(m.recs[d].s.LinkedPullRequests, via)...)
				queue = append(queue, kids[d]...)
			}
		}
		// The earliest link of a URL is its first source; mergeLinks keeps the first.
		slices.SortStableFunc(cand, func(a, b LinkedPullRequest) int { return a.LinkedAt.Compare(b.LinkedAt) })
		rec := m.recs[id]
		merged, added := mergeLinks(rec.s.LinkedPullRequests, cand)
		if len(added) == 0 {
			continue
		}
		if err := saveLinks(ctx, m.opts.DB, id, added); err != nil {
			m.log.Warn("fold child threads' linked pull requests", "thread", id, "err", err)
			continue
		}
		rec.s.LinkedPullRequests = merged
		threads++
		total += len(added)
	}
	if total > 0 {
		m.log.Info("linked pull requests folded up from child threads", "threads", threads, "links", total)
	}
}
