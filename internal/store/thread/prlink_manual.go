package thread

import (
	"context"
	"fmt"
	"slices"
	"strconv"
	"strings"
)

// Manual links (docs/notes/pr-daemon-actions.md): a pull request the user (or an agent)
// links to a thread by hand, from the pull request panel or `thread pr link`. Stored and
// merged like every other link (LinkManual): deduplicated by URL ignoring case
// (SamePullRequestURL), first source wins, copied up the CreatedBy chain, and never
// removed (there is no unlink). The one exception to "first source wins": a row the
// daemon may remove (a branch link, or a child copy, which goes with its branch link)
// becomes manual, so the user's explicit link stays.

// LinkPullRequest links the pull request ref names (a GitHub pull request URL or
// "owner/name#123") to thread id by hand. The link has GitHub's URL (and the slug in
// it) when the GitHub store's cache holds the pull request (Options.PullRequest), else
// the slug as written. It returns the thread, the link as the thread has it, and
// whether it was new: a pull request the thread already has is a quiet success that
// publishes nothing (a branch or child row becomes manual, persisted; nothing the API
// shows changes). Any state. ErrInvalidArgument for anything that is not a GitHub pull
// request.
func (m *Manager) LinkPullRequest(ctx context.Context, id, ref string) (Thread, LinkedPullRequest, bool, error) {
	slug, number, err := ParsePullRequestLink(ref)
	if err != nil {
		return Thread{}, LinkedPullRequest{}, false, err
	}
	slug = m.canonicalPullRequestSlug(ctx, slug, number)
	l := LinkedPullRequest{Slug: slug, Number: number, URL: pullRequestURL(slug, number), Source: LinkManual}
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, err := m.record(id)
	if err != nil {
		return Thread{}, LinkedPullRequest{}, false, err
	}
	if i := slices.IndexFunc(rec.s.LinkedPullRequests, func(x LinkedPullRequest) bool { return SamePullRequestURL(x.URL, l.URL) }); i >= 0 {
		return rec.s, m.keepManualLocked(rec, i), false, nil
	}
	l.LinkedAt = m.opts.Now()
	added := m.addLinksLocked(rec, []LinkedPullRequest{l})
	m.propagateLinksLocked(id, added)
	m.log.Info("pull request linked by hand", "thread", id, "pr", l.URL)
	return rec.s, l, true, nil
}

// canonicalPullRequestSlug is the slug in GitHub's URL for the pull request when the
// GitHub store's cache holds it (GitHub's case, and its current name after a rename),
// else slug. Never asks GitHub.
func (m *Manager) canonicalPullRequestSlug(ctx context.Context, slug string, number int) string {
	if m.opts.PullRequest == nil {
		return slug
	}
	p, ok := m.opts.PullRequest(ctx, slug+"#"+strconv.Itoa(number))
	if !ok || p.URL == "" {
		return slug
	}
	if s, n, err := ParsePullRequestLink(p.URL); err == nil && n == number {
		return s
	}
	return slug
}

// keepManualLocked makes rec's link i a manual link when the daemon could remove it (a
// branch row: dropBranchLinks, SettleBranchLinks; a child copy: SettleBranchLinks up
// the chain), persisted. Source, via and head are not on the API, so nothing is
// published; the snapshot is rebuilt. Returns the link. Callers hold m.mu.
func (m *Manager) keepManualLocked(rec *record, i int) LinkedPullRequest {
	l := rec.s.LinkedPullRequests[i]
	if l.Source != LinkBranch && l.Source != LinkChild {
		return l
	}
	if err := saveLinkSource(context.Background(), m.opts.DB, rec.s.ID, l.URL, LinkManual); err != nil {
		m.log.Error("persist manual link", "thread", rec.s.ID, "pr", l.URL, "err", err)
	}
	was := l.Source
	l.Source, l.ViaThreadID, l.Head = LinkManual, "", ""
	links := slices.Clone(rec.s.LinkedPullRequests) // snapshots share the backing array
	links[i] = l
	rec.s.LinkedPullRequests = links
	m.rebuildLocked()
	m.log.Info("pull request linked by hand over an existing link", "thread", rec.s.ID, "pr", l.URL, "was", was)
	return l
}

// ParsePullRequestLink reads "owner/name#123" or a GitHub pull request URL (with or
// without the scheme, anything after the number ignored) into its slug, as written, and
// number. Errors wrap ErrInvalidArgument.
func ParsePullRequestLink(s string) (slug string, number int, err error) {
	s = strings.TrimSpace(s)
	m := prRefRE.FindStringSubmatch(s)
	if m == nil {
		m = prURLRE.FindStringSubmatch(s)
	}
	if m == nil || m[2] == "." || m[2] == ".." {
		return "", 0, fmt.Errorf("%w: %q is not a GitHub pull request (want a https://github.com/owner/name/pull/123 URL or owner/name#123)", ErrInvalidArgument, s)
	}
	n, err := strconv.Atoi(m[3])
	if err != nil || n <= 0 {
		return "", 0, fmt.Errorf("%w: pull request number in %q", ErrInvalidArgument, s)
	}
	return m[1] + "/" + m[2], n, nil
}

// pullRequestURL is a pull request's canonical GitHub URL, as Claude's pr-link records
// and the GitHub store have it.
func pullRequestURL(slug string, number int) string {
	return "https://github.com/" + slug + "/pull/" + strconv.Itoa(number)
}
