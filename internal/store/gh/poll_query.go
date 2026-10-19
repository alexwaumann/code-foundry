package gh

import (
	"fmt"
	"strings"
	"time"
)

// The poll is one GraphQL document built per cycle: the parts depend on what is tracked,
// watched, and due. Every string that comes from outside (search queries, owners, names,
// branches, ids, times) is a variable; only our own constants (search types, sizes) are
// written into the text. Aliases: s_<section> for searches, r<i> for repositories with
// b<j> for watched branches inside; for the stats (k indexes the plan's months, newest
// first) m<k> global merged counts, r<i>_m<k> per-repository merged counts,
// contributions { c<k> }, and history { h<k> } inside r<i>. The poll carries the
// current month; the closed months go in their own PollStats documents (statsOnly).

// Search sections of the poll, in dashboard order.
const (
	sectionAuthored = "authored"
	sectionReview   = "review"
	sectionReviewed = "reviewed"
	sectionMerged   = "merged"
)

// Search sizes. The fingerprint costs ~11ms of server time per PR plus ~0.4s per search
// (measured 2026-10 on a busy account: 4 searches, 98 PRs, 2.9-3.5s). A 502/504 halves
// every section (sticky, floor minSearchFirst).
const (
	searchFirstOpen   = 50
	searchFirstMerged = 50
	minSearchFirst    = 10
	// branchFirst is how many pull requests per watched branch the poll lists (every
	// author, forks included; the store keeps the viewer's). It is 25, not 10, so a
	// branch name reused by many people (or a watched default branch) still leaves room
	// for the viewer's own pull requests; the fingerprint is cheap (~11ms per PR).
	branchFirst = 25
	// closedReposPerRequest caps the repositories in one closed-month stats request.
	// Each repository's five closed months are five first: 0 searches (~115ms of
	// server time each, serially) and five history counts (~85ms): about 1s, so four
	// plus the global months stay near 5s, well inside GitHub's ~10s budget (measured
	// 2026-10: 66 searches took 7.6s; 6 months of 10 repositories timed out at 11s).
	closedReposPerRequest = 4
)

// searchSection is one dashboard search.
type searchSection struct {
	name  string
	query string
	typ   string // SearchType: ISSUE, or ISSUE_ADVANCED for OR and parentheses
	first int
	// checks selects the check fingerprint (open lists); merged PRs need only identity.
	checks bool
}

// dashboardSections builds the searches for login (@me or a login) at now.
func dashboardSections(login string, now time.Time) []searchSection {
	since := now.Add(-recentlyMergedWindow).Format(searchTimeLayout)
	open := "is:pr is:open archived:false "
	return []searchSection{
		{name: sectionAuthored, typ: "ISSUE", first: searchFirstOpen, checks: true,
			query: open + "author:" + login + " sort:updated-desc"},
		{name: sectionReview, typ: "ISSUE", first: searchFirstOpen, checks: true,
			query: open + "review-requested:" + login + " sort:updated-desc"},
		{name: sectionReviewed, typ: "ISSUE", first: searchFirstOpen, checks: true,
			query: open + "reviewed-by:" + login + " -author:" + login + " sort:updated-desc"},
		{name: sectionMerged, typ: "ISSUE_ADVANCED", first: searchFirstMerged,
			query: fmt.Sprintf("is:pr is:merged merged:>=%s (author:%[2]s OR reviewed-by:%[2]s OR assignee:%[2]s) sort:updated-desc", since, login)},
	}
}

// repoPlan is one repository block of the poll.
type repoPlan struct {
	slug string
	// defaultBranch selects the default branch fingerprint (tracked repositories).
	defaultBranch bool
	// branches are watched head branches, in alias order (b0, b1, ...).
	branches []string
	// keep are the watched pull requests' numbers (WatchPullRequests): their branch
	// lists keep them whoever wrote them.
	keep []int
	// months selects this repository's stats (stats due, tracked): the viewer's merged
	// pull requests and default-branch commits in each month, newest first (the current
	// month in the poll, the closed ones in a statsOnly plan).
	months []monthWindow
}

// statsPlan is the monthly stats part of the poll, included when due.
type statsPlan struct {
	// all are the statsMonths windows, newest first.
	all []monthWindow
	// months are the global months asked for, newest first: the current month in the
	// poll, the closed ones (or none) in a statsOnly plan. Each repository has its own
	// (repoPlan.months).
	months []monthWindow
	// login is whose contributions are counted; author is its node id (history).
	login, author string
	// me is @me or SearchAs, for the searches.
	me string
}

// mergedQuery counts the viewer's pull requests merged in w; repo ("owner/name")
// narrows it to one repository.
func (st *statsPlan) mergedQuery(w monthWindow, repo string) string {
	q := fmt.Sprintf("is:pr is:merged author:%s merged:%s", st.me, w.searchRange())
	if repo != "" {
		q = "repo:" + repo + " " + q
	}
	return q
}

// closedPlans splits the closed months that are due into statsOnly requests of at
// most closedReposPerRequest repositories each; the first also carries the global
// closed months when they are due.
func closedPlans(st *statsPlan, global bool, repos []repoPlan) []*pollPlan {
	var out []*pollPlan
	for len(repos) > 0 || global {
		n := min(closedReposPerRequest, len(repos))
		cs := *st
		cs.months = nil
		if global {
			cs.months = st.all[1:]
		}
		out = append(out, &pollPlan{statsOnly: true, stats: &cs, repos: repos[:n:n]})
		repos, global = repos[n:], false
	}
	return out
}

func monthAlias(k int) string { return fmt.Sprintf("m%d", k) }

// repoMergedAlias is the top-level alias of plan.repos[i]'s merged count in month k.
func repoMergedAlias(i, k int) string { return fmt.Sprintf("%s_m%d", repoAlias(i), k) }

// pollPlan is everything one poll asks for.
type pollPlan struct {
	sections []searchSection
	repos    []repoPlan
	stats    *statsPlan
	// searchAs asks for SearchAs's node id (Options.SearchAs, until known).
	searchAs string
	// statsDeferred is set when the stats are due but wait for the author's node id,
	// which this poll learns: the next poll follows right away.
	statsDeferred bool
	// closed are the closed-month stats requests (statsOnly plans) that follow this
	// poll when those months are due; the poll itself carries the current month only.
	closed []*pollPlan
	// statsOnly names the document PollStats: a closed-month stats request.
	statsOnly bool
}

// repoAlias is the alias of plan.repos[i].
func repoAlias(i int) string { return fmt.Sprintf("r%d", i) }

// branchAlias is the alias of repos[i].branches[j] inside its repository block.
func branchAlias(j int) string { return fmt.Sprintf("b%d", j) }

func sectionAlias(name string) string { return "s_" + name }

// build returns the poll document and its variables.
func (p *pollPlan) build() (string, map[string]any, error) {
	var (
		decls []string
		body  strings.Builder
		vars  = map[string]any{}
	)
	declare := func(name, typ string, v any) string {
		decls = append(decls, "$"+name+": "+typ)
		vars[name] = v
		return "$" + name
	}
	body.WriteString("  rateLimit { ...RateLimitFields }\n  viewer { ...ViewerFields }\n")
	if p.searchAs != "" {
		fmt.Fprintf(&body, "  searchAs: user(login: %s) { id login }\n", declare("searchAs", "String!", p.searchAs))
	}
	for _, sec := range p.sections {
		frag := "PullRequestIdentity"
		if sec.checks {
			frag = "PullRequestFingerprint"
		}
		fmt.Fprintf(&body, "  %s: search(query: %s, type: %s, first: %d) { issueCount nodes { __typename ...%s } }\n",
			sectionAlias(sec.name), declare("q_"+sec.name, "String!", sec.query), sec.typ, sec.first, frag)
	}
	// History windows are shared by every repository that asks for them.
	var since, until []string
	if p.stats != nil && p.stats.author != "" {
		var deep []monthWindow
		for _, r := range p.repos {
			if len(r.months) > len(deep) {
				deep = r.months
			}
		}
		if len(deep) > 0 {
			declare("author", "ID!", p.stats.author)
		}
		for k, w := range deep {
			since = append(since, declare(fmt.Sprintf("h%ds", k), "GitTimestamp!", w.Start.Format(time.RFC3339)))
			if w.Label == p.stats.all[0].Label {
				until = append(until, "") // the current month runs to now
			} else {
				until = append(until, declare(fmt.Sprintf("h%du", k), "GitTimestamp!", w.next().Format(time.RFC3339)))
			}
		}
	}
	for i, r := range p.repos {
		a := repoAlias(i)
		owner, name := splitSlug(r.slug)
		fmt.Fprintf(&body, "  %s: repository(owner: %s, name: %s) {\n", a, declare(a+"o", "String!", owner), declare(a+"n", "String!", name))
		if r.defaultBranch {
			body.WriteString("    ...DefaultBranchFingerprint\n")
		}
		for j, head := range r.branches {
			fmt.Fprintf(&body, "    %s: pullRequests(headRefName: %s, first: %d, states: [OPEN, MERGED, CLOSED], orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ...PullRequestFingerprint } }\n",
				branchAlias(j), declare(a+branchAlias(j), "String!", head), branchFirst)
		}
		if len(r.months) > 0 && len(since) > 0 {
			body.WriteString("    history: defaultBranchRef { target { ... on Commit {")
			for k := range r.months {
				if until[k] == "" {
					fmt.Fprintf(&body, " h%d: history(author: {id: $author}, since: %s) { totalCount }", k, since[k])
				} else {
					fmt.Fprintf(&body, " h%d: history(author: {id: $author}, since: %s, until: %s) { totalCount }", k, since[k], until[k])
				}
			}
			body.WriteString(" } } }\n")
		}
		body.WriteString("  }\n")
	}
	if st := p.stats; st != nil {
		for k, w := range st.months {
			fmt.Fprintf(&body, "  %s: search(query: %s, type: ISSUE, first: 0) { issueCount }\n", monthAlias(k), declare(monthAlias(k), "String!", st.mergedQuery(w, "")))
		}
		for i, r := range p.repos {
			for k, w := range r.months {
				a := repoMergedAlias(i, k)
				fmt.Fprintf(&body, "  %s: search(query: %s, type: ISSUE, first: 0) { issueCount }\n", a, declare(a, "String!", st.mergedQuery(w, r.slug)))
			}
		}
		if st.login != "" && len(st.months) > 0 {
			fmt.Fprintf(&body, "  contributions: user(login: %s) {", declare("statsLogin", "String!", st.login))
			for k, w := range st.months {
				fmt.Fprintf(&body, " c%d: contributionsCollection(from: %s, to: %s) { totalCommitContributions }", k,
					declare(fmt.Sprintf("c%df", k), "DateTime!", w.Start.Format(time.RFC3339)), declare(fmt.Sprintf("c%dt", k), "DateTime!", w.End.Format(time.RFC3339)))
			}
			body.WriteString(" }\n")
		}
	}
	head := "query Poll"
	if p.statsOnly {
		head = "query PollStats"
	}
	if len(decls) > 0 {
		head += "(" + strings.Join(decls, ", ") + ")"
	}
	doc, err := assemble(head + " {\n" + body.String() + "}")
	return doc, vars, err
}

// summary describes the plan for the debug log.
func (p *pollPlan) summary() []any {
	branches := 0
	tracked := 0
	for _, r := range p.repos {
		branches += len(r.branches)
		if r.defaultBranch {
			tracked++
		}
	}
	out := []any{"searches", len(p.sections), "default_branches", tracked, "branches", branches, "stats", p.stats != nil}
	if p.stats != nil {
		aliases := len(p.stats.months)
		for _, r := range p.repos {
			aliases += len(r.months)
		}
		out = append(out, "stats_months", len(p.stats.months), "stats_merged_searches", aliases, "stats_closed_requests", len(p.closed))
	}
	return out
}

// ciRequest asks for the first page of a default branch head's checks.
type ciRequest struct {
	slug, sha string
}

// defaultBranchChecksDoc builds one request for the first page of checks of several
// default branch heads (aliased r<i>, in reqs order).
func defaultBranchChecksDoc(reqs []ciRequest) (string, map[string]any, error) {
	var (
		decls []string
		body  strings.Builder
		vars  = map[string]any{}
	)
	declare := func(name, typ string, v any) string {
		decls = append(decls, "$"+name+": "+typ)
		vars[name] = v
		return "$" + name
	}
	body.WriteString("  rateLimit { ...RateLimitFields }\n")
	for i, r := range reqs {
		a := repoAlias(i)
		owner, name := splitSlug(r.slug)
		fmt.Fprintf(&body, "  %s: repository(owner: %s, name: %s) { object(oid: %s) { ... on Commit { oid statusCheckRollup { state contexts(first: 100) { ...CheckContexts } } } } }\n",
			a, declare(a+"o", "String!", owner), declare(a+"n", "String!", name), declare(a+"s", "GitObjectID!", r.sha))
	}
	doc, err := assemble("query DefaultBranchChecks(" + strings.Join(decls, ", ") + ") {\n" + body.String() + "}")
	return doc, vars, err
}
