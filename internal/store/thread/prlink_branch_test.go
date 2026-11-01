package thread

import (
	"maps"
	"slices"
	"testing"
	"time"
)

// branchLinks are pull requests n of o/r as the daemon pushes them: whatever source
// the caller set, LinkBranchPullRequests makes them branch links.
func branchLinks(nums ...int) []LinkedPullRequest {
	out := childLinks(nums...)
	for i := range out {
		out[i].Source, out[i].ViaThreadID = LinkChild, "s-ignored"
	}
	return out
}

func TestLinkBranchPullRequests(t *testing.T) {
	type step struct {
		thread string
		claude []int // pr-link records first
		branch []int
		added  int // LinkBranchPullRequests' return; not checked for claude-only steps
	}
	tests := []struct {
		name    string
		threads [][2]string // name, creator
		steps   []step
		want    map[string][]string
		updated map[string]int // Updated events of the last step, per thread
	}{
		{name: "branch links on the thread",
			threads: [][2]string{{"t", ""}},
			steps:   []step{{thread: "t", branch: []int{1, 2}, added: 2}},
			want:    map[string][]string{"t": {"#1 branch", "#2 branch"}},
			updated: map[string]int{"t": 1}},
		{name: "a repeat adds nothing and publishes nothing",
			threads: [][2]string{{"t", ""}},
			steps:   []step{{thread: "t", branch: []int{1}, added: 1}, {thread: "t", branch: []int{1}, added: 0}},
			want:    map[string][]string{"t": {"#1 branch"}},
			updated: map[string]int{}},
		{name: "a url Claude linked keeps source claude",
			threads: [][2]string{{"t", ""}},
			steps:   []step{{thread: "t", claude: []int{1}}, {thread: "t", branch: []int{1, 2}, added: 1}},
			want:    map[string][]string{"t": {"#1 claude", "#2 branch"}},
			updated: map[string]int{"t": 1}},
		{name: "reaches the creator as a child link",
			threads: [][2]string{{"g", ""}, {"p", "g"}, {"c", "p"}},
			steps:   []step{{thread: "c", branch: []int{3}, added: 1}},
			want:    map[string][]string{"g": {"#3 child p"}, "p": {"#3 child c"}, "c": {"#3 branch"}},
			updated: map[string]int{"g": 1, "p": 1, "c": 1}},
		{name: "a later Claude record keeps the branch row",
			threads: [][2]string{{"t", ""}},
			steps:   []step{{thread: "t", branch: []int{1}, added: 1}, {thread: "t", claude: []int{1}}},
			want:    map[string][]string{"t": {"#1 branch"}},
			updated: map[string]int{}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newEnv(t)
			ids, names := lineage(e, tt.threads)
			for i, s := range tt.steps {
				if i == len(tt.steps)-1 {
					for len(e.events.C()) > 0 {
						<-e.events.C()
					}
				}
				if len(s.claude) > 0 {
					e.m.linkPullRequests(ids[s.thread], childLinks(s.claude...))
				}
				if len(s.branch) > 0 {
					if n := e.m.LinkBranchPullRequests(ids[s.thread], branchLinks(s.branch...)); n != s.added {
						t.Errorf("step %d: LinkBranchPullRequests = %d; want %d", i, n, s.added)
					}
				}
			}
			updated := map[string]int{}
			for len(e.events.C()) > 0 {
				if u, ok := (<-e.events.C()).(Updated); ok {
					updated[names[u.Thread.ID]]++
				}
			}
			if !maps.Equal(updated, tt.updated) {
				t.Errorf("Updated events of the last step = %v; want %v", updated, tt.updated)
			}
			check := func(when string) {
				for n, want := range tt.want {
					got, err := e.m.Get(e.ctx(), ids[n])
					if err != nil {
						t.Fatal(err)
					}
					if facts := linkFacts(t, got.LinkedPullRequests, names); !slices.Equal(facts, want) {
						t.Errorf("%s%s links = %q; want %q", when, n, facts, want)
					}
				}
			}
			check("")
			e.restart()
			check("after restart ")
		})
	}
}

func TestLinkBranchPullRequestsEdges(t *testing.T) {
	e := newEnv(t)
	th := e.connected(CreateOptions{Name: "t"})
	if n := e.m.LinkBranchPullRequests("s-unknown", branchLinks(1)); n != 0 {
		t.Errorf("unknown thread: added %d", n)
	}
	if n := e.m.LinkBranchPullRequests(th.ID, nil); n != 0 {
		t.Errorf("no links: added %d", n)
	}
	// No time: now.
	before := time.Now()
	l := childLink(5)
	l.LinkedAt = time.Time{}
	in := []LinkedPullRequest{l}
	if n := e.m.LinkBranchPullRequests(th.ID, in); n != 1 {
		t.Fatalf("added %d; want 1", n)
	}
	if in[0].Source != LinkClaude || !in[0].LinkedAt.IsZero() {
		t.Errorf("the caller's slice was written: %+v", in[0])
	}
	got, _ := e.m.Get(e.ctx(), th.ID)
	if len(got.LinkedPullRequests) != 1 || got.LinkedPullRequests[0].LinkedAt.Before(before.Add(-time.Second)) ||
		got.LinkedPullRequests[0].Source != LinkBranch || got.LinkedPullRequests[0].ViaThreadID != "" {
		t.Errorf("links = %+v; want #5 branch linked now", got.LinkedPullRequests)
	}
}

func TestSettleBranchLinks(t *testing.T) {
	e := newEnv(t)
	ids, names := lineage(e, [][2]string{{"g", ""}, {"p", "g"}, {"c", "p"}, {"other", ""}})
	// Old branch links on c (no head), copied up to p and g; g also has #2 from Claude.
	e.m.linkPullRequests(ids["g"], childLinks(2))
	e.m.LinkBranchPullRequests(ids["c"], branchLinks(1, 2, 3))
	e.m.LinkBranchPullRequests(ids["other"], branchLinks(1))
	// A link with a head is settled already and is never touched.
	headed := childLink(4)
	headed.Head = "main"
	e.m.LinkBranchPullRequests(ids["c"], []LinkedPullRequest{headed})

	url := func(n int) string { return childLink(n).URL }
	if n := e.m.SettleBranchLinks(ids["c"], map[string]string{url(3): "cf/x", url(4): "cf/y"}, []string{url(1), url(2), url(4)}); n != 5 {
		t.Errorf("removed %d; want 5 (#1 and #2 on c and p, #1 on g: its #2 is Claude's)", n)
	}
	if n := e.m.SettleBranchLinks("s-unknown", nil, []string{url(1)}); n != 0 {
		t.Errorf("unknown thread: removed %d", n)
	}
	want := map[string][]string{
		"g":     {"#2 claude", "#3 child p", "#4 child p"},
		"p":     {"#3 child c", "#4 child c"},
		"c":     {"#3 branch", "#4 branch"},
		"other": {"#1 branch"},
	}
	heads := func(id string) []string {
		got, _ := e.m.Get(e.ctx(), id)
		var out []string
		for _, l := range got.LinkedPullRequests {
			out = append(out, l.Head)
		}
		return out
	}
	check := func(when string) {
		for n, w := range want {
			got, err := e.m.Get(e.ctx(), ids[n])
			if err != nil {
				t.Fatal(err)
			}
			if facts := linkFacts(t, got.LinkedPullRequests, names); !slices.Equal(facts, w) {
				t.Errorf("%s%s links = %q; want %q", when, n, facts, w)
			}
		}
		if h := heads(ids["c"]); !slices.Equal(h, []string{"cf/x", "main"}) {
			t.Errorf("%sc heads = %q; want cf/x and main", when, h)
		}
		if h := heads(ids["p"]); !slices.Equal(h, []string{"", ""}) {
			t.Errorf("%sp heads = %q; copies carry none", when, h)
		}
	}
	check("")
	e.restart()
	check("after restart ")
}
