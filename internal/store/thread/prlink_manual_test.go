package thread

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
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

// TestLinksIgnoreURLCase: a pull request is one link whatever case its URL is in and
// whichever source comes first (a manual link typed in another case, Claude's record,
// the daemon's branch match), on the thread and on its creator, live and after a
// restart. The first source wins, except that a manual link over a branch row makes it
// manual.
func TestLinksIgnoreURLCase(t *testing.T) {
	type step string // "manual", "claude", "branch"
	tests := []struct {
		order []step
		c, p  string // the one link's facts on the thread (c) and its creator (p)
	}{
		{[]step{"manual", "claude", "branch"}, "#5 manual", "#5 child c"},
		{[]step{"manual", "branch", "claude"}, "#5 manual", "#5 child c"},
		{[]step{"claude", "manual", "branch"}, "#5 claude", "#5 child c"},
		{[]step{"claude", "branch", "manual"}, "#5 claude", "#5 child c"},
		{[]step{"branch", "manual", "claude"}, "#5 manual", "#5 child c"},
		{[]step{"branch", "claude", "manual"}, "#5 manual", "#5 child c"},
	}
	for _, tt := range tests {
		t.Run(fmt.Sprint(tt.order), func(t *testing.T) {
			e := newEnv(t)
			ids, names := lineage(e, [][2]string{{"p", ""}, {"c", "p"}})
			c := ids["c"]
			for _, st := range tt.order {
				switch st {
				case "manual":
					if _, _, _, err := e.m.LinkPullRequest(e.ctx(), c, "AlexWaumann/Code-Foundry#5"); err != nil {
						t.Fatal(err)
					}
				case "claude":
					l := childLink(5)
					l.Slug, l.URL = "alexwaumann/code-foundry", "https://github.com/alexwaumann/code-foundry/pull/5"
					e.m.linkPullRequests(c, []LinkedPullRequest{l})
				case "branch":
					l := childLink(5)
					l.Slug, l.URL, l.Head = "alexwaumann/code-foundry", "https://github.com/alexwaumann/code-foundry/pull/5", "cf/x"
					e.m.LinkBranchPullRequests(c, []LinkedPullRequest{l})
				}
			}
			check := func(when string) {
				t.Helper()
				for n, w := range map[string]string{"c": tt.c, "p": tt.p} {
					got, err := e.m.Get(e.ctx(), ids[n])
					if err != nil {
						t.Fatal(err)
					}
					if facts := linkSources(got.LinkedPullRequests, names); !slices.Equal(facts, []string{w}) {
						t.Errorf("%s: %s links = %q; want [%q]", when, n, facts, w)
					}
				}
			}
			check("live")
			e.restart()
			check("after restart")
		})
	}
}

// TestManualLinkKeepsGitHubsSlug: with the GitHub store's cache holding the pull
// request, a manual link has GitHub's URL and slug, whatever case it was typed in; a
// pull request the cache does not hold keeps the slug as written.
func TestManualLinkKeepsGitHubsSlug(t *testing.T) {
	e := newEnv(t, func(o *Options) {
		o.PullRequest = func(_ context.Context, target string) (PullRequestInfo, bool) {
			if strings.EqualFold(target, "o/r#1") {
				return PullRequestInfo{Slug: "o/r", Number: 1, URL: "https://github.com/Own/Repo/pull/1"}, true
			}
			return PullRequestInfo{}, false
		}
	})
	s := e.connected(CreateOptions{Name: "t"})
	_, l, _, err := e.m.LinkPullRequest(e.ctx(), s.ID, "O/R#1")
	if err != nil || l.Slug != "Own/Repo" || l.URL != "https://github.com/Own/Repo/pull/1" {
		t.Errorf("cached: %+v %v; want GitHub's slug and URL", l, err)
	}
	_, l, _, err = e.m.LinkPullRequest(e.ctx(), s.ID, "https://github.com/X/Y/pull/2")
	if err != nil || l.Slug != "X/Y" || l.URL != "https://github.com/X/Y/pull/2" {
		t.Errorf("not cached: %+v %v; want the slug as written", l, err)
	}
}

// TestManualLinkOverBranchLinkStays: linking by hand a pull request the thread has as a
// branch link (or a child copy of one) makes the row manual, persisted and without a
// publish, so neither SettleBranchLinks nor a member's removal drops it.
func TestManualLinkOverBranchLinkStays(t *testing.T) {
	e := newEnv(t)
	ids, names := lineage(e, [][2]string{{"p", ""}, {"c", "p"}})
	c, p := ids["c"], ids["p"]
	// Unsettled branch links (no Head): #1 on c (copied to p), #2 on c too.
	e.m.LinkBranchPullRequests(c, childLinks(1, 2))
	drainEvents(e)

	_, l, linked, err := e.m.LinkPullRequest(e.ctx(), c, "O/R#1")
	if err != nil || linked || l.Source != LinkManual || l.URL != "https://github.com/o/r/pull/1" {
		t.Fatalf("link over a branch row: %+v linked=%t %v; want the row, now manual", l, linked, err)
	}
	if _, l, _, err := e.m.LinkPullRequest(e.ctx(), p, "o/r#2"); err != nil || l.Source != LinkManual {
		t.Fatalf("link over a child copy: %+v %v", l, err)
	}
	if n := drainEvents(e); n != 0 {
		t.Errorf("upgrading a row published %d events; want none", n)
	}
	if got := linkSources(e.m.Snapshot().Threads[1].LinkedPullRequests, names); !slices.Equal(got, []string{"#1 manual", "#2 branch"}) {
		t.Errorf("snapshot of c = %q; want the upgrade in it", got)
	}
	e.restart()
	// The default-branch settle drops both URLs: only the branch row #2 (and p's copy
	// of #2, now manual) are candidates; #1 is manual on c.
	e.m.SettleBranchLinks(c, nil, []string{"https://github.com/o/r/pull/1", "https://github.com/o/r/pull/2"})
	for n, w := range map[string][]string{"c": {"#1 manual"}, "p": {"#1 child c", "#2 manual"}} {
		got, err := e.m.Get(e.ctx(), ids[n])
		if err != nil {
			t.Fatal(err)
		}
		if facts := linkSources(got.LinkedPullRequests, names); !slices.Equal(facts, w) {
			t.Errorf("%s links = %q; want %q", n, facts, w)
		}
		if n == "c" {
			if kept, _ := dropBranchLinks(got.LinkedPullRequests, "o/r", nil); len(kept) != 1 {
				t.Errorf("a member's removal drops the manual link: %+v", kept)
			}
		}
	}
}

// TestLoadLinksIgnoresCaseDuplicates: rows saved before links were compared ignoring
// case may hold one pull request twice; the first row is the link.
func TestLoadLinksIgnoresCaseDuplicates(t *testing.T) {
	e := newEnv(t)
	s := e.connected(CreateOptions{Name: "t"})
	a, b := childLink(1), childLink(1)
	b.URL, b.Source = "https://github.com/O/R/pull/1", LinkBranch
	if err := saveLinks(e.ctx(), e.m.opts.DB, s.ID, []LinkedPullRequest{a, b, childLink(2)}); err != nil {
		t.Fatal(err)
	}
	e.restart()
	got, err := e.m.Get(e.ctx(), s.ID)
	if err != nil {
		t.Fatal(err)
	}
	if facts := linkSources(got.LinkedPullRequests, nil); !slices.Equal(facts, []string{"#1 claude", "#2 claude"}) {
		t.Errorf("links = %q; want one #1 (the first row)", facts)
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
