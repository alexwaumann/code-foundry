package gh

import (
	"regexp"
	"strings"
	"testing"
)

func TestQueriesAssemble(t *testing.T) {
	defRE := regexp.MustCompile(`(?m)^fragment (\w+) on`)
	wantFrags := map[string][]string{
		queryViewer:       {"RateLimitFields"},
		queryPullRequests: {"PullRequestFields", "RateLimitFields", "RollupCounts"},
		queryPullRequest:  {"CheckContexts", "PullRequestFields", "RateLimitFields", "RollupCounts"},
		queryChecks:       {"CheckContexts", "RateLimitFields", "RollupCounts"},
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
