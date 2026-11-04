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
// them, not asking for their review, not reviewed by them) and were updated within
// projectOpenWindow (an abandoned one drops off), and every pull request
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

// projectOpenWindow is how recently an open pull request in the project-wide list was
// updated: the Pull Requests page says "updated in the last month".
const projectOpenWindow = 30 * 24 * time.Hour

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
	// WebQuery is the same search in github.com's syntax (webRepos), for SearchURL.
	WebQuery string `json:"webQuery,omitempty"`
}

// SearchURL is the list's search on github.com ("" when there is no query).
func (l ProjectList) SearchURL() string {
	if l.WebQuery == "" {
		return ""
	}
	return "https://github.com/search?q=" + url.QueryEscape(l.WebQuery) + "&type=pullrequests"
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
	since := now.Add(-recentlyMergedWindow).Format(searchTimeLayout)
	updated := now.Add(-projectOpenWindow).Format(searchTimeLayout)
	open := func(repos string) string {
		return "is:pr is:open archived:false updated:>=" + updated + " " + repos + " -author:" + login + " -reviewed-by:" + login +
			" -review-requested:" + login + " sort:updated-desc"
	}
	merged := func(repos string) string {
		return "is:pr is:merged merged:>=" + since + " " + repos + " sort:updated-desc"
	}
	api, web := apiRepos(slugs), webRepos(slugs)
	return []searchSection{
		{name: sectionProjectOpen, typ: "ISSUE", first: searchFirstProjectOpen, checks: true, query: open(api), webQuery: open(web)},
		{name: sectionProjectMerged, typ: "ISSUE", first: searchFirstProjectMerged, query: merged(api), webQuery: merged(web)},
	}
}

// apiRepos is the repository part of a type ISSUE search: repeated repo: qualifiers,
// which it ORs.
func apiRepos(slugs []string) string { return strings.Join(repoQualifiers(slugs), " ") }

// webRepos is the repository part of the same search on github.com, whose search
// (like ISSUE_ADVANCED) ANDs repeated repo: qualifiers: an explicit OR group, or the
// one qualifier.
func webRepos(slugs []string) string {
	if len(slugs) == 1 {
		return "repo:" + slugs[0]
	}
	return "(" + strings.Join(repoQualifiers(slugs), " OR ") + ")"
}

func repoQualifiers(slugs []string) []string {
	out := make([]string, len(slugs))
	for i, slug := range slugs {
		out[i] = "repo:" + slug
	}
	return out
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
	// This cycle's own request may have brought a pause on: the lists wait for the next
	// poll, which waits it out, and stay what they were.
	s.mu.Lock()
	paused := s.opts.Now().Before(s.pauseUntil)
	s.mu.Unlock()
	if paused {
		return
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
	if isRefused(err) {
		return // a job let in just now brought the pause on: as above
	}
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
	// The pull requests the dashboards and branch lists hold were resolved by this
	// cycle's poll, which owns their mergeability rechecks: here they are refetched only
	// when the fingerprint says so, and a fetch leaves their recheck counts alone, so the
	// two copies cannot settle apart (one refetched, the other left UNKNOWN).
	held := map[string]int{}
	for id := range known {
		held[id] = s.recheck[id]
	}
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
		k, ok := known[f.ID]
		if _, dash := held[f.ID]; dash && fingerprintNeedsDetail(k, ok, f) || !dash && s.needsDetail(k, ok, f) {
			need = append(need, f)
		}
	}
	fetched, detailErr := s.fetchDetails(ctx, need)
	if ctx.Err() != nil {
		return
	}
	for _, f := range need {
		if n, dash := held[f.ID]; dash && n > 0 {
			s.recheck[f.ID] = n
		} else if dash {
			delete(s.recheck, f.ID)
		}
	}
	if isRefused(detailErr) {
		return // the same, between the lists and their details
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
		sec := plan.section(x.name)
		*x.list = ProjectList{PullRequests: resolveFingerprints(r.PRs, fetched, known), Total: r.Total, Query: sec.query, WebQuery: sec.webQuery}
	}
	if detailErr != nil {
		errs = append(errs, "pull request details: "+detailErr.Error())
	}
	next.LastError = strings.Join(errs, "; ")
	s.setProjects(ctx, next)
}

// projectsFetchedRow is the "projects_fetched" row, written every cycle (the full
// "projects" row only on a change): what moves without the lists changing, so a
// restart shows the last fetch's time and its updated:>= and merged:>= windows.
type projectsFetchedRow struct {
	FetchedAt time.Time   `json:"fetchedAt"`
	Open      ProjectList `json:"open"`   // queries only; empty in rows written before it had a window
	Merged    ProjectList `json:"merged"` // queries only
}

// apply moves p's fetch time and queries to the row's when it is newer.
func (r projectsFetchedRow) apply(p *ProjectPullRequests) {
	if p.FetchedAt.IsZero() || !r.FetchedAt.After(p.FetchedAt) {
		return
	}
	p.FetchedAt = r.FetchedAt
	if r.Open.Query != "" {
		p.Open.Query, p.Open.WebQuery = r.Open.Query, r.Open.WebQuery
	}
	if r.Merged.Query != "" {
		p.Merged.Query, p.Merged.WebQuery = r.Merged.Query, r.Merged.WebQuery
	}
}

// queriesOnly is l without its results: the part of a list that moves with the clock.
func queriesOnly(l ProjectList) ProjectList { return ProjectList{Query: l.Query, WebQuery: l.WebQuery} }

// setProjects stores the project lists and their fetch time; on a change it writes the
// lists and publishes DashboardUpdated.
func (s *Store) setProjects(ctx context.Context, next ProjectPullRequests) {
	var changed, moved bool
	s.updateSnapshot(func(n *Snapshot) {
		changed = !sameProjects(n.Projects, next)
		moved = !n.Projects.FetchedAt.Equal(next.FetchedAt)
		n.Projects = next
	})
	if changed {
		if err := s.cache.saveActivity(ctx, activityProjects, next.FetchedAt, next); err != nil {
			s.log.Warn("gh cache write failed", "err", err)
		}
	}
	if changed || moved {
		row := projectsFetchedRow{FetchedAt: next.FetchedAt, Open: queriesOnly(next.Open), Merged: queriesOnly(next.Merged)}
		if err := s.cache.saveActivity(ctx, activityProjectsFetched, next.FetchedAt, row); err != nil {
			s.log.Warn("gh cache write failed", "err", err)
		}
	}
	if changed {
		publish(s, DashboardUpdated{FetchedAt: s.Snapshot().Dashboard.FetchedAt})
	}
}

// sameProjects compares everything clients see except the fetch time and the searches'
// queries, whose updated:>= and merged:>= move with every fetch.
func sameProjects(a, b ProjectPullRequests) bool {
	a.FetchedAt, b.FetchedAt = time.Time{}, time.Time{}
	a.Open.Query, b.Open.Query, a.Open.WebQuery, b.Open.WebQuery = "", "", "", ""
	a.Merged.Query, b.Merged.Query, a.Merged.WebQuery, b.Merged.WebQuery = "", "", "", ""
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
