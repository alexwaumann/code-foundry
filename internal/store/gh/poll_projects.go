package gh

import (
	"context"
	"errors"
	"maps"
	"net/url"
	"slices"
	"strings"
	"time"
)

// Project-wide pull request lists for the Pull Requests page: the open pull requests in
// the tracked repositories that are none of the viewer's business (not authored by
// them, not asking for their review, not reviewed by them), and every pull request
// merged in them within recentlyMergedWindow. One search each across every tracked
// repository, in a request of its own (PollProjects) that follows the dashboard poll in
// the same cycle, so it runs on the same pacer tiers. Details come through the poll's
// fingerprint and detail flow.
//
// The lists are awareness only and feed nothing else: no PullRequestChanged events, no
// wake matching, no needs-review count, no linked or branch pull requests, no stats.
// They live in Snapshot.Projects, apart from the Dashboard every other reader uses.

// Search sections of the projects request.
const (
	sectionProjectOpen   = "project_open"
	sectionProjectMerged = "project_merged"
)

// Project search sizes (a 502/504 halves them like the dashboard's; see shrinkSearches).
const (
	searchFirstProjectOpen   = 50
	searchFirstProjectMerged = 50
)

// ProjectList is one project-wide search's result.
type ProjectList struct {
	// PullRequests are the first matches, most recently updated first.
	PullRequests []PullRequest `json:"pullRequests"`
	// Total is GitHub's issueCount: exact, even when PullRequests is capped.
	Total int `json:"total"`
	// Query is the search that produced the list ("" before the first fetch).
	Query string `json:"query,omitempty"`
}

// SearchURL is the list's search on github.com ("" when there is no query).
func (l ProjectList) SearchURL() string {
	if l.Query == "" {
		return ""
	}
	return "https://github.com/search?q=" + url.QueryEscape(l.Query) + "&type=pullrequests"
}

// ProjectPullRequests are the project-wide lists. Both are empty while nothing is
// tracked or github.dashboards_enabled is off (FetchedAt is then zero).
type ProjectPullRequests struct {
	// Open: open pull requests in tracked repositories that the viewer did not author,
	// is not asked to review, and has not reviewed.
	Open ProjectList `json:"open"`
	// Merged: every pull request merged in a tracked repository in the last 7 days.
	Merged ProjectList `json:"merged"`
	// FetchedAt is when the lists were last fetched successfully.
	FetchedAt time.Time `json:"fetchedAt"`
	// LastError is the last fetch's error (the lists are then the last good ones).
	LastError string `json:"-"`
}

// projectSections builds the project-wide searches over slugs (sorted "owner/name") for
// login (@me or a login) at now; nil when there are none. Search type ISSUE ORs repeated
// repo: qualifiers (ISSUE_ADVANCED ANDs them and finds nothing), and its negated
// qualifiers are filters, not boolean operators.
func projectSections(login string, slugs []string, now time.Time) []searchSection {
	if len(slugs) == 0 {
		return nil
	}
	var repos strings.Builder
	for _, slug := range slugs {
		repos.WriteString("repo:" + slug + " ")
	}
	since := now.Add(-recentlyMergedWindow).Format(searchTimeLayout)
	return []searchSection{
		{name: sectionProjectOpen, typ: "ISSUE", first: searchFirstProjectOpen, checks: true,
			query: "is:pr is:open archived:false " + repos.String() +
				"-author:" + login + " -reviewed-by:" + login + " -review-requested:" + login + " sort:updated-desc"},
		{name: sectionProjectMerged, typ: "ISSUE", first: searchFirstProjectMerged,
			query: "is:pr is:merged merged:>=" + since + " " + repos.String() + "sort:updated-desc"},
	}
}

// projectSlugs are the tracked repositories as GitHub names them now (a renamed one's
// CanonicalSlug: search does not follow renames), sorted and unique.
func (s *Store) projectSlugs() []string {
	s.mu.Lock()
	tracked := slices.Collect(maps.Keys(s.tracked))
	s.mu.Unlock()
	snap := s.Snapshot()
	seen := map[string]bool{}
	for _, slug := range tracked {
		if c := snap.Repos[slug].CanonicalSlug; c != "" {
			slug = c
		}
		seen[slug] = true
	}
	return slices.Sorted(maps.Keys(seen))
}

// pollProjects refreshes Snapshot.Projects: the poll calls it after its own request,
// before Polled. DashboardUpdated goes out when the lists, totals, queries or error
// changed (not for the fetch time alone; Polled carries it).
func (s *Store) pollProjects(ctx context.Context, cfg Config) {
	var slugs []string
	if cfg.Dashboards {
		slugs = s.projectSlugs()
	}
	plan := pollPlan{projects: true, sections: projectSections(s.searchLogin(), slugs, s.opts.Now())}
	if len(plan.sections) == 0 {
		s.setProjects(ctx, ProjectPullRequests{})
		return
	}
	for i := range plan.sections {
		if n := s.searchFirst[plan.sections[i].name]; n > 0 {
			plan.sections[i].first = n
		}
	}
	prev := s.Snapshot().Projects
	failed := func(err error) {
		if ctx.Err() != nil {
			return
		}
		s.log.Warn("gh project pull requests failed", "err", err)
		next := prev
		next.LastError = err.Error()
		s.setProjects(ctx, next)
	}
	doc, vars, err := plan.build()
	if err != nil {
		failed(err)
		return
	}
	data, err := s.callDoc(ctx, queryPollProjects, doc, vars)
	var partial *PartialError
	if err != nil && !errors.As(err, &partial) {
		if isServerTimeout(err) {
			s.shrinkSearches(&plan) // the next cycle asks for less
		}
		failed(err)
		return
	}
	res, err := decodePoll(&plan, data, partial)
	if err != nil {
		failed(err)
		return
	}

	// Details through the poll's flow: what the dashboards, the branches and the last
	// project lists hold is reused while its fingerprint holds.
	known := knownPullRequests(s.Snapshot().Dashboard, &s.branches)
	for _, l := range []ProjectList{prev.Open, prev.Merged} {
		for _, p := range l.PullRequests {
			if _, ok := known[p.ID]; !ok && p.ID != "" {
				known[p.ID] = p
			}
		}
	}
	var fps, need []prFingerprint
	seen := map[string]bool{}
	for _, sec := range plan.sections {
		for _, f := range res.Sections[sec.name].PRs {
			if !seen[f.ID] {
				seen[f.ID] = true
				fps = append(fps, f)
			}
		}
	}
	s.staleFullDetails(fps)
	s.markMovedDetails(fps, known)
	for _, f := range fps {
		if k, ok := known[f.ID]; s.needsDetail(k, ok, f) {
			need = append(need, f)
		}
	}
	fetched, detailErr := s.fetchDetails(ctx, need)
	if ctx.Err() != nil {
		return
	}

	next := prev
	next.FetchedAt = s.opts.Now()
	var errs []string
	for _, x := range []struct {
		name string
		list *ProjectList
	}{{sectionProjectOpen, &next.Open}, {sectionProjectMerged, &next.Merged}} {
		r := res.Sections[x.name]
		if r.Err != nil {
			errs = append(errs, x.name+": "+r.Err.Error())
			continue // keep the last good list
		}
		*x.list = ProjectList{PullRequests: resolveFingerprints(r.PRs, fetched, known), Total: r.Total, Query: plan.section(x.name).query}
	}
	if detailErr != nil {
		errs = append(errs, "pull request details: "+detailErr.Error())
	}
	next.LastError = strings.Join(errs, "; ")
	s.setProjects(ctx, next)
}

// setProjects stores the project lists; on a change it writes the cache and publishes
// DashboardUpdated.
func (s *Store) setProjects(ctx context.Context, next ProjectPullRequests) {
	var changed bool
	s.updateSnapshot(func(n *Snapshot) {
		changed = !sameProjects(n.Projects, next)
		n.Projects = next
	})
	if !changed {
		return
	}
	if err := s.cache.saveActivity(ctx, activityProjects, next.FetchedAt, next); err != nil {
		s.log.Warn("gh cache write failed", "err", err)
	}
	publish(s, DashboardUpdated{FetchedAt: s.Snapshot().Dashboard.FetchedAt})
}

// sameProjects compares everything clients see except the fetch time and the merged
// search's query, whose merged:>= moves with every fetch.
func sameProjects(a, b ProjectPullRequests) bool {
	a.FetchedAt, b.FetchedAt = time.Time{}, time.Time{}
	a.Merged.Query, b.Merged.Query = "", ""
	return a.LastError == b.LastError && sameJSON(a, b)
}

// polled is the Polled event for a poll with fetchedAt and lastErr, with the project
// lists' fetch state.
func (s *Store) polled(fetchedAt time.Time, lastErr string) Polled {
	p := s.Snapshot().Projects
	return Polled{FetchedAt: fetchedAt, LastError: lastErr, ProjectsFetchedAt: p.FetchedAt, ProjectsLastError: p.LastError}
}

// projectIDs are the node ids the project lists hold.
func projectIDs(p ProjectPullRequests) map[string]bool {
	out := map[string]bool{}
	for _, l := range []ProjectList{p.Open, p.Merged} {
		for _, pr := range l.PullRequests {
			out[pr.ID] = true
		}
	}
	return out
}

// section returns the plan's section named name (zero when missing).
func (p *pollPlan) section(name string) searchSection {
	for _, sec := range p.sections {
		if sec.name == name {
			return sec
		}
	}
	return searchSection{}
}

// resolveFingerprints maps fingerprints to pull requests: fetched details first, then
// the known copy (with the fingerprint's checks when it carried them), else a
// placeholder.
func resolveFingerprints(list []prFingerprint, fetched, known map[string]PullRequest) []PullRequest {
	out := make([]PullRequest, 0, len(list))
	for _, f := range list {
		if d, ok := fetched[f.ID]; ok {
			out = append(out, d)
			continue
		}
		k, ok := known[f.ID]
		if !ok {
			out = append(out, f.placeholder())
			continue
		}
		if f.HasChecks {
			k.Checks = f.Checks
		}
		out = append(out, k)
	}
	return out
}
