package thread

import (
	"context"
	"slices"
)

// Branch links (docs/notes/linked-prs-branch.md, docs/notes/linked-prs-default-branch.md).
//
// A thread's links also include every pull request whose head is a branch the thread
// works on, in its project's repository, other than the project's default branch. The
// thread store does not know the GitHub, project or workspace stores: the daemon
// resolves each thread's branches, matches them against the GitHub store's cached
// lists, and pushes the matches here, each with the head it matched (Head). They are
// merged like Claude's records (deduplicated by URL, a URL the thread has keeps its
// row, never removed) and copied up the CreatedBy chain. The one removal is
// SettleBranchLinks: a branch link made before heads were recorded whose head turns
// out to be the default branch.

// LinkBranchPullRequests links pull requests found on thread id's branches
// (LinkBranch). Links without a time get now. Returns how many were new to the thread;
// a known URL changes nothing and publishes nothing, and an unknown thread is ignored.
func (m *Manager) LinkBranchPullRequests(id string, links []LinkedPullRequest) int {
	own := make([]LinkedPullRequest, len(links))
	for i, l := range links {
		l.Source, l.ViaThreadID = LinkBranch, ""
		own[i] = l
	}
	return m.linkPullRequests(id, own)
}

// SettleBranchLinks resolves thread id's branch links that have no Head (made before
// heads were recorded). The URLs in drop are removed, and so is each one's child copy
// up the CreatedBy chain (at each hop the LinkChild row that came through the thread
// below; the chain stops where no copy is left). The URLs in heads get that head.
// Only LinkBranch rows without a Head are touched. Returns how many rows were removed,
// copies included; an unknown thread is ignored.
func (m *Manager) SettleBranchLinks(id string, heads map[string]string, drop []string) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.recs[id]
	if !ok {
		return 0
	}
	unsettled := func(l LinkedPullRequest) bool { return l.Source == LinkBranch && l.Head == "" }
	set := map[string]string{}
	links := slices.Clone(rec.s.LinkedPullRequests)
	for i, l := range links {
		if h, ok := heads[l.URL]; ok && h != "" && unsettled(l) && !slices.Contains(drop, l.URL) {
			links[i].Head = h
			set[l.URL] = h
		}
	}
	var dropped []string
	links = slices.DeleteFunc(links, func(l LinkedPullRequest) bool {
		if unsettled(l) && slices.Contains(drop, l.URL) {
			dropped = append(dropped, l.URL)
			return true
		}
		return false
	})
	if len(set) == 0 && len(dropped) == 0 {
		return 0
	}
	ctx := context.Background()
	if len(set) > 0 {
		if err := saveLinkHeads(ctx, m.opts.DB, id, set); err != nil {
			m.log.Error("record branch links' heads", "thread", id, "err", err)
		}
	}
	// Heads alone publish too: the snapshot must hold them, so the daemon does not ask again.
	m.removeLinksLocked(rec, links, dropped)
	removed := len(dropped)
	seen := map[string]bool{id: true}
	for child := id; len(dropped) > 0; {
		up := m.recs[child].s.CreatedBy
		if up == "" || seen[up] {
			break
		}
		seen[up] = true
		parent, ok := m.recs[up]
		if !ok {
			break
		}
		var next []string
		kept := slices.DeleteFunc(slices.Clone(parent.s.LinkedPullRequests), func(l LinkedPullRequest) bool {
			if l.Source == LinkChild && l.ViaThreadID == child && slices.Contains(dropped, l.URL) {
				next = append(next, l.URL)
				return true
			}
			return false
		})
		if len(next) == 0 {
			break
		}
		m.removeLinksLocked(parent, kept, next)
		removed += len(next)
		child, dropped = up, next
	}
	return removed
}

// removeLinksLocked sets rec's links to kept, deletes the rows of urls and publishes
// rec. Callers hold m.mu.
func (m *Manager) removeLinksLocked(rec *record, kept []LinkedPullRequest, urls []string) {
	if len(urls) > 0 {
		if err := deleteLinks(context.Background(), m.opts.DB, rec.s.ID, urls); err != nil {
			m.log.Error("remove default-branch links", "thread", rec.s.ID, "err", err)
		}
	}
	rec.s.LinkedPullRequests = kept
	m.commitLocked(rec, false)
}
