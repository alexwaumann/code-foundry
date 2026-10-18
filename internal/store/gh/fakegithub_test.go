package gh

import (
	"encoding/json"
	"fmt"
	"maps"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
)

// fakeGitHub answers the store's GraphQL documents (Poll, PullRequestDetails,
// DefaultBranchChecks, Checks) from in-memory state, in GitHub's JSON shapes, so store
// tests can change one thing and see what the next poll does. Fixture-based decode
// tests (poll_decode_test.go) pin the shapes against real responses.
type fakeGitHub struct {
	mu       sync.Mutex
	viewer   Viewer
	prs      map[string]*PullRequest // by node id
	sections map[string][]string     // section name -> PR ids, in order
	repos    map[string]*fakeRepo    // by slug; missing slugs are NOT_FOUND
	branches map[string][]string     // slug + "\x00" + head -> PR ids
	// merged are the viewer's merged pull requests the stats' count searches see
	// (global, or narrowed with repo:).
	merged []mergedItem
	// contrib are the commit contributions by month ("YYYY-MM").
	contrib map[string]int
	// statsMonths records, per document that carried stats (the poll or a closed-month
	// request), the global months asked for (labels, newest first) and each
	// repository's (by slug).
	statsMonths []fakeStatsAsk
	cost        int
	// fail makes the next request of an operation fail with err (then clears).
	fail map[string]error
	// detail is the detail panel's extra state (fakegithub_detail_test.go).
	detail fakeDetail
	// review is what reviews and comments were sent (fakegithub_review_test.go).
	review fakeReview
	// cards are the repositories search and lookup find (fakegithub_search_test.go).
	cards []Repository
}

type fakeRepo struct {
	branch  string
	sha     string
	rollup  CheckRollup
	failing []CheckRun // first page of checks holds these failed runs
	// history is the viewer's default-branch commits by month ("YYYY-MM").
	history map[string]int
}

// mergedItem is a merged pull request the fake's stats searches count.
type mergedItem struct {
	Repo     string
	MergedAt time.Time
}

// fakeStatsAsk is the months one poll's stats asked for.
type fakeStatsAsk struct {
	global []string
	repos  map[string][]string
}

// mergedCount answers a stats count search: "[repo:o/n ]is:pr is:merged author:x
// merged:<start>..<end>".
func (g *fakeGitHub) mergedCount(q string) (int, string) {
	repo := ""
	if r, ok := strings.CutPrefix(q, "repo:"); ok {
		repo, _, _ = strings.Cut(r, " ")
	}
	_, rng, _ := strings.Cut(q, " merged:")
	from, to, _ := strings.Cut(rng, "..")
	start, err1 := time.Parse(searchTimeLayout, from)
	end, err2 := time.Parse(searchTimeLayout, to)
	if err1 != nil || err2 != nil {
		panic("fake: bad merged range " + rng)
	}
	n := 0
	for _, m := range g.merged {
		if (repo == "" || m.Repo == repo) && !m.MergedAt.Before(start) && !m.MergedAt.After(end) {
			n++
		}
	}
	return n, start.Format("2006-01")
}

func newFakeGitHub() *fakeGitHub {
	return &fakeGitHub{
		viewer:   Viewer{ID: "MDQ6VXNlcjU4MzIzMQ==", Login: "octocat", Name: "The Octocat"},
		prs:      map[string]*PullRequest{},
		sections: map[string][]string{},
		repos:    map[string]*fakeRepo{},
		branches: map[string][]string{},
		cost:     1,
		fail:     map[string]error{},
	}
}

// addPR stores pr (by its ID) and appends it to the listed sections.
func (g *fakeGitHub) addPR(pr PullRequest, sections ...string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	p := pr
	g.prs[pr.ID] = &p
	for _, s := range sections {
		g.sections[s] = append(g.sections[s], pr.ID)
	}
}

// edit changes a stored pull request.
func (g *fakeGitHub) edit(id string, fn func(*PullRequest)) {
	g.mu.Lock()
	defer g.mu.Unlock()
	fn(g.prs[id])
}

func (g *fakeGitHub) setRepo(slug string, r *fakeRepo) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if r == nil {
		delete(g.repos, slug)
		return
	}
	g.repos[slug] = r
}

func (g *fakeGitHub) editRepo(slug string, fn func(*fakeRepo)) {
	g.mu.Lock()
	defer g.mu.Unlock()
	fn(g.repos[slug])
}

func (g *fakeGitHub) setBranch(slug, head string, ids ...string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.branches[slug+"\x00"+head] = ids
}

func (g *fakeGitHub) failNext(op string, err error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.fail[op] = err
}

var (
	repoBlockRE = regexp.MustCompile(`(?m)^  (r\d+): repository\(owner: \$\w+, name: \$\w+\) \{\n((?:    .*\n)*)  \}`)
	branchRE    = regexp.MustCompile(`(b\d+): pullRequests\(headRefName: \$(\w+)`)
	historyRE   = regexp.MustCompile(`(h\d+): history\(author: \{id: \$author\}, since: \$(\w+)`)
	contribRE   = regexp.MustCompile(`(c\d+): contributionsCollection\(from: \$(\w+)`)
	// statsCountRE matches the stats count variables: m<k> (global) and r<i>_m<k>.
	statsCountRE = regexp.MustCompile(`^(?:(r\d+)_)?m\d+$`)
)

// respond is a fakeRunner handler. It needs the document: Poll and DefaultBranchChecks
// are built per request, and their aliases say what was asked.
func (g *fakeGitHub) respond(op, doc string, vars map[string]any) (json.RawMessage, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if err, ok := g.fail[op]; ok {
		delete(g.fail, op)
		return nil, err
	}
	data := map[string]any{"rateLimit": map[string]any{"limit": 5000, "cost": g.cost, "remaining": 4000,
		"resetAt": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)}}
	var errs []map[string]any
	switch op {
	case "Poll", "PollStats":
		g.poll(doc, vars, data, &errs)
	case "PullRequestDetails":
		for _, list := range []string{"open", "closed"} {
			nodes := []any{}
			for _, id := range anyStrings(vars[list]) {
				if p, ok := g.prs[id]; ok {
					nodes = append(nodes, prJSON(p))
				} else {
					nodes = append(nodes, nil)
				}
			}
			data[list] = nodes
		}
	case "DefaultBranchChecks":
		for i := 0; ; i++ {
			a := repoAlias(i)
			owner, ok := vars[a+"o"]
			if !ok {
				break
			}
			r := g.repos[owner.(string)+"/"+vars[a+"n"].(string)]
			if r == nil || r.sha != vars[a+"s"] {
				data[a] = map[string]any{"object": nil}
				continue
			}
			nodes := []any{}
			for _, c := range r.failing {
				nodes = append(nodes, map[string]any{"__typename": "CheckRun", "name": c.Name, "status": "COMPLETED",
					"conclusion": string(c.Conclusion), "detailsUrl": c.URL})
			}
			ctx := rollupJSONMap(r.rollup)["contexts"].(map[string]any)
			ctx["nodes"] = nodes
			ctx["pageInfo"] = map[string]any{"hasNextPage": false, "endCursor": "x"}
			data[a] = map[string]any{"object": map[string]any{"oid": r.sha,
				"statusCheckRollup": map[string]any{"state": string(r.rollup.State), "contexts": ctx}}}
		}
	case "PullRequestFull", "ReviewerCandidates", "RevertPullRequest":
		g.detailOp(op, vars, data, &errs) // fakegithub_detail_test.go
	case "MergePullRequest":
		g.mergeOp(vars, data, &errs) // fakegithub_merge_test.go
	case "AddPullRequestReview", "AddComment":
		g.reviewOp(op, vars, data, &errs) // fakegithub_review_test.go
	case "SearchRepositories", "LookupRepository":
		g.searchOp(op, vars, data, &errs) // fakegithub_search_test.go
	default:
		return nil, fmt.Errorf("fakeGitHub: unexpected op %s", op)
	}
	b, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}
	if len(errs) > 0 {
		return b, &PartialError{Errors: toGraphQLErrors(errs)}
	}
	return b, nil
}

func (g *fakeGitHub) poll(doc string, vars map[string]any, data map[string]any, errs *[]map[string]any) {
	data["viewer"] = map[string]any{"id": g.viewer.ID, "login": g.viewer.Login, "name": g.viewer.Name}
	for _, name := range []string{sectionAuthored, sectionReview, sectionReviewed, sectionMerged} {
		if _, ok := vars["q_"+name]; !ok {
			continue
		}
		nodes := []any{}
		for _, id := range g.sections[name] {
			nodes = append(nodes, prJSON(g.prs[id]))
		}
		data[sectionAlias(name)] = map[string]any{"issueCount": len(nodes), "nodes": nodes}
	}
	for _, m := range repoBlockRE.FindAllStringSubmatch(doc, -1) {
		alias, block := m[1], m[2]
		slug := vars[alias+"o"].(string) + "/" + vars[alias+"n"].(string)
		r, ok := g.repos[slug]
		if !ok {
			data[alias] = nil
			*errs = append(*errs, map[string]any{"type": "NOT_FOUND", "path": []any{alias},
				"message": fmt.Sprintf("Could not resolve to a Repository with the name '%s'.", slug)})
			continue
		}
		out := map[string]any{}
		if strings.Contains(block, "...DefaultBranchFingerprint") {
			out["defaultBranchRef"] = map[string]any{"name": r.branch, "target": map[string]any{
				"oid": r.sha, "committedDate": "2026-10-08T12:00:00Z", "messageHeadline": "head of " + r.branch,
				"statusCheckRollup": rollupOrNil(r.rollup)}}
		}
		for _, bm := range branchRE.FindAllStringSubmatch(block, -1) {
			nodes := []any{}
			for _, id := range g.branches[slug+"\x00"+vars[bm[2]].(string)] {
				nodes = append(nodes, prJSON(g.prs[id]))
			}
			out[bm[1]] = map[string]any{"nodes": nodes}
		}
		if strings.Contains(block, "history:") {
			target := map[string]any{}
			for _, hm := range historyRE.FindAllStringSubmatch(block, -1) {
				target[hm[1]] = map[string]any{"totalCount": r.history[vars[hm[2]].(string)[:7]]}
			}
			out["history"] = map[string]any{"target": target}
		}
		data[alias] = out
	}
	ask := fakeStatsAsk{repos: map[string][]string{}}
	for _, name := range slices.Sorted(maps.Keys(vars)) {
		m := statsCountRE.FindStringSubmatch(name)
		if m == nil {
			continue
		}
		n, label := g.mergedCount(vars[name].(string))
		data[name] = map[string]any{"issueCount": n}
		if m[1] == "" {
			ask.global = append(ask.global, label)
		} else {
			slug := vars[m[1]+"o"].(string) + "/" + vars[m[1]+"n"].(string)
			ask.repos[slug] = append(ask.repos[slug], label)
		}
	}
	if ask.global != nil || len(ask.repos) > 0 {
		g.statsMonths = append(g.statsMonths, ask)
	}
	if _, ok := vars["statsLogin"]; ok {
		out := map[string]any{}
		for _, cm := range contribRE.FindAllStringSubmatch(doc, -1) {
			out[cm[1]] = map[string]any{"totalCommitContributions": g.contrib[vars[cm[2]].(string)[:7]]}
		}
		data["contributions"] = out
	}
}

// prJSON renders a pull request as GitHub would for PullRequestDetail (a superset of
// every fragment the store selects).
func prJSON(p *PullRequest) map[string]any {
	ts := func(t time.Time) any {
		if t.IsZero() {
			return nil
		}
		return t.UTC().Format(time.RFC3339)
	}
	reviews := []any{}
	for _, r := range p.LatestReviews {
		reviews = append(reviews, map[string]any{"author": map[string]any{"login": r.Author}, "state": r.State, "submittedAt": ts(r.SubmittedAt)})
	}
	requests := []any{}
	for _, r := range p.ReviewRequests {
		if org, team, ok := strings.Cut(r, "/"); ok {
			requests = append(requests, map[string]any{"requestedReviewer": map[string]any{"__typename": "Team", "slug": team, "organization": map[string]any{"login": org}}})
		} else {
			requests = append(requests, map[string]any{"requestedReviewer": map[string]any{"__typename": "User", "login": r}})
		}
	}
	nilIfEmpty := func(s string) any {
		if s == "" {
			return nil
		}
		return s
	}
	return map[string]any{
		"__typename": "PullRequest", "id": p.ID, "number": p.Number, "title": p.Title,
		"url":   cmpString(p.URL, fmt.Sprintf("https://github.com/%s/pull/%d", p.Repo, p.Number)),
		"state": string(p.State), "isDraft": p.Draft, "createdAt": ts(p.CreatedAt), "updatedAt": ts(p.UpdatedAt),
		"mergedAt": ts(p.MergedAt), "author": map[string]any{"login": p.Author}, "repository": map[string]any{"nameWithOwner": p.Repo},
		"headRefName": p.HeadRef, "headRefOid": p.HeadSHA, "baseRefName": p.BaseRef, "baseRefOid": p.BaseSHA, "isCrossRepository": p.IsCrossRepository,
		"additions": p.Additions, "deletions": p.Deletions, "changedFiles": p.ChangedFiles,
		"statusCheckRollup": rollupOrNil(p.Checks),
		"headRepository":    map[string]any{"nameWithOwner": cmpString(p.HeadRepoSlug, p.Repo)},
		"reviewDecision":    nilIfEmpty(string(p.ReviewDecision)), "mergeable": nilIfEmpty(string(p.Mergeable)),
		"mergeStateStatus": nilIfEmpty(string(p.MergeStateStatus)), "totalCommentsCount": p.Comments,
		"reviews": map[string]any{"totalCount": p.Reviews}, "latestReviews": map[string]any{"nodes": reviews},
		"reviewRequests": map[string]any{"nodes": requests},
	}
}

func rollupOrNil(r CheckRollup) any {
	if r.State == "" {
		return nil
	}
	return rollupJSONMap(r)
}

// rollupJSONMap renders a rollup's counts the way GitHub reports them (one entry per
// state, zeros included) so that mapRollup gives r back.
func rollupJSONMap(r CheckRollup) map[string]any {
	counts := map[string]int{"SUCCESS": r.Passed, "FAILURE": r.Failed, "IN_PROGRESS": r.Pending, "SKIPPED": r.Skipped, "QUEUED": 0}
	byState := []any{}
	for _, st := range slices.Sorted(maps.Keys(counts)) {
		byState = append(byState, map[string]any{"state": st, "count": counts[st]})
	}
	return map[string]any{"state": string(r.State), "contexts": map[string]any{
		"checkRunCount": r.Passed + r.Failed + r.Pending + r.Skipped, "checkRunCountsByState": byState,
		"statusContextCount": 0, "statusContextCountsByState": []any{}}}
}

func toGraphQLErrors(errs []map[string]any) []graphQLError {
	out := make([]graphQLError, 0, len(errs))
	for _, e := range errs {
		typ, _ := e["type"].(string) // GitHub leaves it out of some errors
		out = append(out, graphQLError{Type: typ, Message: e["message"].(string), Path: e["path"].([]any)})
	}
	return out
}

func anyStrings(v any) []string {
	switch s := v.(type) {
	case []string:
		return s
	case []any:
		out := make([]string, 0, len(s))
		for _, x := range s {
			out = append(out, x.(string))
		}
		return out
	}
	return nil
}

func cmpString(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// fakePR builds an open pull request in repo with a passing rollup of n checks.
func fakePR(id, repo string, number int, updated time.Time) PullRequest {
	return PullRequest{
		ID: id, Number: number, Title: fmt.Sprintf("PR %d", number), Author: "octocat", Repo: repo,
		HeadRef: fmt.Sprintf("branch-%d", number), HeadSHA: fmt.Sprintf("%040d", number), BaseRef: "main",
		State: PullRequestOpen, UpdatedAt: updated, CreatedAt: updated.Add(-time.Hour),
		Checks:         CheckRollup{State: RollupSuccess, Total: 3, Passed: 3},
		ReviewDecision: ReviewRequired, Mergeable: MergeableMergeable, MergeStateStatus: "BLOCKED",
		Additions: 10, Deletions: 2, ChangedFiles: 1,
	}
}

// addMerged adds merged pull requests the stats' count searches see.
func (g *fakeGitHub) addMerged(items ...mergedItem) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.merged = append(g.merged, items...)
}

// asks returns the months each stats poll asked for, in order.
func (g *fakeGitHub) asks() []fakeStatsAsk {
	g.mu.Lock()
	defer g.mu.Unlock()
	return slices.Clone(g.statsMonths)
}
