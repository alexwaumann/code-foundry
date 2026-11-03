package thread

import (
	"errors"
	"strconv"
	"testing"
)

func TestLinkOwner(t *testing.T) {
	own := func(slug string, n int, src LinkSource) LinkedPullRequest {
		return LinkedPullRequest{Slug: slug, Number: n, Source: src}
	}
	via := func(slug string, n int, through string) LinkedPullRequest {
		return LinkedPullRequest{Slug: slug, Number: n, Source: LinkChild, ViaThreadID: through}
	}
	slugs := []string{"o/r", "o/renamed"}
	tests := []struct {
		name    string
		threads map[string][]LinkedPullRequest // absent: removed
		want    string
	}{
		{name: "direct: Claude's own record", want: "t",
			threads: map[string][]LinkedPullRequest{"t": {own("o/r", 7, LinkClaude)}}},
		{name: "direct: branch and manual links are the thread's own", want: "t",
			threads: map[string][]LinkedPullRequest{"t": {own("o/r", 6, LinkClaude), own("o/r", 7, LinkBranch)}, "c": {own("o/r", 7, LinkManual)}}},
		{name: "no link: the thread itself", want: "t",
			threads: map[string][]LinkedPullRequest{"t": {own("o/r", 8, LinkClaude), own("x/y", 7, LinkClaude)}}},
		{name: "one hop", want: "c",
			threads: map[string][]LinkedPullRequest{"t": {via("o/r", 7, "c")}, "c": {own("o/r", 7, LinkClaude)}}},
		{name: "two hops", want: "g",
			threads: map[string][]LinkedPullRequest{"t": {via("o/r", 7, "c")}, "c": {via("o/r", 7, "g")}, "g": {own("o/r", 7, LinkBranch)}}},
		{name: "an intermediate thread that linked it itself is the owner", want: "c",
			threads: map[string][]LinkedPullRequest{"t": {via("o/r", 7, "c")}, "c": {own("o/r", 7, LinkClaude)}, "g": {own("o/r", 7, LinkClaude)}}},
		{name: "a removed hop: the thread itself", want: "t",
			threads: map[string][]LinkedPullRequest{"t": {via("o/r", 7, "c")}, "g": {own("o/r", 7, LinkClaude)}}},
		{name: "a removed owner: the thread itself", want: "t",
			threads: map[string][]LinkedPullRequest{"t": {via("o/r", 7, "c")}, "c": {via("o/r", 7, "g")}}},
		{name: "a hop without the link: the thread itself", want: "t",
			threads: map[string][]LinkedPullRequest{"t": {via("o/r", 7, "c")}, "c": {own("o/r", 9, LinkClaude)}}},
		{name: "a copy without its via: the thread itself", want: "t",
			threads: map[string][]LinkedPullRequest{"t": {via("o/r", 7, "")}}},
		{name: "a cycle: the thread itself", want: "t",
			threads: map[string][]LinkedPullRequest{"t": {via("o/r", 7, "c")}, "c": {via("o/r", 7, "t")}}},
		{name: "a cycle below: the thread itself", want: "t",
			threads: map[string][]LinkedPullRequest{"t": {via("o/r", 7, "c")}, "c": {via("o/r", 7, "g")}, "g": {via("o/r", 7, "c")}}},
		{name: "the renamed slug and another case match", want: "c",
			threads: map[string][]LinkedPullRequest{"t": {via("O/Renamed", 7, "c")}, "c": {own("o/RENAMED", 7, LinkClaude)}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := LinkOwner("t", slugs, 7, func(id string) ([]LinkedPullRequest, bool) {
				ls, ok := tt.threads[id]
				return ls, ok
			})
			if got != tt.want {
				t.Errorf("owner = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestLinkOwnerDepth(t *testing.T) {
	// A chain of MaxLineageDepth hops resolves; one more answers the thread itself.
	chain := func(hops int) func(string) ([]LinkedPullRequest, bool) {
		return func(id string) ([]LinkedPullRequest, bool) {
			i, err := strconv.Atoi(id)
			if err != nil {
				return nil, false
			}
			if i == hops {
				return []LinkedPullRequest{{Slug: "o/r", Number: 1, Source: LinkClaude}}, true
			}
			return []LinkedPullRequest{{Slug: "o/r", Number: 1, Source: LinkChild, ViaThreadID: strconv.Itoa(i + 1)}}, true
		}
	}
	if got := LinkOwner("0", []string{"o/r"}, 1, chain(MaxLineageDepth)); got != strconv.Itoa(MaxLineageDepth) {
		t.Errorf("%d hops: owner = %q", MaxLineageDepth, got)
	}
	if got := LinkOwner("0", []string{"o/r"}, 1, chain(MaxLineageDepth+1)); got != "0" {
		t.Errorf("%d hops: owner = %q, want the thread itself", MaxLineageDepth+1, got)
	}
}

func TestPullRequestOwnerManager(t *testing.T) {
	e := newEnv(t)
	ids, _ := lineage(e, [][2]string{{"p", ""}, {"c", "p"}, {"g", "c"}, {"solo", ""}})
	e.m.linkPullRequests(ids["g"], childLinks(1))
	e.m.linkPullRequests(ids["p"], childLinks(2))
	owner := func(id string, n int) string {
		t.Helper()
		got, err := e.m.PullRequestOwner(e.ctx(), id, []string{"O/R"}, n)
		if err != nil {
			t.Fatal(err)
		}
		return got
	}
	if got := owner(ids["p"], 1); got != ids["g"] {
		t.Errorf("p's #1: owner = %s, want g %s", got, ids["g"])
	}
	if got := owner(ids["c"], 1); got != ids["g"] {
		t.Errorf("c's #1: owner = %s, want g", got)
	}
	if got := owner(ids["p"], 2); got != ids["p"] {
		t.Errorf("p's own #2: owner = %s, want p", got)
	}
	if got := owner(ids["solo"], 1); got != ids["solo"] {
		t.Errorf("solo, no link: owner = %s, want itself", got)
	}
	// An archived owner is still the owner (a send revives it).
	if _, err := e.m.Archive(e.ctx(), ids["g"], true); err != nil {
		t.Fatal(err)
	}
	if got := owner(ids["p"], 1); got != ids["g"] {
		t.Errorf("archived g: owner = %s, want g", got)
	}
	// A removed hop: the thread itself.
	if err := e.m.Remove(e.ctx(), ids["c"]); err != nil {
		t.Fatal(err)
	}
	if got := owner(ids["p"], 1); got != ids["p"] {
		t.Errorf("c removed: owner = %s, want p", got)
	}
	// The removed thread itself answers as Get.
	if _, err := e.m.PullRequestOwner(e.ctx(), ids["c"], []string{"o/r"}, 1); !errors.Is(err, ErrNotFound) {
		t.Errorf("removed thread: err = %v, want not found", err)
	}
}

func TestAddNote(t *testing.T) {
	e := newEnv(t)
	live := e.connected(CreateOptions{Name: "live"})
	stopped := e.stopped("stopped")
	for _, s := range []Thread{live, stopped} {
		it, err := e.m.AddNote(e.ctx(), s.ID, "Sent to  Child:\nfix the checks (#7)")
		if err != nil {
			t.Fatal(err)
		}
		if it.Kind != KindNote || it.Text != "Sent to Child: fix the checks (#7)" || it.ID == "" {
			t.Errorf("%s: item = %+v", s.Name, it)
		}
		items := e.waitItems(s.ID, "the note", func(items []Item) bool {
			for _, x := range items {
				if x.ID == it.ID {
					return true
				}
			}
			return false
		})
		for _, x := range items {
			if x.Kind == KindUserMessage {
				t.Errorf("%s: a note sent a message: %+v", s.Name, x)
			}
		}
		got, _ := e.m.Get(e.ctx(), s.ID)
		if got.Status == StatusBusy {
			t.Errorf("%s: a note started a turn", s.Name)
		}
	}
	if _, err := e.m.AddNote(e.ctx(), live.ID, "  \n "); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("empty note: err = %v, want invalid argument", err)
	}
	if _, err := e.m.AddNote(e.ctx(), "s-nope", "x"); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown thread: err = %v, want not found", err)
	}
}
