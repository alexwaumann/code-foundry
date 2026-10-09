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
// b<j> for watched branches inside, and fixed names for the stats.

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
	// author, forks included; the store keeps the viewer's).
	branchFirst = 10
	// mergedStatsFirst caps the merged pull requests listed for per-repository merged
	// counts (two months). Beyond it, per-repository counts are lower bounds.
	mergedStatsFirst = 100
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
	// history selects the viewer's commit counts on the default branch (stats due).
	history bool
}

// statsPlan is the monthly stats part of the poll, included when due.
type statsPlan struct {
	this, last monthWindow
	// login is whose contributions are counted; author is its node id (history).
	login, author string
	// me is @me or SearchAs, for the searches.
	me string
}

func (st *statsPlan) mergedQuery(w monthWindow) string {
	return fmt.Sprintf("is:pr is:merged author:%s merged:%s", st.me, w.searchRange())
}

// recentQuery covers both months: its nodes give the per-repository merged counts.
func (st *statsPlan) recentQuery() string {
	return fmt.Sprintf("is:pr is:merged author:%s merged:%s..%s sort:updated-desc", st.me,
		st.last.Start.Format(searchTimeLayout), st.this.End.Format(searchTimeLayout))
}

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
	var thisStart, lastStart string
	if p.stats != nil && p.stats.author != "" {
		for _, r := range p.repos {
			if r.history {
				thisStart = declare("hThis", "GitTimestamp!", p.stats.this.Start.Format(time.RFC3339))
				lastStart = declare("hLast", "GitTimestamp!", p.stats.last.Start.Format(time.RFC3339))
				declare("author", "ID!", p.stats.author)
				break
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
		if r.history && thisStart != "" {
			fmt.Fprintf(&body, "    history: defaultBranchRef { target { ... on Commit { "+
				"thisMonth: history(author: {id: $author}, since: %s) { totalCount } "+
				"lastMonth: history(author: {id: $author}, since: %s, until: %s) { totalCount } } } }\n",
				thisStart, lastStart, thisStart)
		}
		body.WriteString("  }\n")
	}
	if st := p.stats; st != nil {
		fmt.Fprintf(&body, "  mergedThis: search(query: %s, type: ISSUE, first: 0) { issueCount }\n", declare("mergedThis", "String!", st.mergedQuery(st.this)))
		fmt.Fprintf(&body, "  mergedLast: search(query: %s, type: ISSUE, first: 0) { issueCount }\n", declare("mergedLast", "String!", st.mergedQuery(st.last)))
		fmt.Fprintf(&body, "  mergedRecent: search(query: %s, type: ISSUE, first: %d) { issueCount nodes { ... on PullRequest { mergedAt repository { nameWithOwner } } } }\n",
			declare("mergedRecent", "String!", st.recentQuery()), mergedStatsFirst)
		if st.login != "" {
			fmt.Fprintf(&body, "  contributions: user(login: %s) { "+
				"thisMonth: contributionsCollection(from: %s, to: %s) { totalCommitContributions } "+
				"lastMonth: contributionsCollection(from: %s, to: %s) { totalCommitContributions } }\n",
				declare("statsLogin", "String!", st.login),
				declare("cThisFrom", "DateTime!", st.this.Start.Format(time.RFC3339)), declare("cThisTo", "DateTime!", st.this.End.Format(time.RFC3339)),
				declare("cLastFrom", "DateTime!", st.last.Start.Format(time.RFC3339)), declare("cLastTo", "DateTime!", st.last.End.Format(time.RFC3339)))
		}
	}
	head := "query Poll"
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
	return []any{"searches", len(p.sections), "default_branches", tracked, "branches", branches, "stats", p.stats != nil}
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
