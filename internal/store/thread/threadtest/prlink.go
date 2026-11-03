package threadtest

import (
	"context"
	"fmt"
	"slices"
	"strconv"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// LinkPullRequest records "LinkPullRequest <id> <ref>" and links the pull request by
// hand like the store (thread.ParsePullRequestLink, deduplicated by URL ignoring case,
// LinkedAt Now). A known URL changes nothing and publishes nothing. No propagation up
// the CreatedBy chain.
func (f *Fake) LinkPullRequest(_ context.Context, id, ref string) (thread.Thread, thread.LinkedPullRequest, bool, error) {
	f.mu.Lock()
	if err := f.record(fmt.Sprintf("LinkPullRequest %s %s", id, strings.TrimSpace(ref))); err != nil {
		f.mu.Unlock()
		return thread.Thread{}, thread.LinkedPullRequest{}, false, err
	}
	slug, n, err := thread.ParsePullRequestLink(ref)
	var s thread.Thread
	if err == nil {
		s, err = f.get(id)
	}
	if err != nil {
		f.mu.Unlock()
		return thread.Thread{}, thread.LinkedPullRequest{}, false, err
	}
	l := thread.LinkedPullRequest{Slug: slug, Number: n, URL: "https://github.com/" + slug + "/pull/" + strconv.Itoa(n), Source: thread.LinkManual}
	if i := slices.IndexFunc(s.LinkedPullRequests, func(x thread.LinkedPullRequest) bool { return strings.EqualFold(x.URL, l.URL) }); i >= 0 {
		f.mu.Unlock()
		return s, s.LinkedPullRequests[i], false, nil
	}
	l.LinkedAt = f.Now()
	s.LinkedPullRequests = append(slices.Clip(s.LinkedPullRequests), l)
	f.byID[id] = s
	f.rebuild()
	f.mu.Unlock()
	bus.Publish[thread.Event](f.bus, thread.Updated{Thread: s})
	return s, l, true, nil
}
