package thread

import (
	"context"
	"strings"
)

// The owner of a thread's link (docs/notes/pr-task-forward.md). A parent carries its
// created threads' links as copies (LinkChild, prlink_children.go), each naming the
// direct child it came through. pr.task --thread forwards a task given to the parent to
// the thread whose own work the link is: the owner.

// LinkOwner follows start's link to the pull request (number, any of slugs, case aside)
// down its CreatedBy chain: a link that is not a child copy is its thread's own, so that
// thread is the owner; a child copy goes on to its via thread. links reads a thread's
// links; ok false for a thread that is gone (removed or being removed). The owner is
// start itself when its link is its own or it has none, and also when the chain breaks
// (a hop gone or without the link, a cycle, more than MaxLineageDepth hops): start can
// delegate. An archived owner is still the owner (a send revives it).
func LinkOwner(start string, slugs []string, number int, links func(id string) ([]LinkedPullRequest, bool)) string {
	seen := map[string]bool{start: true}
	for cur, hops := start, 0; ; hops++ {
		ls, ok := links(cur)
		if !ok {
			return start
		}
		l, ok := findLink(ls, slugs, number)
		switch {
		case !ok:
			return start
		case l.Source != LinkChild:
			return cur
		case l.ViaThreadID == "" || seen[l.ViaThreadID] || hops >= MaxLineageDepth:
			return start
		}
		seen[l.ViaThreadID] = true
		cur = l.ViaThreadID
	}
}

// findLink is the link in ls to the pull request number in any of slugs, case aside.
func findLink(ls []LinkedPullRequest, slugs []string, number int) (LinkedPullRequest, bool) {
	for _, l := range ls {
		if l.Number != number {
			continue
		}
		for _, s := range slugs {
			if s = strings.TrimSpace(s); s != "" && strings.EqualFold(l.Slug, s) {
				return l, true
			}
		}
	}
	return LinkedPullRequest{}, false
}

// PullRequestOwner implements Store: LinkOwner over the threads as they are now. An
// unknown thread is ErrNotFound (a removed one RemovedError, as Get).
func (m *Manager) PullRequestOwner(_ context.Context, id string, slugs []string, number int) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if rec, ok := m.recs[id]; !ok || rec.s.Removing {
		return "", m.notFound(id)
	}
	return LinkOwner(id, slugs, number, func(t string) ([]LinkedPullRequest, bool) {
		rec, ok := m.recs[t]
		if !ok || rec.s.Removing {
			return nil, false
		}
		return rec.s.LinkedPullRequests, true
	}), nil
}
