package daemon

import (
	"context"
	"slices"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/store/gh"
	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// Settling old branch links (docs/notes/linked-prs-default-branch.md). Branch links made
// before the default branch was left out, and before each link recorded the head it
// matched, have no Head. Each is settled once: dropped (with its copies up the
// CreatedBy chain) when its pull request's head is its project's default branch, else
// given its head. The head comes from the GitHub store's cached lists when they have
// the pull request, else from one read of it (its cached detail when fresh) per daemon
// run; a read that fails is tried again on the next start.

// prHead is what settling needs of a pull request.
type prHead struct {
	head  string
	cross bool // from a fork: its head is another repository's branch
}

// unsettledLink is a branch link without a head.
type unsettledLink struct {
	thread string
	url    string
	ref    gh.PullRequestRef
}

// unsettledBranchLinks is every branch link without a Head, archived threads included,
// in snapshot order.
func unsettledBranchLinks(threads *thread.Snapshot) []unsettledLink {
	var out []unsettledLink
	if threads == nil {
		return out
	}
	for _, th := range threads.Threads {
		for _, l := range th.LinkedPullRequests {
			if l.Source == thread.LinkBranch && l.Head == "" && l.Number > 0 {
				out = append(out, unsettledLink{th.ID, l.URL, gh.PullRequestRef{Slug: strings.ToLower(l.Slug), Number: l.Number}})
			}
		}
	}
	return out
}

// headsByRef indexes the cached pull requests' heads (placeholders have none).
func headsByRef(prs []gh.PullRequest) map[gh.PullRequestRef]prHead {
	out := map[gh.PullRequestRef]prHead{}
	for _, p := range prs {
		if p.HeadRef == "" || p.Number <= 0 || p.Repo == "" {
			continue
		}
		out[gh.PullRequestRef{Slug: strings.ToLower(p.Repo), Number: p.Number}] = prHead{p.HeadRef, p.IsCrossRepository}
	}
	return out
}

// defaultBranchOf is the default branch of the project with GitHub slug (any case);
// known is false while a project with that slug has none yet (not reconciled since the
// start). No such project: "", true (nothing to compare with; the link keeps its head).
func defaultBranchOf(projects *project.Snapshot, slug string) (branch string, known bool) {
	if projects == nil {
		return "", false
	}
	found := false
	for _, p := range projects.Projects {
		if !strings.EqualFold(p.GitHubSlug, slug) {
			continue
		}
		if p.DefaultBranch != "" {
			return p.DefaultBranch, true
		}
		found = true
	}
	return "", !found
}

// settlement is what to do with one thread's unsettled links.
type settlement struct {
	heads map[string]string // url to head
	drop  []string
}

// settleBranchLinks decides every unsettled link it can: known is the heads read so
// far, missing the refs of links whose head is not known (to read). A link whose
// project has no default branch yet waits. Threads come in snapshot order.
func settleBranchLinks(links []unsettledLink, projects *project.Snapshot,
	known map[gh.PullRequestRef]prHead) (ids []string, out map[string]*settlement, missing []gh.PullRequestRef) {
	out = map[string]*settlement{}
	for _, l := range links {
		h, ok := known[l.ref]
		if !ok {
			if !slices.Contains(missing, l.ref) {
				missing = append(missing, l.ref)
			}
			continue
		}
		def, defKnown := defaultBranchOf(projects, l.ref.Slug)
		if !defKnown {
			continue
		}
		s := out[l.thread]
		if s == nil {
			s = &settlement{heads: map[string]string{}}
			out[l.thread] = s
			ids = append(ids, l.thread)
		}
		if !h.cross && h.head == def {
			s.drop = append(s.drop, l.url)
		} else {
			s.heads[l.url] = h.head
		}
	}
	return ids, out, missing
}

// branchLinkSettler keeps the heads read during this daemon run and which pull
// requests were asked for, so each is read at most once.
type branchLinkSettler struct {
	read  map[gh.PullRequestRef]prHead
	asked map[gh.PullRequestRef]bool
}

func newBranchLinkSettler() *branchLinkSettler {
	return &branchLinkSettler{read: map[gh.PullRequestRef]prHead{}, asked: map[gh.PullRequestRef]bool{}}
}

// pass settles what it can and returns how many links it dropped (copies included)
// and the pull requests to read, never asked for before.
func (s *branchLinkSettler) pass(threads branchLinker, projects *project.Snapshot, cached []gh.PullRequest) (dropped int, toRead []gh.PullRequestRef) {
	links := unsettledBranchLinks(threads.Snapshot())
	if len(links) == 0 {
		return 0, nil
	}
	known := headsByRef(cached)
	for r, h := range s.read {
		known[r] = h
	}
	ids, out, missing := settleBranchLinks(links, projects, known)
	for _, id := range ids {
		dropped += threads.SettleBranchLinks(id, out[id].heads, out[id].drop)
	}
	for _, r := range missing {
		if !s.asked[r] {
			s.asked[r] = true
			toRead = append(toRead, r)
		}
	}
	return dropped, toRead
}

// readHeads reads each pull request in refs, one at a time, and sends what it learned.
// A failed read sends nothing.
func readHeads(ctx context.Context, prs branchPRCache, refs []gh.PullRequestRef, out chan<- map[gh.PullRequestRef]prHead) {
	got := map[gh.PullRequestRef]prHead{}
	for _, r := range refs {
		d, err := prs.PullRequest(ctx, r.Slug, r.Number)
		if ctx.Err() != nil {
			return
		}
		if err != nil || d.PullRequest.HeadRef == "" {
			continue
		}
		got[r] = prHead{d.PullRequest.HeadRef, d.PullRequest.IsCrossRepository}
	}
	select {
	case out <- got:
	case <-ctx.Done():
	}
}

// merge adds heads just read.
func (s *branchLinkSettler) merge(got map[gh.PullRequestRef]prHead) {
	for r, h := range got {
		s.read[r] = h
	}
}
