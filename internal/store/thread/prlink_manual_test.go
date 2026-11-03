package thread

import (
	"errors"
	"fmt"
	"slices"
	"testing"
)

func TestParsePullRequestLink(t *testing.T) {
	tests := []struct {
		in     string
		slug   string
		number int
	}{
		{"https://github.com/Owner/Repo/pull/12", "Owner/Repo", 12},
		{"  github.com/o/r.go/pull/7/files#diff-1 ", "o/r.go", 7},
		{"https://www.github.com/o/r/pull/3?w=1", "o/r", 3},
		{"o/r#45", "o/r", 45},
		{"https://github.com/o/r/issues/12", "", 0},
		{"https://gitlab.com/o/r/pull/12", "", 0},
		{"https://github.com/o/r/pull/0", "", 0},
		{"o/r", "", 0},
		{"o/..#1", "", 0},
		{"", "", 0},
	}
	for _, tt := range tests {
		slug, n, err := ParsePullRequestLink(tt.in)
		if tt.slug == "" {
			if !errors.Is(err, ErrInvalidArgument) {
				t.Errorf("%q: %q %d %v; want ErrInvalidArgument", tt.in, slug, n, err)
			}
			continue
		}
		if err != nil || slug != tt.slug || n != tt.number {
			t.Errorf("%q: %q %d %v; want %q %d", tt.in, slug, n, err, tt.slug, tt.number)
		}
	}
}

func TestLinkPullRequestByHand(t *testing.T) {
	e := newEnv(t)
	ids, names := lineage(e, [][2]string{{"p", ""}, {"c", "p"}})
	c := ids["c"]
	// Claude already linked #1; the user links #1 again (another case), then #2 twice.
	e.m.linkPullRequests(c, childLinks(1))
	drainEvents(e)

	s, l, linked, err := e.m.LinkPullRequest(e.ctx(), c, "https://github.com/O/R/pull/1/files")
	if err != nil || linked || l.Source != LinkClaude || l.URL != "https://github.com/o/r/pull/1" || len(s.LinkedPullRequests) != 1 {
		t.Fatalf("relink of a Claude link: %+v linked=%t %v; want the existing claude row, not linked", l, linked, err)
	}
	if n := drainEvents(e); n != 0 {
		t.Errorf("a known link published %d events; want none", n)
	}

	s, l, linked, err = e.m.LinkPullRequest(e.ctx(), c, "o/r#2")
	if err != nil || !linked || l.Source != LinkManual || l.URL != "https://github.com/o/r/pull/2" || l.LinkedAt.IsZero() {
		t.Fatalf("link #2: %+v linked=%t %v", l, linked, err)
	}
	if got := linkSources(s.LinkedPullRequests, names); !slices.Equal(got, []string{"#1 claude", "#2 manual"}) {
		t.Errorf("c links = %q", got)
	}
	if n := drainEvents(e); n == 0 {
		t.Error("a new link published nothing")
	}
	if _, _, linked, err := e.m.LinkPullRequest(e.ctx(), c, "https://github.com/o/r/pull/2"); err != nil || linked {
		t.Errorf("second link of #2: linked=%t %v; want a quiet success", linked, err)
	}

	// The creator gets a copy, like every link; a later Claude record of #2 keeps the
	// manual row (first source wins).
	e.m.linkPullRequests(c, childLinks(2))
	want := map[string][]string{"p": {"#1 child c", "#2 child c"}, "c": {"#1 claude", "#2 manual"}}
	check := func(when string) {
		t.Helper()
		for n, w := range want {
			got, err := e.m.Get(e.ctx(), ids[n])
			if err != nil {
				t.Fatal(err)
			}
			if facts := linkSources(got.LinkedPullRequests, names); !slices.Equal(facts, w) {
				t.Errorf("%s: %s links = %q; want %q", when, n, facts, w)
			}
		}
	}
	check("live")
	e.restart()
	check("after restart")

	for _, bad := range []string{"https://github.com/o/r/issues/3", "not a pr"} {
		if _, _, _, err := e.m.LinkPullRequest(e.ctx(), c, bad); !errors.Is(err, ErrInvalidArgument) {
			t.Errorf("link %q: %v; want ErrInvalidArgument", bad, err)
		}
	}
	if _, _, _, err := e.m.LinkPullRequest(e.ctx(), "s-nope", "o/r#1"); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown thread: %v; want ErrNotFound", err)
	}
}

// TestManualLinksSurviveMemberRemoval: removing a member drops its branch links only.
func TestManualLinksSurviveMemberRemoval(t *testing.T) {
	links := []LinkedPullRequest{
		{URL: "u1", Slug: "o/r", Source: LinkBranch},
		{URL: "u2", Slug: "o/r", Source: LinkManual},
	}
	kept, dropped := dropBranchLinks(links, "o/r", nil)
	if len(kept) != 1 || kept[0].Source != LinkManual || len(dropped) != 1 {
		t.Errorf("kept %+v, dropped %+v", kept, dropped)
	}
}

// linkSources renders links as "#n source via" (via by thread name).
func linkSources(links []LinkedPullRequest, names map[string]string) []string {
	var out []string
	for _, l := range links {
		s := fmt.Sprintf("#%d %s", l.Number, l.Source)
		if v := names[l.ViaThreadID]; v != "" {
			s += " " + v
		}
		out = append(out, s)
	}
	return out
}

func drainEvents(e *env) int {
	n := 0
	for len(e.events.C()) > 0 {
		<-e.events.C()
		n++
	}
	return n
}
