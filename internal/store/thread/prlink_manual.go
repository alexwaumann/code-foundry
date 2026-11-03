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
// merged like every other link (LinkManual): deduplicated by URL, first source wins (a
// pull request the thread already has keeps its row and source), copied up the
// CreatedBy chain, and never removed (there is no unlink).

// LinkPullRequest links the pull request ref names (a GitHub pull request URL or
// "owner/name#123") to thread id by hand. It returns the thread, the link as the thread
// has it, and whether it was new: a pull request the thread already has (its URL
// compared case-insensitively) is a quiet success that changes nothing. Any state.
// ErrInvalidArgument for anything that is not a GitHub pull request.
func (m *Manager) LinkPullRequest(_ context.Context, id, ref string) (Thread, LinkedPullRequest, bool, error) {
	slug, number, err := ParsePullRequestLink(ref)
	if err != nil {
		return Thread{}, LinkedPullRequest{}, false, err
	}
	l := LinkedPullRequest{Slug: slug, Number: number, URL: pullRequestURL(slug, number), Source: LinkManual}
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, err := m.record(id)
	if err != nil {
		return Thread{}, LinkedPullRequest{}, false, err
	}
	if i := slices.IndexFunc(rec.s.LinkedPullRequests, func(x LinkedPullRequest) bool { return strings.EqualFold(x.URL, l.URL) }); i >= 0 {
		return rec.s, rec.s.LinkedPullRequests[i], false, nil
	}
	l.LinkedAt = m.opts.Now()
	added := m.addLinksLocked(rec, []LinkedPullRequest{l})
	m.propagateLinksLocked(id, added)
	m.log.Info("pull request linked by hand", "thread", id, "pr", l.URL)
	return rec.s, l, true, nil
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
