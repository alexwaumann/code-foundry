package gh

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
)

func labelsOf(ws []monthWindow) []string {
	out := make([]string, len(ws))
	for i, w := range ws {
		out[i] = w.Label
	}
	return out
}

// fullStats holds every month of the six up to at, fetched (current and closed) at at.
func fullStats(at time.Time) MonthlyStats {
	st := MonthlyStats{FetchedAt: at, ClosedAt: at}
	for _, w := range monthWindows(at, statsMonths) {
		st.Months = append(st.Months, MonthCount{Month: w.Label, Source: CommitsFromSearch})
	}
	return st
}

// columns returns the stats' labels, commits, and merged counts, newest first.
func columns(st MonthlyStats) (labels []string, commits, merged []int) {
	for _, m := range st.Months {
		labels = append(labels, m.Month)
		commits = append(commits, m.Commits)
		merged = append(merged, m.Merged)
	}
	return labels, commits, merged
}

func TestMonthWindowsSix(t *testing.T) {
	est := time.FixedZone("EST", -5*3600)
	tests := []struct {
		name   string
		now    time.Time
		labels string
		first  string // months[0].searchRange()
		last   string // months[5].searchRange()
	}{
		{name: "across a year boundary", now: time.Date(2027, 2, 10, 9, 0, 0, 0, est),
			labels: "[2027-02 2027-01 2026-12 2026-11 2026-10 2026-09]",
			first:  "2027-02-01T00:00:00-05:00..2027-02-28T23:59:59-05:00",
			last:   "2026-09-01T00:00:00-05:00..2026-09-30T23:59:59-05:00"},
		{name: "first second of a year", now: time.Date(2027, 1, 1, 0, 0, 0, 0, est),
			labels: "[2027-01 2026-12 2026-11 2026-10 2026-09 2026-08]",
			first:  "2027-01-01T00:00:00-05:00..2027-01-31T23:59:59-05:00",
			last:   "2026-08-01T00:00:00-05:00..2026-08-31T23:59:59-05:00"},
		{name: "leap February inside", now: time.Date(2028, 6, 30, 23, 59, 59, 0, time.UTC),
			labels: "[2028-06 2028-05 2028-04 2028-03 2028-02 2028-01]",
			first:  "2028-06-01T00:00:00+00:00..2028-06-30T23:59:59+00:00",
			last:   "2028-01-01T00:00:00+00:00..2028-01-31T23:59:59+00:00"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ws := monthWindows(tt.now, statsMonths)
			if got := fmt.Sprint(labelsOf(ws)); got != tt.labels {
				t.Errorf("labels = %s, want %s", got, tt.labels)
			}
			if ws[0].searchRange() != tt.first || ws[5].searchRange() != tt.last {
				t.Errorf("ranges = %s / %s", ws[0].searchRange(), ws[5].searchRange())
			}
			if !ws[0].contains(tt.now) {
				t.Errorf("current month does not contain now")
			}
			// Contiguous: each month ends one second before the newer one starts.
			for i := 1; i < len(ws); i++ {
				if !ws[i].next().Equal(ws[i-1].Start) {
					t.Errorf("month %d ends %v, month %d starts %v", i, ws[i].End, i-1, ws[i-1].Start)
				}
			}
		})
	}
}

func TestClosedDue(t *testing.T) {
	now := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)
	ws := monthWindows(now, statsMonths)
	missing := fullStats(now.Add(-time.Hour))
	missing.Months = slices.Delete(missing.Months, 3, 4)
	tests := []struct {
		name string
		st   MonthlyStats
		now  time.Time
		want bool
	}{
		{"never fetched", MonthlyStats{}, now, true},
		{"fetched an hour ago", fullStats(now.Add(-time.Hour)), now, false},
		{"just under a day", fullStats(now.Add(-24*time.Hour + time.Second)), now, false},
		{"a day old", fullStats(now.Add(-24 * time.Hour)), now, true},
		{"only the current month held", MonthlyStats{Months: fullStats(now).Months[:1], FetchedAt: now, ClosedAt: now}, now, true},
		{"a closed month missing", missing, now, true},
		// Fetched 90 minutes ago, in October: on November 1st October is closed now.
		{"month rolled over", fullStats(time.Date(2026, 10, 31, 23, 0, 0, 0, time.UTC)), time.Date(2026, 11, 1, 0, 30, 0, 0, time.UTC), true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := ws
			if !tt.now.Equal(now) {
				w = monthWindows(tt.now, statsMonths)
			}
			if got := closedDue(tt.st, w, tt.now, DefaultHistoryInterval); got != tt.want {
				t.Errorf("closedDue = %t, want %t", got, tt.want)
			}
		})
	}
}

func TestMergeMonths(t *testing.T) {
	oct := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)
	nov := monthWindows(time.Date(2026, 11, 1, 0, 30, 0, 0, time.UTC), statsMonths)
	prev := MonthlyStats{}
	for i, w := range monthWindows(oct, statsMonths) {
		prev.Months = append(prev.Months, MonthCount{Month: w.Label, Commits: 10 + i, Merged: i, Source: CommitsFromSearch})
	}
	tests := []struct {
		name    string
		windows []monthWindow
		prev    MonthlyStats
		fresh   []MonthCount
		want    string
	}{
		{name: "current month replaced, closed kept", windows: monthWindows(oct, statsMonths), prev: prev,
			fresh: []MonthCount{{Month: "2026-10", Commits: 99, Merged: 7}},
			want:  "[{2026-10 99 7 } {2026-09 11 1 search} {2026-08 12 2 search} {2026-07 13 3 search} {2026-06 14 4 search} {2026-05 15 5 search}]"},
		{name: "rolled over: October kept by label until refetched, a new oldest month is zero", windows: nov, prev: prev,
			fresh: []MonthCount{{Month: "2026-11", Commits: 1, Merged: 0}},
			want:  "[{2026-11 1 0 } {2026-10 10 0 search} {2026-09 11 1 search} {2026-08 12 2 search} {2026-07 13 3 search} {2026-06 14 4 search}]"},
		{name: "nothing held", windows: monthWindows(oct, 3), fresh: []MonthCount{{Month: "2026-10", Merged: 1}},
			want: "[{2026-10 0 1 } {2026-09 0 0 } {2026-08 0 0 }]"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := fmt.Sprint(mergeMonths(tt.windows, tt.prev, tt.fresh)); got != tt.want {
				t.Errorf("got  %s\nwant %s", got, tt.want)
			}
		})
	}
	for _, tt := range []struct {
		sources []string
		want    string
	}{
		{[]string{"search", "search"}, "search"},
		{[]string{"search", "contributions"}, "contributions"},
		{[]string{"", ""}, ""},
		{[]string{"", "search"}, "search"},
	} {
		var ms []MonthCount
		for _, s := range tt.sources {
			ms = append(ms, MonthCount{Source: s})
		}
		if got := commitsSource(ms); got != tt.want {
			t.Errorf("commitsSource(%v) = %q, want %q", tt.sources, got, tt.want)
		}
	}
}

func TestMergeObserved(t *testing.T) {
	now := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)
	month := monthWindows(now, 1)[0]
	pr := func(id, author string, merged time.Time) PullRequest {
		return PullRequest{ID: id, Number: 1, Repo: "o/r", Author: author, State: PullRequestMerged, MergedAt: merged}
	}
	old := pr("PR_old", "octocat", now.Add(-2*time.Hour))
	tests := []struct {
		name       string
		prev, list []PullRequest
		want       string // the observed PR's id, or ""
	}{
		{"nothing new", []PullRequest{old}, []PullRequest{old}, ""},
		{"a new merge of the viewer's this month", []PullRequest{old}, []PullRequest{pr("PR_new", "octocat", now.Add(-time.Minute)), old}, "PR_new"},
		{"login compared without case", nil, []PullRequest{pr("PR_new", "OctoCat", now)}, "PR_new"},
		{"someone else's (reviewed or assigned)", []PullRequest{old}, []PullRequest{pr("PR_x", "someone", now), old}, ""},
		{"merged last month", nil, []PullRequest{pr("PR_sep", "octocat", month.Start.Add(-time.Second))}, ""},
		{"merge time unknown (a placeholder) counts", nil, []PullRequest{pr("PR_p", "octocat", time.Time{})}, "PR_p"},
		{"dropped out of the list", []PullRequest{old}, nil, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p, ok := mergeObserved(tt.prev, tt.list, "octocat", month)
			if got := map[bool]string{true: p.ID}[ok]; got != tt.want {
				t.Errorf("observed %q, want %q", got, tt.want)
			}
		})
	}
}

// TestPlanPollStatsMonths: a stats poll carries the current month; the closed months
// that are due follow in their own requests (globally and per repository).
func TestPlanPollStatsMonths(t *testing.T) {
	oct := time.Date(2026, 10, 17, 12, 0, 0, 0, time.Local)
	nov := time.Date(2026, 11, 1, 0, 30, 0, 0, time.Local)
	hourAgo := fullStats(oct.Add(-time.Hour))
	dayOld := fullStats(oct.Add(-25 * time.Hour))
	tests := []struct {
		name   string
		now    time.Time
		global MonthlyStats
		repos  map[string]MonthlyStats
		notDue bool
		// want: the closed-month requests, each "global" (or "-") and its repositories.
		want string
	}{
		{name: "nothing cached: everything", now: oct, want: "[global o/r o/s]"},
		{name: "closed months fresh: current only", now: oct, global: hourAgo,
			repos: map[string]MonthlyStats{"o/r": hourAgo, "o/s": hourAgo}, want: "[]"},
		{name: "a day old: everything", now: oct, global: dayOld,
			repos: map[string]MonthlyStats{"o/r": dayOld, "o/s": dayOld}, want: "[global o/r o/s]"},
		{name: "newly tracked repository: only its closed months", now: oct, global: hourAgo,
			repos: map[string]MonthlyStats{"o/r": hourAgo}, want: "[- o/s]"},
		{name: "global only", now: oct, global: dayOld,
			repos: map[string]MonthlyStats{"o/r": hourAgo, "o/s": hourAgo}, want: "[global]"},
		{name: "month rolled over", now: nov, global: fullStats(nov.Add(-90 * time.Minute)),
			repos: map[string]MonthlyStats{"o/r": fullStats(nov.Add(-90 * time.Minute)), "o/s": fullStats(nov.Add(-90 * time.Minute))},
			want:  "[global o/r o/s]"},
		{name: "not due: no stats", now: oct, notDue: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			opts := testOptions(openTestDB(t), &fakeRunner{}, nil)
			opts.StatsInterval = DefaultStatsInterval
			opts.Now = func() time.Time { return tt.now }
			s, err := New(context.Background(), opts)
			if err != nil {
				t.Fatal(err)
			}
			s.updateSnapshot(func(n *Snapshot) {
				n.Viewer.Viewer = &Viewer{ID: "A1", Login: "octocat"}
				n.Dashboard.Stats = tt.global
				for slug, st := range tt.repos {
					n.Repos[slug] = RepoState{Slug: slug, Activity: RepoActivity{Stats: st}}
				}
			})
			for _, slug := range []string{"o/r", "o/s"} {
				if err := s.Track(slug); err != nil {
					t.Fatal(err)
				}
			}
			s.mu.Lock()
			s.statsNext = tt.now
			if tt.notDue {
				s.statsNext = tt.now.Add(time.Minute)
			}
			s.mu.Unlock()
			plan, _ := s.planPoll(s.config(), tt.now)
			if tt.notDue {
				if plan.stats != nil || plan.closed != nil {
					t.Errorf("stats planned")
				}
				for _, r := range plan.repos {
					if r.months != nil {
						t.Errorf("%s: months planned without stats", r.slug)
					}
				}
				return
			}
			ws := monthWindows(tt.now, statsMonths)
			cur := fmt.Sprint(labelsOf(ws[:1]))
			if plan.stats == nil || fmt.Sprint(labelsOf(plan.stats.months)) != cur {
				t.Fatalf("poll stats = %+v, want the current month", plan.stats)
			}
			for _, r := range plan.repos {
				if fmt.Sprint(labelsOf(r.months)) != cur {
					t.Errorf("%s: poll months = %v", r.slug, labelsOf(r.months))
				}
			}
			var got []string
			closed := fmt.Sprint(labelsOf(ws[1:]))
			for _, cp := range plan.closed {
				if !cp.statsOnly || len(cp.sections) > 0 {
					t.Errorf("closed request is not stats only: %+v", cp)
				}
				switch g := labelsOf(cp.stats.months); len(g) {
				case 0:
					got = append(got, "-")
				default:
					if fmt.Sprint(g) != closed {
						t.Errorf("global closed months = %v", g)
					}
					got = append(got, "global")
				}
				for _, r := range cp.repos {
					if fmt.Sprint(labelsOf(r.months)) != closed || r.defaultBranch || r.branches != nil {
						t.Errorf("%s: closed request = %+v", r.slug, r)
					}
					got = append(got, r.slug)
				}
			}
			if fmt.Sprint(got) != tt.want {
				t.Errorf("closed requests = %v, want %s", got, tt.want)
			}
		})
	}
}

func TestClosedPlans(t *testing.T) {
	all := monthWindows(time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC), statsMonths)
	st := &statsPlan{all: all, months: all[:1], login: "octocat", author: "A1", me: "@me"}
	repos := func(n int) []repoPlan {
		var out []repoPlan
		for i := range n {
			out = append(out, repoPlan{slug: fmt.Sprintf("o/r%d", i), months: all[1:]})
		}
		return out
	}
	tests := []struct {
		name   string
		global bool
		repos  int
		want   string // per request: global months, repositories
	}{
		{"nothing due", false, 0, "[]"},
		{"global only", true, 0, "[5/0]"},
		{"global and three", true, 3, "[5/3]"},
		{"nine repositories", false, 9, "[0/4 0/4 0/1]"},
		{"global and five", true, 5, "[5/4 0/1]"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var got []string
			for _, p := range closedPlans(st, tt.global, repos(tt.repos)) {
				got = append(got, fmt.Sprintf("%d/%d", len(p.stats.months), len(p.repos)))
				doc, vars, err := p.build()
				if err != nil {
					t.Fatal(err)
				}
				checkDoc(t, tt.name, doc, vars)
				if !strings.HasPrefix(doc, "query PollStats(") || strings.Contains(doc, "search(query: $q_") {
					t.Errorf("doc = %s", doc)
				}
				// Closed months end where the next month starts; none runs to now.
				if len(p.repos) > 0 && (!strings.Contains(doc, "h0: history(author: {id: $author}, since: $h0s, until: $h0u)") || vars["h0u"] != all[0].Start.Format(time.RFC3339)) {
					t.Errorf("closed history = %s %v", doc, vars)
				}
			}
			if st.months[0].Label != all[0].Label || len(st.months) != 1 {
				t.Errorf("closedPlans changed the poll's stats plan")
			}
			if fmt.Sprint(got) != tt.want {
				t.Errorf("requests = %v, want %s", got, tt.want)
			}
		})
	}
}

func TestDecodeStatsCounts(t *testing.T) {
	all := monthWindows(time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC), statsMonths)
	plan := &pollPlan{
		repos: []repoPlan{{slug: "o/r", defaultBranch: true, months: all[:2]}, {slug: "o/s", months: all[:2]}, {slug: "o/t", months: all[:1]}},
		stats: &statsPlan{all: all, months: all[:2], login: "octocat", author: "A1", me: "@me"},
	}
	data := `{"viewer": {"id": "A1", "login": "octocat"},
		"r0": {"defaultBranchRef": null, "history": {"target": {"h0": {"totalCount": 4}, "h1": {"totalCount": 9}}}},
		"r1": {"history": null},
		"r2": {"history": {"target": {"h0": {"totalCount": 1}}}},
		"m0": {"issueCount": 3}, "m1": {"issueCount": 41},
		"r0_m0": {"issueCount": 2}, "r0_m1": {"issueCount": 140},
		"r1_m0": {"issueCount": 0}, "r1_m1": {"issueCount": 0},
		"r2_m0": null,
		"contributions": {"c0": {"totalCommitContributions": 5}, "c1": {"totalCommitContributions": 50}}}`
	partial := &PartialError{Errors: []graphQLError{{Message: "search failed", Path: []any{"r2_m0"}}}}
	res, err := decodePoll(plan, []byte(data), partial)
	if err != nil {
		t.Fatal(err)
	}
	if st := res.Stats; st.Err != nil || fmt.Sprint(st.Merged) != "[3 41]" || fmt.Sprint(st.Contrib) != "[5 50]" || !st.HasContrib {
		t.Errorf("global = %+v", st)
	}
	// Exact counts past the old 100-node list.
	if r := res.Repos["o/r"]; r.StatsErr != nil || fmt.Sprint(r.Merged) != "[2 140]" || fmt.Sprint(r.Commits) != "[4 9]" {
		t.Errorf("o/r = %+v", r)
	}
	// An empty repository (no default branch): zero commits.
	if r := res.Repos["o/s"]; r.StatsErr != nil || fmt.Sprint(r.Merged) != "[0 0]" || fmt.Sprint(r.Commits) != "[0 0]" {
		t.Errorf("o/s = %+v", r)
	}
	if r := res.Repos["o/t"]; r.Merged != nil || r.StatsErr == nil {
		t.Errorf("o/t = %+v", r)
	}
	// A global count missing fails the global part.
	res, err = decodePoll(plan, []byte(strings.Replace(data, `"m1": {"issueCount": 41},`, "", 1)), nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.Stats.Err == nil {
		t.Errorf("missing m1: want an error, got %+v", res.Stats)
	}
}

// TestPollStatsSixMonths runs the store: the first stats poll fetches six months,
// globally and per repository; later ones only the current month; the cache serves
// all six after a restart; a day later, or for a newly tracked repository, the closed
// months come again.
func TestPollStatsSixMonths(t *testing.T) {
	b := bus.New()
	act := bus.Subscribe[RepoActivityUpdated](b, 64)
	g := newFakeGitHub()
	clk := &testClock{}
	w := monthWindows(clk.now(), statsMonths)
	at := func(k int, d time.Duration) time.Time { return w[k].Start.Add(d) }
	g.setRepo("o/r", &fakeRepo{branch: "main", sha: "m1", history: map[string]int{w[0].Label: 22, w[1].Label: 127, w[5].Label: 9}})
	g.setRepo("o/other", &fakeRepo{branch: "main", sha: "k1", history: map[string]int{w[0].Label: 1}})
	g.contrib = map[string]int{w[0].Label: 50}
	g.addMerged(
		mergedItem{"o/r", at(0, time.Second)}, mergedItem{"o/r", at(1, time.Hour)}, mergedItem{"o/r", at(1, 2*time.Hour)},
		mergedItem{"o/r", at(5, time.Hour)}, mergedItem{"x/elsewhere", at(0, time.Second)},
		mergedItem{"o/r", at(5, -time.Hour)}, // seven months back: never counted
	)
	// REST search/commits answers 100 + the month's number.
	rest := func(f *fakeRunner) *restRunner {
		return &restRunner{fakeRunner: f, rest: func(path string, params map[string]string) (json.RawMessage, error) {
			if path != "search/commits" {
				return nil, fmt.Errorf("unexpected REST %s", path)
			}
			_, rng, _ := strings.Cut(params["q"], "author-date:")
			from, _, _ := strings.Cut(rng, "..")
			start, err := time.Parse(searchTimeLayout, from)
			if err != nil {
				return nil, err
			}
			return json.RawMessage(fmt.Sprintf(`{"total_count": %d}`, 100+int(start.Month()))), nil
		}}
	}
	restCommits := func(ws []monthWindow) string {
		var out []int
		for _, w := range ws {
			out = append(out, 100+int(w.Start.Month()))
		}
		return fmt.Sprint(out)
	}
	db := openTestDB(t)
	f := (&fakeRunner{}).serve(g)
	r1 := rest(f)
	opts := testOptions(db, r1, b)
	opts.StatsInterval = time.Hour
	opts.Now = clk.now
	s := startStore(t, opts)
	for _, slug := range []string{"o/r", "o/other"} {
		if err := s.Track(slug); err != nil {
			t.Fatal(err)
		}
	}
	// The first poll learns the viewer id; the stats follow at once.
	waitFor(t, "stats", func() bool { return !s.Snapshot().Repos["o/other"].Activity.Stats.FetchedAt.IsZero() })
	pollOnce(t, s, f) // settles any poll still running
	all := fmt.Sprint(labelsOf(w))
	cur := fmt.Sprint(labelsOf(w[:1]))
	// checkAsk checks the months asked for since mark (the poll and the closed-month
	// requests after it, together) and the number of documents; it returns the new mark.
	mark := 0
	checkAsk := func(what string, docs int, global string, repos map[string]string) {
		t.Helper()
		asks := g.asks()[mark:]
		mark += len(asks)
		if len(asks) != docs {
			t.Errorf("%s: %d stats documents, want %d", what, len(asks), docs)
		}
		union := fakeStatsAsk{repos: map[string][]string{}}
		for _, a := range asks {
			union.global = append(union.global, a.global...)
			for slug, ms := range a.repos {
				union.repos[slug] = append(union.repos[slug], ms...)
			}
		}
		if fmt.Sprint(union.global) != global {
			t.Errorf("%s: global months = %v, want %s", what, union.global, global)
		}
		for slug, want := range repos {
			if fmt.Sprint(union.repos[slug]) != want {
				t.Errorf("%s: %s months = %v, want %s", what, slug, union.repos[slug], want)
			}
		}
	}
	checkAsk("first", 2, all, map[string]string{"o/r": all, "o/other": all})
	check := func(what string, st MonthlyStats, commits, merged string) {
		t.Helper()
		labels, c, m := columns(st)
		if fmt.Sprint(labels) != all || fmt.Sprint(c) != commits || fmt.Sprint(m) != merged || st.LastError != "" {
			t.Errorf("%s = %v commits %v merged %v (err %q); want commits %s merged %s", what, labels, c, m, st.LastError, commits, merged)
		}
	}
	snap := s.Snapshot()
	check("global", snap.Dashboard.Stats, restCommits(w), "[2 2 0 0 0 1]")
	check("o/r", snap.Repos["o/r"].Activity.Stats, "[22 127 0 0 0 9]", "[1 2 0 0 0 1]")
	check("o/other", snap.Repos["o/other"].Activity.Stats, "[1 0 0 0 0 0]", "[0 0 0 0 0 0]")
	if src := snap.Dashboard.Stats.CommitsSource; src != CommitsFromSearch {
		t.Errorf("commits source = %q", src)
	}
	firstClosed := snap.Dashboard.Stats.ClosedAt
	r1.mu.Lock()
	if len(r1.qs) != 6 || !strings.HasPrefix(r1.qs[0], "author:@me author-date:") {
		t.Errorf("REST queries = %q", r1.qs)
	}
	r1.mu.Unlock()

	// Due again (a merge): the current month only; the closed months stay.
	g.addMerged(mergedItem{"o/r", at(0, 2*time.Second)})
	drain(act)
	s.statsDueNow("test")
	pollOnce(t, s, f)
	checkAsk("current month", 1, cur, map[string]string{"o/r": cur, "o/other": cur})
	snap = s.Snapshot()
	check("global after", snap.Dashboard.Stats, restCommits(w), "[3 2 0 0 0 1]")
	check("o/r after", snap.Repos["o/r"].Activity.Stats, "[22 127 0 0 0 9]", "[2 2 0 0 0 1]")
	if !snap.Dashboard.Stats.ClosedAt.Equal(firstClosed) {
		t.Errorf("closed months refetched: %v -> %v", firstClosed, snap.Dashboard.Stats.ClosedAt)
	}
	if n := drain(act); n != 1 {
		t.Errorf("activity events = %d, want 1 (o/r's merged count)", n)
	}
	r1.mu.Lock()
	if len(r1.qs) != 7 {
		t.Errorf("REST queries = %d, want 7", len(r1.qs))
	}
	r1.mu.Unlock()

	// Restart: the cache serves all six months before any poll.
	f2 := (&fakeRunner{}).serve(g)
	opts2 := testOptions(db, rest(f2), nil)
	opts2.StatsInterval = time.Hour
	opts2.Now = clk.now
	s2 := startStore(t, opts2)
	snap = s2.Snapshot()
	check("cached global", snap.Dashboard.Stats, restCommits(w), "[3 2 0 0 0 1]")
	check("cached o/r", snap.Repos["o/r"].Activity.Stats, "[22 127 0 0 0 9]", "[2 2 0 0 0 1]")
	for _, slug := range []string{"o/r", "o/other"} {
		if err := s2.Track(slug); err != nil {
			t.Fatal(err)
		}
	}
	s2.statsDueNow("test")
	pollOnce(t, s2, f2)
	checkAsk("after restart", 1, cur, map[string]string{"o/r": cur, "o/other": cur})

	// A day later the closed months are refetched with the current one.
	clk.advance(25 * time.Hour)
	pollOnce(t, s2, f2)
	w = monthWindows(clk.now(), statsMonths)
	all, cur = fmt.Sprint(labelsOf(w)), fmt.Sprint(labelsOf(w[:1]))
	checkAsk("a day later", 2, all, map[string]string{"o/r": all, "o/other": all})

	// A newly tracked repository gets its six months; the others the current one.
	g.setRepo("o/new", &fakeRepo{branch: "main", sha: "n1"})
	if err := s2.Track("o/new"); err != nil {
		t.Fatal(err)
	}
	pollOnce(t, s2, f2)
	checkAsk("new repository", 2, cur, map[string]string{"o/r": cur, "o/other": cur, "o/new": all})
	if st := s2.Snapshot().Repos["o/new"].Activity.Stats; len(st.Months) != statsMonths || st.ClosedAt.IsZero() {
		t.Errorf("o/new stats = %+v", st)
	}

	// Within the interval, no stats.
	pollOnce(t, s2, f2)
	checkAsk("within the interval", 0, "[]", nil)

	// A failed closed-month request: the current month still applies, the closed months
	// stay as they were (ClosedAt too), and the next stats poll asks for them again.
	clk.advance(25 * time.Hour)
	w = monthWindows(clk.now(), statsMonths)
	all, cur = fmt.Sprint(labelsOf(w)), fmt.Sprint(labelsOf(w[:1]))
	closedBefore := s2.Snapshot().Dashboard.Stats.ClosedAt
	g.failNext("PollStats", fmt.Errorf("HTTP 504: %w", ErrServerTimeout))
	pollOnce(t, s2, f2)
	checkAsk("closed request failed", 1, cur, map[string]string{"o/r": cur})
	if st := s2.Snapshot().Dashboard.Stats; !st.ClosedAt.Equal(closedBefore) || st.LastError != "" || len(st.Months) != statsMonths {
		t.Errorf("after a failed closed request: ClosedAt %v (was %v), err %q, %d months", st.ClosedAt, closedBefore, st.LastError, len(st.Months))
	}
	s2.statsDueNow("test")
	pollOnce(t, s2, f2)
	checkAsk("closed months again", 2, all, map[string]string{"o/r": all, "o/other": all, "o/new": all})
}

// TestPollStatsDueOnObservedMerge: a poll whose recently merged list gains a pull
// request the viewer merged this month makes the next poll carry the current month.
func TestPollStatsDueOnObservedMerge(t *testing.T) {
	g := newFakeGitHub()
	clk := &testClock{}
	now := clk.now()
	month := monthWindows(now, 1)[0]
	g.setRepo("o/r", &fakeRepo{branch: "main", sha: "m1"})
	merged := func(id string, n int, author string, at time.Time) {
		p := fakePR(id, "o/r", n, at)
		p.State, p.MergedAt, p.Author = PullRequestMerged, at, author
		g.addPR(p, sectionMerged)
	}
	merged("PR_1", 1, "octocat", now.Add(-time.Minute))
	f := (&fakeRunner{}).serve(g)
	opts := testOptions(openTestDB(t), f, nil)
	opts.StatsInterval = time.Hour
	opts.Now = clk.now
	s := startStore(t, opts)
	if err := s.Track("o/r"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "stats", func() bool { return !s.Snapshot().Dashboard.Stats.FetchedAt.IsZero() })
	pollOnce(t, s, f)
	base := len(g.asks())
	tests := []struct {
		name    string
		add     func()
		wantDue bool
	}{
		{"nothing new", func() {}, false},
		{"someone else's merge", func() { merged("PR_2", 2, "someone", now) }, false},
		{"the viewer's merge last month", func() { merged("PR_3", 3, "octocat", month.Start.Add(-time.Hour)) }, false},
		{"the viewer's merge this month", func() { merged("PR_4", 4, "octocat", now) }, true},
	}
	for _, tt := range tests {
		tt.add()
		pollOnce(t, s, f) // sees the list; carries no stats itself
		if n := len(g.asks()); n != base {
			t.Fatalf("%s: the observing poll carried stats", tt.name)
		}
		pollOnce(t, s, f)
		asks := g.asks()
		if due := len(asks) > base; due != tt.wantDue {
			t.Errorf("%s: stats on the next poll = %t, want %t", tt.name, due, tt.wantDue)
		}
		if len(asks) > base {
			if a := asks[len(asks)-1]; fmt.Sprint(a.global) != fmt.Sprint([]string{month.Label}) {
				t.Errorf("%s: months = %v, want the current one", tt.name, a.global)
			}
			base = len(asks)
		}
	}
}

func TestMergeMakesStatsDue(t *testing.T) {
	for _, tt := range []struct {
		name    string
		refuse  bool
		wantDue bool
	}{
		{"merged", false, true},
		{"refused", true, false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			g, _, s, clk, _ := mergeWorld(t, func(o *Options) { o.StatsInterval = time.Hour })
			if tt.refuse {
				g.refuseMerges("UNPROCESSABLE", "Pull Request is not mergeable")
			}
			later := clk.now().Add(time.Hour)
			s.mu.Lock()
			s.statsNext = later
			s.mu.Unlock()
			_, err := s.MergePullRequest(context.Background(), "o/r", 1, MergeRequest{Method: MergeSquash})
			if (err == nil) == tt.refuse {
				t.Fatalf("merge err = %v", err)
			}
			s.mu.Lock()
			due := s.statsNext.Before(later)
			s.mu.Unlock()
			if due != tt.wantDue {
				t.Errorf("stats due = %t, want %t", due, tt.wantDue)
			}
		})
	}
}
