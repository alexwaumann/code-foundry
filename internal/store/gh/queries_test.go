package gh

import (
	"regexp"
	"strings"
	"testing"
	"time"
)

func TestQueriesAssemble(t *testing.T) {
	defRE := regexp.MustCompile(`(?m)^fragment (\w+) on`)
	wantFrags := map[string][]string{
		queryPullRequest:        {"CheckContexts", "PullRequestDetail", "PullRequestSummary", "RateLimitFields", "RollupCounts", "RollupFingerprint"},
		queryChecks:             {"CheckContexts", "RateLimitFields", "RollupCounts"},
		queryPullRequestDetails: {"PullRequestDetail", "PullRequestSummary", "RateLimitFields", "RollupCounts", "RollupFingerprint"},
		queryPullRequestFull: {"ActorFields", "CheckContexts", "PullRequestDetail", "PullRequestSummary", "RateLimitFields",
			"RequestedReviewerFields", "RollupCounts", "RollupFingerprint"},
		queryReviewerCandidates: {"RateLimitFields", "RequestedReviewerFields"},
		queryRevertPullRequest:  nil,
		queryMergePullRequest:   nil,
		querySearchRepositories: {"RateLimitFields", "RepositoryCard"},
		queryLookupRepository:   {"RateLimitFields", "RepositoryCard"},
		queryPublishOwners:      {"RateLimitFields"},
	}
	if qs, _ := loadQueries(); len(qs) != len(wantFrags) {
		t.Errorf("queries = %d files, want %d", len(qs), len(wantFrags))
	}
	for name, want := range wantFrags {
		q, err := query(name)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		var got []string
		for _, m := range defRE.FindAllStringSubmatch(q, -1) {
			got = append(got, m[1])
		}
		if strings.Join(got, ",") != strings.Join(want, ",") {
			t.Errorf("%s fragments = %v, want %v", name, got, want)
		}
		if strings.Contains(q, "#") {
			t.Errorf("%s still has comments", name)
		}
		if strings.Count(q, "{") != strings.Count(q, "}") {
			t.Errorf("%s has unbalanced braces", name)
		}
	}
	if _, err := query("nope"); err == nil {
		t.Error("unknown query: want error")
	}
}

func TestWithFragments(t *testing.T) {
	frags := map[string]string{
		"A": "fragment A on T { a ...B }",
		"B": "fragment B on T { b }",
		"C": "fragment C on T { c }",
	}
	got, err := withFragments("query { x { ...A ... on T { y } } }", frags)
	if err != nil {
		t.Fatal(err)
	}
	want := "query { x { ...A ... on T { y } } }\n\nfragment A on T { a ...B }\n\nfragment B on T { b }\n"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
	if _, err := withFragments("query { ...Missing }", frags); err == nil {
		t.Error("unknown fragment: want error")
	}
}

func TestParseFragments(t *testing.T) {
	got, err := parseFragments("fragment A on T { a { b } }\n\nfragment B on U { c }")
	if err != nil {
		t.Fatal(err)
	}
	if got["A"] != "fragment A on T { a { b } }" || got["B"] != "fragment B on U { c }" {
		t.Errorf("got %q", got)
	}
	for _, bad := range []string{"query { x }", "fragment A on T { a "} {
		if _, err := parseFragments(bad); err == nil {
			t.Errorf("parseFragments(%q): want error", bad)
		}
	}
}

var (
	declRE = regexp.MustCompile(`\$(\w+): `)
	useRE  = regexp.MustCompile(`\$(\w+)[^\w:]`)
)

// checkDoc checks a built document: balanced, only the fragments it uses, and every
// variable declared, used, and given a value (GitHub rejects unused variables).
func checkDoc(t *testing.T, name, doc string, vars map[string]any) {
	t.Helper()
	if strings.Count(doc, "{") != strings.Count(doc, "}") || strings.Count(doc, "(") != strings.Count(doc, ")") {
		t.Errorf("%s: unbalanced", name)
	}
	head, body, _ := strings.Cut(doc, "{")
	declared := map[string]bool{}
	for _, m := range declRE.FindAllStringSubmatch(head, -1) {
		declared[m[1]] = true
		if _, ok := vars[m[1]]; !ok {
			t.Errorf("%s: $%s declared without a value", name, m[1])
		}
	}
	used := map[string]bool{}
	for _, m := range useRE.FindAllStringSubmatch(body, -1) {
		used[m[1]] = true
		if !declared[m[1]] {
			t.Errorf("%s: $%s used but not declared", name, m[1])
		}
	}
	for v := range declared {
		if !used[v] {
			t.Errorf("%s: $%s declared but not used", name, v)
		}
	}
	if len(vars) != len(declared) {
		t.Errorf("%s: %d values for %d variables", name, len(vars), len(declared))
	}
}

func TestPollPlanBuild(t *testing.T) {
	now := time.Date(2026, 10, 8, 4, 0, 0, 0, time.FixedZone("EST", -5*3600))
	this, last := monthWindows(now)
	stats := &statsPlan{this: this, last: last, login: "octocat", author: "A1", me: "@me"}
	tests := []struct {
		name      string
		plan      pollPlan
		want      []string // substrings of the document
		notWant   []string
		wantFrags []string
	}{
		{name: "viewer only", plan: pollPlan{},
			want:      []string{"query Poll {", "viewer { ...ViewerFields }"},
			notWant:   []string{"search(", "repository("},
			wantFrags: []string{"RateLimitFields", "ViewerFields"}},
		{name: "dashboards and a tracked repository", plan: pollPlan{
			sections: dashboardSections("@me", now),
			repos:    []repoPlan{{slug: "o/r", defaultBranch: true}},
		},
			want: []string{"s_authored: search(query: $q_authored, type: ISSUE, first: 50)", "...PullRequestFingerprint",
				"s_merged: search(query: $q_merged, type: ISSUE_ADVANCED, first: 50) { issueCount nodes { __typename ...PullRequestIdentity",
				"r0: repository(owner: $r0o, name: $r0n) {\n    ...DefaultBranchFingerprint"},
			notWant:   []string{"history", "mergedThis"},
			wantFrags: []string{"DefaultBranchFingerprint", "PullRequestFingerprint", "PullRequestIdentity", "RateLimitFields", "RollupCounts", "RollupFingerprint", "ViewerFields"}},
		{name: "watched branches of an untracked repository", plan: pollPlan{
			repos: []repoPlan{{slug: "o/r", branches: []string{"a", "b/c"}}},
		},
			want:    []string{"b0: pullRequests(headRefName: $r0b0, first: 10", "b1: pullRequests(headRefName: $r0b1"},
			notWant: []string{"DefaultBranchFingerprint"}},
		{name: "stats", plan: pollPlan{
			repos: []repoPlan{{slug: "o/r", defaultBranch: true, history: true}, {slug: "o/s", defaultBranch: true}},
			stats: stats,
		},
			want: []string{"$author: ID!", "$hThis: GitTimestamp!", "history: defaultBranchRef", "mergedThis: search(query: $mergedThis, type: ISSUE, first: 0)",
				"mergedRecent: search(query: $mergedRecent, type: ISSUE, first: 100)", "contributions: user(login: $statsLogin)", "$cThisFrom: DateTime!"}},
		{name: "SearchAs id", plan: pollPlan{searchAs: "mitchellh"},
			want: []string{"searchAs: user(login: $searchAs) { id login }"}},
	}
	defRE := regexp.MustCompile(`(?m)^fragment (\w+) on`)
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			doc, vars, err := tt.plan.build()
			if err != nil {
				t.Fatal(err)
			}
			checkDoc(t, tt.name, doc, vars)
			for _, w := range tt.want {
				if !strings.Contains(doc, w) {
					t.Errorf("missing %q in\n%s", w, doc)
				}
			}
			for _, w := range tt.notWant {
				if strings.Contains(doc, w) {
					t.Errorf("unexpected %q", w)
				}
			}
			if tt.wantFrags != nil {
				var got []string
				for _, m := range defRE.FindAllStringSubmatch(doc, -1) {
					got = append(got, m[1])
				}
				if strings.Join(got, ",") != strings.Join(tt.wantFrags, ",") {
					t.Errorf("fragments = %v, want %v", got, tt.wantFrags)
				}
			}
		})
	}
	// Values: the searches and stats windows.
	_, vars, _ := (&pollPlan{sections: dashboardSections("@me", now), stats: stats,
		repos: []repoPlan{{slug: "o/r", history: true}}}).build()
	if vars["q_reviewed"] != "is:pr is:open archived:false reviewed-by:@me -author:@me sort:updated-desc" ||
		vars["q_review"] != "is:pr is:open archived:false review-requested:@me sort:updated-desc" ||
		vars["q_merged"] != "is:pr is:merged merged:>=2026-10-01T04:00:00-05:00 (author:@me OR reviewed-by:@me OR assignee:@me) sort:updated-desc" ||
		vars["mergedThis"] != "is:pr is:merged author:@me merged:2026-10-01T00:00:00-05:00..2026-10-31T23:59:59-05:00" ||
		vars["mergedRecent"] != "is:pr is:merged author:@me merged:2026-09-01T00:00:00-05:00..2026-10-31T23:59:59-05:00 sort:updated-desc" ||
		vars["hThis"] != "2026-10-01T00:00:00-05:00" || vars["author"] != "A1" || vars["r0o"] != "o" || vars["r0n"] != "r" {
		t.Errorf("vars = %v", vars)
	}
}

func TestDefaultBranchChecksDoc(t *testing.T) {
	doc, vars, err := defaultBranchChecksDoc([]ciRequest{{"o/r", "abc"}, {"o/s", "def"}})
	if err != nil {
		t.Fatal(err)
	}
	checkDoc(t, "DefaultBranchChecks", doc, vars)
	if !strings.Contains(doc, "r1: repository(owner: $r1o, name: $r1n) { object(oid: $r1s)") || vars["r1s"] != "def" ||
		!strings.Contains(doc, "fragment CheckContexts") {
		t.Errorf("doc = %s vars = %v", doc, vars)
	}
}
