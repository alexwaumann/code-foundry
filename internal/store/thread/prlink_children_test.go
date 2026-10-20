package thread

import (
	"bytes"
	"cmp"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"testing"
	"time"
)

// childLink is pull request n of o/r, linked n seconds after a fixed time.
func childLink(n int) LinkedPullRequest {
	return LinkedPullRequest{Slug: "o/r", Number: n, URL: fmt.Sprintf("https://github.com/o/r/pull/%d", n),
		LinkedAt: ts("2026-10-20T10:00:00Z").Add(time.Duration(n) * time.Second), Source: LinkClaude}
}

func childLinks(nums ...int) []LinkedPullRequest {
	out := make([]LinkedPullRequest, len(nums))
	for i, n := range nums {
		out[i] = childLink(n)
	}
	return out
}

// linkFacts renders links as "#n source via", via by thread name (names maps id to
// name), and checks each kept its original time.
func linkFacts(t *testing.T, links []LinkedPullRequest, names map[string]string) []string {
	t.Helper()
	var out []string
	for _, l := range links {
		if !l.LinkedAt.Equal(childLink(l.Number).LinkedAt) {
			t.Errorf("#%d linked at %v; want the original's %v", l.Number, l.LinkedAt, childLink(l.Number).LinkedAt)
		}
		out = append(out, strings.TrimSpace(fmt.Sprintf("#%d %s %s", l.Number, l.Source, names[l.ViaThreadID])))
	}
	return out
}

// lineage creates threads in order, each created by the named thread ("" for the
// user's), and returns name -> id and id -> name.
func lineage(e *env, threads [][2]string) (ids, names map[string]string) {
	e.t.Helper()
	ids, names = map[string]string{}, map[string]string{}
	for _, th := range threads {
		o := CreateOptions{Name: th[0]}
		if th[1] != "" {
			o.CreatedBy = ids[th[1]]
		}
		s := e.connected(o)
		ids[th[0]], names[s.ID] = s.ID, th[0]
	}
	return ids, names
}

func TestLinksPropagateUpCreatedBy(t *testing.T) {
	type link struct {
		thread string
		nums   []int
	}
	tests := []struct {
		name    string
		threads [][2]string // name, creator
		archive []string    // archived before linking
		links   []link
		want    map[string][]string
		updated map[string]int // Updated events of the last link step, per thread; nil: not checked
	}{
		{name: "one level",
			threads: [][2]string{{"p", ""}, {"c", "p"}, {"sib", "p"}},
			links:   []link{{"c", []int{1, 2}}},
			want: map[string][]string{
				"p": {"#1 child c", "#2 child c"}, "c": {"#1 claude", "#2 claude"}, "sib": nil},
			updated: map[string]int{"p": 1, "c": 1}},
		{name: "two levels: via is the direct child",
			threads: [][2]string{{"g", ""}, {"p", "g"}, {"c", "p"}},
			links:   []link{{"c", []int{1}}},
			want:    map[string][]string{"g": {"#1 child p"}, "p": {"#1 child c"}, "c": {"#1 claude"}},
			updated: map[string]int{"g": 1, "p": 1, "c": 1}},
		{name: "parent has the url: its row stays claude",
			threads: [][2]string{{"g", ""}, {"p", "g"}, {"c", "p"}},
			links:   []link{{"p", []int{1}}, {"c", []int{1, 2}}},
			want: map[string][]string{
				"g": {"#1 child p", "#2 child p"}, "p": {"#1 claude", "#2 child c"}, "c": {"#1 claude", "#2 claude"}},
			updated: map[string]int{"g": 1, "p": 1, "c": 1}},
		{name: "first-seen order across children",
			threads: [][2]string{{"p", ""}, {"c1", "p"}, {"c2", "p"}},
			links:   []link{{"c1", []int{3}}, {"c2", []int{1}}, {"c1", []int{2}}},
			want: map[string][]string{
				"p": {"#3 child c1", "#1 child c2", "#2 child c1"}, "c1": {"#3 claude", "#2 claude"}, "c2": {"#1 claude"}},
			updated: map[string]int{"p": 1, "c1": 1}},
		{name: "archived child still counts",
			threads: [][2]string{{"p", ""}, {"c", "p"}},
			archive: []string{"c"},
			links:   []link{{"c", []int{4}}},
			// Archiving stops the process: its status events are not counted.
			want: map[string][]string{"p": {"#4 child c"}, "c": {"#4 claude"}}},
		{name: "a repeat publishes nothing",
			threads: [][2]string{{"p", ""}, {"c", "p"}},
			links:   []link{{"c", []int{1}}, {"c", []int{1}}},
			want:    map[string][]string{"p": {"#1 child c"}, "c": {"#1 claude"}},
			updated: map[string]int{}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newEnv(t)
			ids, names := lineage(e, tt.threads)
			for _, n := range tt.archive {
				if _, err := e.m.Archive(e.ctx(), ids[n], true); err != nil {
					t.Fatal(err)
				}
			}
			for i, l := range tt.links {
				if i == len(tt.links)-1 {
					for len(e.events.C()) > 0 {
						<-e.events.C()
					}
				}
				e.m.linkPullRequests(ids[l.thread], childLinks(l.nums...))
			}
			updated := map[string]int{}
			for len(e.events.C()) > 0 {
				if u, ok := (<-e.events.C()).(Updated); ok {
					updated[names[u.Thread.ID]]++
				}
			}
			for n, want := range tt.want {
				got, err := e.m.Get(e.ctx(), ids[n])
				if err != nil {
					t.Fatal(err)
				}
				if facts := linkFacts(t, got.LinkedPullRequests, names); !slices.Equal(facts, want) {
					t.Errorf("%s links = %q; want %q", n, facts, want)
				}
			}
			for n, want := range tt.updated {
				if updated[n] != want {
					t.Errorf("%s Updated events = %d; want %d (all: %v)", n, updated[n], want, updated)
				}
			}
			for n, got := range updated {
				if tt.updated != nil && tt.updated[n] == 0 {
					t.Errorf("%s published %d Updated; want none", n, got)
				}
			}

			// Persisted with source and via: a restart loads the same.
			e.restart()
			for n, want := range tt.want {
				got, _ := e.m.Get(e.ctx(), ids[n])
				if facts := linkFacts(t, got.LinkedPullRequests, names); !slices.Equal(facts, want) {
					t.Errorf("after restart %s links = %q; want %q", n, facts, want)
				}
			}
		})
	}
}

func TestLinkPropagationStops(t *testing.T) {
	tests := []struct {
		name  string
		setBy map[string]string // CreatedBy forced on the records
		link  string
		want  map[string][]string
	}{
		{name: "cycle", setBy: map[string]string{"a": "b", "b": "a"}, link: "a",
			want: map[string][]string{"a": {"#1 claude"}, "b": {"#1 child a"}}},
		{name: "three-cycle", setBy: map[string]string{"a": "c", "b": "a", "c": "b"}, link: "a",
			want: map[string][]string{"a": {"#1 claude"}, "b": {"#1 child c"}, "c": {"#1 child a"}}},
		{name: "own creator", setBy: map[string]string{"a": "a"}, link: "a",
			want: map[string][]string{"a": {"#1 claude"}, "b": nil}},
		{name: "creator gone", setBy: map[string]string{"a": "s-gone"}, link: "a",
			want: map[string][]string{"a": {"#1 claude"}, "b": nil}},
		{name: "creator gone mid-chain", setBy: map[string]string{"a": "b", "b": "s-gone", "c": ""}, link: "a",
			want: map[string][]string{"a": {"#1 claude"}, "b": {"#1 child a"}, "c": nil}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newEnv(t)
			ids, names := lineage(e, [][2]string{{"a", ""}, {"b", ""}, {"c", ""}})
			e.m.mu.Lock()
			for n, by := range tt.setBy {
				e.m.recs[ids[n]].s.CreatedBy = cmp.Or(ids[by], by)
			}
			e.m.mu.Unlock()
			done := make(chan struct{})
			go func() {
				defer close(done)
				e.m.linkPullRequests(ids[tt.link], childLinks(1))
			}()
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Fatal("linkPullRequests did not return")
			}
			for n, want := range tt.want {
				got, _ := e.m.Get(e.ctx(), ids[n])
				if facts := linkFacts(t, got.LinkedPullRequests, names); !slices.Equal(facts, want) {
					t.Errorf("%s links = %q; want %q", n, facts, want)
				}
			}
		})
	}
}

// A fork (ParentID) is not a child: nothing goes from a fork to its parent or the
// parent's creator, nor from the forked thread to its fork.
func TestLinksNotAcrossForks(t *testing.T) {
	e := newEnv(t)
	ids, names := lineage(e, [][2]string{{"p", ""}, {"c", "p"}})
	e.resumable(ids["c"])
	f, err := e.m.Fork(e.ctx(), ids["c"], "f")
	if err != nil {
		t.Fatal(err)
	}
	e.waitFor(f.ID, "fork connected", func(s Thread) bool { return s.State == StateConnected })
	ids["f"], names[f.ID] = f.ID, "f"
	e.m.linkPullRequests(f.ID, childLinks(1))
	e.m.linkPullRequests(ids["c"], childLinks(2))
	want := map[string][]string{"p": {"#2 child c"}, "c": {"#2 claude"}, "f": {"#1 claude"}}
	for n, w := range want {
		got, _ := e.m.Get(e.ctx(), ids[n])
		if facts := linkFacts(t, got.LinkedPullRequests, names); !slices.Equal(facts, w) {
			t.Errorf("%s links = %q; want %q", n, facts, w)
		}
	}
}

// Links saved before propagation existed are folded up once at startup, in LinkedAt
// order, and a second start changes nothing.
func TestFoldChildLinksAtStartup(t *testing.T) {
	e := newEnv(t)
	ids, names := lineage(e, [][2]string{{"g", ""}, {"p", "g"}, {"c", "p"}, {"d", "g"}, {"x", ""}})
	ctx, db := e.ctx(), e.m.opts.DB
	// Rows as an older daemon wrote them: each thread's own, nothing copied up.
	for n, nums := range map[string][]int{"g": {9}, "p": {5, 1}, "c": {3, 5, 2}, "d": {4}, "x": {7}} {
		if err := saveLinks(ctx, db, ids[n], childLinks(nums...)); err != nil {
			t.Fatal(err)
		}
	}
	// A removed child's copies stay with the ancestor: r's link is folded, then r goes.
	r := e.connected(CreateOptions{Name: "r", CreatedBy: ids["p"]})
	ids["r"], names[r.ID] = r.ID, "r"
	if err := saveLinks(ctx, db, r.ID, childLinks(6)); err != nil {
		t.Fatal(err)
	}

	var logs bytes.Buffer
	withLog := func(o *Options) { o.Log = slog.New(slog.NewTextHandler(&logs, nil)) }
	e.restart(withLog)
	want := map[string][]string{
		"g": {"#9 claude", "#1 child p", "#2 child p", "#3 child p", "#4 child d", "#5 child p", "#6 child p"},
		"p": {"#5 claude", "#1 claude", "#2 child c", "#3 child c", "#6 child r"},
		"c": {"#3 claude", "#5 claude", "#2 claude"},
		"d": {"#4 claude"},
		"x": {"#7 claude"},
	}
	check := func(when string) {
		t.Helper()
		for n, w := range want {
			got, _ := e.m.Get(e.ctx(), ids[n])
			if facts := linkFacts(t, got.LinkedPullRequests, names); !slices.Equal(facts, w) {
				t.Errorf("%s: %s links = %q; want %q", when, n, facts, w)
			}
		}
	}
	check("first start")
	if !strings.Contains(logs.String(), "linked pull requests folded up from child threads") ||
		!strings.Contains(logs.String(), "threads=2 links=9") {
		t.Errorf("first start log = %q", logs.String())
	}
	if err := e.m.Remove(e.ctx(), r.ID); err != nil {
		t.Fatal(err)
	}

	rows := func() int {
		var n int
		if err := e.m.opts.DB.QueryRow(`SELECT count(*) FROM thread_pull_requests`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	before := rows()
	logs.Reset()
	e.restart(withLog)
	check("second start")
	if after := rows(); after != before {
		t.Errorf("rows %d -> %d on a second start; want unchanged", before, after)
	}
	if strings.Contains(logs.String(), "folded") {
		t.Errorf("second start logged a fold: %q", logs.String())
	}
}

func TestSaveAndLoadLinkSource(t *testing.T) {
	e := newEnv(t)
	a := e.connected(CreateOptions{Name: "a"})
	ctx, db := e.ctx(), e.m.opts.DB
	unset := childLink(1)
	unset.Source = ""
	child := childLink(2)
	child.Source, child.ViaThreadID = LinkChild, "s-kid"
	branch := childLink(3)
	branch.Source = LinkBranch
	if err := saveLinks(ctx, db, a.ID, []LinkedPullRequest{unset, child, branch}); err != nil {
		t.Fatal(err)
	}
	got, err := loadLinks(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	facts := linkFacts(t, got[a.ID], map[string]string{"s-kid": "s-kid"})
	if want := []string{"#1 claude", "#2 child s-kid", "#3 branch"}; !slices.Equal(facts, want) {
		t.Errorf("loaded = %q; want %q", facts, want)
	}
}
