package thread

import (
	"errors"
	"math"
	"slices"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/alexwaumann/code-foundry/internal/claudestream"
)

func TestCleanLabels(t *testing.T) {
	for _, tc := range []struct {
		name string
		in   []string
		want []string
		err  bool
	}{
		{"none", nil, nil, false},
		{"sorted and deduplicated", []string{"b", "a", "b", " a "}, []string{"a", "b"}, false},
		{"lowercased", []string{"Feature/Login"}, []string{"feature/login"}, false},
		{"every allowed rune", []string{"a-z_0.9/x"}, []string{"a-z_0.9/x"}, false},
		{"40 runes", []string{strings.Repeat("a", 40)}, []string{strings.Repeat("a", 40)}, false},
		{"41 runes", []string{strings.Repeat("a", 41)}, nil, true},
		{"empty", []string{" "}, nil, true},
		{"space inside", []string{"a b"}, nil, true},
		{"comma", []string{"a,b"}, nil, true},
		{"unicode letter", []string{"é"}, nil, true},
		{"too many", func() []string {
			var out []string
			for i := range MaxLabels + 1 {
				out = append(out, strings.Repeat("x", i+1))
			}
			return out
		}(), nil, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := CleanLabels(tc.in)
			if (err != nil) != tc.err || (err != nil && !errors.Is(err, ErrInvalidArgument)) {
				t.Fatalf("err = %v, want error %t", err, tc.err)
			}
			if !slices.Equal(got, tc.want) {
				t.Errorf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestEditLabels(t *testing.T) {
	cur := []string{"a", "b"}
	for _, tc := range []struct {
		name        string
		add, remove []string
		clear       bool
		want        []string
		err         bool
	}{
		{"add", []string{"c", "A"}, nil, false, []string{"a", "b", "c"}, false},
		{"remove", nil, []string{"a", "zz"}, false, []string{"b"}, false},
		{"add and remove", []string{"x"}, []string{"b"}, false, []string{"a", "x"}, false},
		{"clear", nil, nil, true, nil, false},
		{"clear then add", []string{"x"}, nil, true, []string{"x"}, false},
		// Remove goes before add, so a label in both is on the thread after.
		{"both add and remove", []string{"x"}, []string{"X"}, false, []string{"a", "b", "x"}, false},
		{"move between columns", []string{"kanban/review"}, []string{"kanban/todo", "kanban/review", "kanban/done"}, false, []string{"a", "b", "kanban/review"}, false},
		{"re-add a present label", []string{"a"}, []string{"a"}, false, []string{"a", "b"}, false},
		{"invalid add", []string{"no way"}, nil, false, nil, true},
		{"invalid remove", nil, []string{"no way"}, false, nil, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := EditLabels(cur, tc.add, tc.remove, tc.clear)
			if (err != nil) != tc.err {
				t.Fatalf("err = %v, want error %t", err, tc.err)
			}
			if !slices.Equal(got, tc.want) {
				t.Errorf("got %q, want %q", got, tc.want)
			}
			if !slices.Equal(cur, []string{"a", "b"}) {
				t.Errorf("cur changed: %q", cur)
			}
		})
	}
}

func TestCleanReport(t *testing.T) {
	big := `{"k":"` + strings.Repeat("x", MaxReportDataBytes) + `"}`
	for _, tc := range []struct {
		name string
		in   Report
		want Report
		err  bool
	}{
		{"status only", Report{Status: ReportDone}, Report{Status: ReportDone}, false},
		{"trimmed summary", Report{Status: ReportBlocked, Summary: "  need a key \n"}, Report{Status: ReportBlocked, Summary: "need a key"}, false},
		{"data compacted", Report{Status: ReportProgress, Data: " {\n  \"n\": 1,\n  \"a\": [1, 2]\n}\n"}, Report{Status: ReportProgress, Data: `{"n":1,"a":[1,2]}`}, false},
		{"blank data", Report{Status: ReportFailed, Data: "  "}, Report{Status: ReportFailed}, false},
		{"empty object", Report{Status: ReportDone, Data: "{}"}, Report{Status: ReportDone, Data: "{}"}, false},
		{"no status", Report{Summary: "x"}, Report{}, true},
		{"unknown status", Report{Status: 9}, Report{}, true},
		{"summary too long is cut", Report{Status: ReportDone, Summary: strings.Repeat("é", MaxReportSummaryRunes+200)},
			Report{Status: ReportDone, Summary: strings.Repeat("é", MaxReportSummaryRunes-1) + "…"}, false},
		{"cut drops the space before the ellipsis", Report{Status: ReportDone, Summary: strings.Repeat("a", MaxReportSummaryRunes-2) + "  " + strings.Repeat("b", 5)},
			Report{Status: ReportDone, Summary: strings.Repeat("a", MaxReportSummaryRunes-2) + "…"}, false},
		{"summary at the limit", Report{Status: ReportDone, Summary: strings.Repeat("é", MaxReportSummaryRunes)}, Report{Status: ReportDone, Summary: strings.Repeat("é", MaxReportSummaryRunes)}, false},
		{"array", Report{Status: ReportDone, Data: "[1]"}, Report{}, true},
		{"null", Report{Status: ReportDone, Data: "null"}, Report{}, true},
		{"string", Report{Status: ReportDone, Data: `"x"`}, Report{}, true},
		{"not JSON", Report{Status: ReportDone, Data: "{n:1}"}, Report{}, true},
		{"trailing garbage", Report{Status: ReportDone, Data: `{"n":1} x`}, Report{}, true},
		{"data too big", Report{Status: ReportDone, Data: big}, Report{}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := CleanReport(tc.in)
			if (err != nil) != tc.err || (err != nil && !errors.Is(err, ErrInvalidArgument)) {
				t.Fatalf("err = %v, want error %t", err, tc.err)
			}
			if got != tc.want {
				t.Errorf("got %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestReportSummaryCut(t *testing.T) {
	for _, tc := range []struct {
		name    string
		summary string
		want    int
	}{
		{"empty", "", 0},
		{"at the limit", strings.Repeat("é", MaxReportSummaryRunes), 0},
		{"at the limit once trimmed", "  " + strings.Repeat("x", MaxReportSummaryRunes) + "\n", 0},
		{"one over", strings.Repeat("é", MaxReportSummaryRunes+1), MaxReportSummaryRunes + 1},
		{"1200", strings.Repeat("x", 1200), 1200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := ReportSummaryCut(tc.summary); got != tc.want {
				t.Errorf("ReportSummaryCut = %d, want %d", got, tc.want)
			}
			cut := CutReportSummary(tc.summary)
			if n := utf8.RuneCountInString(cut); n > MaxReportSummaryRunes {
				t.Errorf("CutReportSummary has %d characters", n)
			}
			if (tc.want > 0) != strings.HasSuffix(cut, "…") {
				t.Errorf("CutReportSummary = …%q", cut[max(0, len(cut)-8):])
			}
		})
	}
}

func TestCleanBriefAndBudget(t *testing.T) {
	if b, err := CleanBrief("  fix the login  "); err != nil || b != "fix the login" {
		t.Errorf("CleanBrief = %q, %v", b, err)
	}
	if _, err := CleanBrief(strings.Repeat("é", MaxBriefRunes)); err != nil {
		t.Errorf("500 runes: %v", err)
	}
	if _, err := CleanBrief(strings.Repeat("é", MaxBriefRunes+1)); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("501 runes: %v", err)
	}
	for _, v := range []float64{-1, math.NaN(), math.Inf(1)} {
		if err := CheckBudget(v); !errors.Is(err, ErrInvalidArgument) {
			t.Errorf("CheckBudget(%v) = %v", v, err)
		}
	}
	for _, v := range []float64{0, 0.0001, 5} {
		if err := CheckBudget(v); err != nil {
			t.Errorf("CheckBudget(%v) = %v", v, err)
		}
	}
	for v, want := range map[float64]string{0: "$0.00", 5: "$5.00", 0.5: "$0.50", 12.345: "$12.35", 0.0001: "$0.0001", 0.005: "$0.005"} {
		if got := FormatUSD(v); got != want {
			t.Errorf("FormatUSD(%v) = %q, want %q", v, got, want)
		}
	}
	if got := createdByNoteText("Parent", ""); got != "Created by Parent" {
		t.Errorf("note = %q", got)
	}
	if got := createdByNoteText("Parent", "fix it"); got != "Created by Parent · brief: fix it" {
		t.Errorf("note = %q", got)
	}
}

func TestCreateRecordsMetadataAndNote(t *testing.T) {
	e := newEnv(t)
	parent := e.connected(CreateOptions{Name: "Parent"})
	child := e.create(CreateOptions{CreatedBy: parent.ID, Brief: "  say hi  ", Labels: []string{"test", "Agent", "test"},
		BudgetUSD: 2.5, InitialPrompt: "hello there"})
	if child.CreatedBy != parent.ID || child.CreatedByName != "Parent" || child.Brief != "say hi" ||
		!slices.Equal(child.Labels, []string{"agent", "test"}) || child.BudgetUSD != 2.5 || child.BudgetHitUSD != 0 {
		t.Fatalf("child = %+v", child)
	}
	items := e.waitItems(child.ID, "the first message", func(items []Item) bool {
		return slices.ContainsFunc(items, func(it Item) bool { return it.Kind == KindUserMessage })
	})
	if items[0].ID != createdByNoteID || items[0].Kind != KindNote || items[0].Text != "Created by Parent · brief: say hi" || items[0].Ordinal != 1 ||
		items[0].NoteCreatedBy != parent.ID {
		t.Fatalf("first item = %+v", items[0])
	}
	if items[1].Kind != KindUserMessage {
		t.Errorf("second item = %+v", items[1])
	}

	// The name is kept verbatim: a rename of the creator does not change it.
	if _, err := e.m.Rename(e.ctx(), parent.ID, "Renamed"); err != nil {
		t.Fatal(err)
	}
	// An unnamed creator is named by its id; no brief, no brief part.
	anon := e.connected(CreateOptions{})
	plain := e.create(CreateOptions{CreatedBy: anon.ID})
	if plain.CreatedByName != anon.ID || plain.Brief != "" || plain.Labels != nil {
		t.Errorf("plain = %+v", plain)
	}
	if it := e.items(plain.ID).Items; len(it) == 0 || it[0].Text != "Created by "+anon.ID || it[0].NoteCreatedBy != anon.ID {
		t.Errorf("plain items = %+v", it)
	}
	// A user's thread has no note.
	user := e.create(CreateOptions{Brief: "mine"})
	if it := e.items(user.ID).Items; len(it) != 0 || user.CreatedBy != "" || user.Brief != "mine" {
		t.Errorf("user thread = %+v, items %+v", user, it)
	}

	for _, o := range []CreateOptions{
		{CreatedBy: "s-nope"},
		{Brief: strings.Repeat("x", MaxBriefRunes+1)},
		{Labels: []string{"bad label"}},
		{BudgetUSD: -1},
	} {
		o.WorktreePath = e.wt
		if _, err := e.m.Create(e.ctx(), o); !errors.Is(err, ErrInvalidArgument) {
			t.Errorf("Create(%+v) = %v, want invalid argument", o, err)
		}
	}
	n := len(e.m.Snapshot().Threads)

	e.restart()
	after, err := e.m.Get(e.ctx(), child.ID)
	if err != nil {
		t.Fatal(err)
	}
	if after.CreatedBy != parent.ID || after.CreatedByName != "Parent" || after.Brief != "say hi" ||
		!slices.Equal(after.Labels, []string{"agent", "test"}) || after.BudgetUSD != 2.5 {
		t.Errorf("after restart = %+v", after)
	}
	if it := e.items(child.ID).Items; len(it) < 2 || it[0].ID != createdByNoteID || it[0].NoteCreatedBy != parent.ID || it[1].Kind != KindUserMessage {
		t.Errorf("items after restart:\n%s", describeItems(it))
	}
	if got := len(e.m.Snapshot().Threads); got != n {
		t.Errorf("threads after restart = %d, want %d (refused creates left nothing)", got, n)
	}
}

func TestForkDoesNotSetCreatedBy(t *testing.T) {
	e := newEnv(t)
	parent := e.connected(CreateOptions{Name: "Parent"})
	child := e.connected(CreateOptions{CreatedBy: parent.ID, Labels: []string{"x"}, Brief: "b"})
	cid := argOf(e.spec(child.ID).Argv, "--session-id")
	e.writeTranscript(cid, userLine("hi"))
	e.waitFor(child.ID, "discovered", func(s Thread) bool { return s.ClaudeSessionID == cid })
	f, err := e.m.Fork(e.ctx(), child.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	if f.ParentID != child.ID || f.CreatedBy != "" || f.CreatedByName != "" || f.Brief != "" || f.Labels != nil {
		t.Errorf("fork = %+v", f)
	}
	// The fork's copy of the child's Created by note still names the creator by its id,
	// after a restart too (the copied rows).
	for _, restart := range []bool{false, true} {
		if restart {
			e.restart()
		}
		if it := e.items(f.ID).Items; len(it) == 0 || it[0].ID != createdByNoteID || it[0].NoteCreatedBy != parent.ID {
			t.Errorf("fork items (restart %v):\n%s", restart, describeItems(it))
		}
	}
}

func TestLabelReportAndBudget(t *testing.T) {
	e := newEnv(t)
	s := e.connected(CreateOptions{Labels: []string{"test"}})

	got, err := e.m.Label(e.ctx(), s.ID, []string{"x", "Y"}, []string{"test"}, false)
	if err != nil || !slices.Equal(got.Labels, []string{"x", "y"}) {
		t.Fatalf("Label = %+v, %v", got.Labels, err)
	}
	// Remove goes before add: a label in both is on the thread after (a kanban move).
	if got, err := e.m.Label(e.ctx(), s.ID, []string{"x"}, []string{"x", "y"}, false); err != nil || !slices.Equal(got.Labels, []string{"x"}) {
		t.Errorf("add and remove one label = %+v, %v", got.Labels, err)
	}
	if _, err := e.m.Label(e.ctx(), "s-nope", nil, nil, true); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown thread: %v", err)
	}

	before := time.Now().Add(-time.Second)
	got, err = e.m.Report(e.ctx(), s.ID, Report{Status: ReportProgress, Summary: "half way"})
	if err != nil || got.Report.Status != ReportProgress || got.Report.At.Before(before) {
		t.Fatalf("Report = %+v, %v", got.Report, err)
	}
	got, err = e.m.Report(e.ctx(), s.ID, Report{Status: ReportDone, Summary: "all good", Data: `{"n": 1}`})
	if err != nil || got.Report.Status != ReportDone || got.Report.Summary != "all good" || got.Report.Data != `{"n":1}` {
		t.Fatalf("Report = %+v, %v", got.Report, err)
	}
	if _, err := e.m.Report(e.ctx(), s.ID, Report{Status: ReportDone, Data: "[]"}); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("array data: %v", err)
	}

	got, err = e.m.SetBudget(e.ctx(), s.ID, 5)
	if err != nil || got.BudgetUSD != 5 {
		t.Fatalf("SetBudget = %+v, %v", got, err)
	}
	if _, err := e.m.SetBudget(e.ctx(), s.ID, -2); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("negative budget: %v", err)
	}
	// Every change is published on the thread list.
	published := false
	for !published {
		select {
		case ev := <-e.events.C():
			u, ok := ev.(Updated)
			published = ok && u.Thread.ID == s.ID && u.Thread.BudgetUSD == 5 && u.Thread.Report.Status == ReportDone &&
				slices.Equal(u.Thread.Labels, []string{"x"})
		case <-time.After(5 * time.Second):
			t.Fatal("no Updated with the labels, the report and the budget")
		}
	}

	e.restart()
	after, err := e.m.Get(e.ctx(), s.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(after.Labels, []string{"x"}) || after.Report.Status != ReportDone || after.Report.Summary != "all good" ||
		after.Report.Data != `{"n":1}` || !after.Report.At.Equal(got.Report.At.Truncate(time.Millisecond)) || after.BudgetUSD != 5 {
		t.Errorf("after restart = %+v", after)
	}
	got, err = e.m.Label(e.ctx(), s.ID, nil, nil, true)
	if err != nil || got.Labels != nil {
		t.Errorf("clear = %+v, %v", got.Labels, err)
	}
}

// interruptsSent counts the interrupt control requests the daemon wrote.
func (e *env) interruptsSent() int {
	n := 0
	for _, m := range e.sent() {
		if r, _ := m["request"].(map[string]any); r["subtype"] == "interrupt" {
			n++
		}
	}
	return n
}

func TestBudgetStop(t *testing.T) {
	// interrupt-pending: the turn holds at a permission prompt until interrupted, then
	// ends interrupted.
	e := newFixtureEnv(t, "interrupt-pending")
	s := e.create(CreateOptions{BudgetUSD: 0.001, InitialPrompt: "write hello.txt"})
	e.waitFor(s.ID, "the permission prompt", func(s Thread) bool { return strings.HasPrefix(s.StatusReason, "permission:") })
	cid := argOf(e.spec(s.ID).Argv, "--session-id")
	// $0.0002 at Sonnet 5.5's input rate: under the budget, nothing happens.
	e.writeTranscript(cid, userLine("write hello.txt"), usageLine("r1", "2026-10-17T00:00:00Z", cid, "claude-sonnet-5-5", 100, 0, 0, 0, "", ""))
	e.writeTranscript(cid, sentinelLink)
	e.waitFor(s.ID, "sentinel read", linkedSentinel)
	if n := e.interruptsSent(); n != 0 {
		t.Fatalf("interrupted under the budget (%d)", n)
	}
	// $0.002 more: over it while Claude works.
	e.writeTranscript(cid, usageLine("r2", "2026-10-17T00:00:01Z", cid, "claude-sonnet-5-5", 1000, 0, 0, 0, "", ""))
	e.waitSent("interrupt", func(m map[string]any) bool {
		r, _ := m["request"].(map[string]any)
		return r["subtype"] == "interrupt"
	})
	got := e.waitFor(s.ID, "budget reached", func(s Thread) bool {
		return s.Status == StatusNeedsAttention && s.StatusReason == ReasonBudgetReached
	})
	if got.BudgetHitUSD != 0.001 || got.State != StateConnected {
		t.Errorf("thread = %+v", got)
	}
	items := e.waitItems(s.ID, "the turn end", hasTurnEnd)
	note, ok := lastKind(items, KindNote)
	if !ok || note.Text != "Code Foundry stopped this turn: the spending limit of $0.001 was reached; nothing was rejected by the user. "+
		"Raise it with `code-foundry thread budget`, then send a message to continue." {
		t.Errorf("note = %+v\n%s", note, describeItems(items))
	}
	// The turn ended and the status stays until the next message.
	time.Sleep(50 * time.Millisecond)
	if cur, _ := e.m.Get(e.ctx(), s.ID); cur.StatusReason != ReasonBudgetReached {
		t.Errorf("after the turn = %s %q", cur.Status, cur.StatusReason)
	}

	// Once per budget value: more usage over the same budget does not interrupt again.
	if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "again"}); err != nil {
		t.Fatal(err)
	}
	e.waitFor(s.ID, "working again", func(s Thread) bool { return s.StatusReason != ReasonBudgetReached })
	e.writeTranscript(cid, usageLine("r3", "2026-10-17T00:00:02Z", cid, "claude-sonnet-5-5", 1000, 0, 0, 0, "", ""))
	e.writeTranscript(cid, strings.Replace(sentinelLink, "999", "998", 2))
	e.waitFor(s.ID, "second sentinel", func(s Thread) bool { return len(s.LinkedPullRequests) == 2 })
	if n := e.interruptsSent(); n != 1 {
		t.Errorf("interrupts = %d, want 1", n)
	}

	// A budget at or under the cost keeps the marker; one above re-arms the stop.
	cost := UsageCost(e.waitFor(s.ID, "usage", func(s Thread) bool { return totalRequests(s.Usage) == 3 }).Usage)
	if got, _ := e.m.SetBudget(e.ctx(), s.ID, cost/2); got.BudgetHitUSD != 0.001 {
		t.Errorf("under the cost: hit = %v", got.BudgetHitUSD)
	}
	if got, _ := e.m.SetBudget(e.ctx(), s.ID, cost*2); got.BudgetHitUSD != 0 {
		t.Errorf("above the cost: hit = %v", got.BudgetHitUSD)
	}
	if got, _ := e.m.SetBudget(e.ctx(), s.ID, 0.001); got.BudgetHitUSD != 0 {
		t.Errorf("hit = %v", got.BudgetHitUSD)
	}
	e.restart()
	if after, _ := e.m.Get(e.ctx(), s.ID); after.BudgetUSD != 0.001 || after.BudgetHitUSD != 0 {
		t.Errorf("after restart = %v / %v", after.BudgetUSD, after.BudgetHitUSD)
	}
}

func TestBudgetStatus(t *testing.T) {
	var d streamStatus
	d.initialized()
	d.sent(true)
	d.budget = true
	if st, r := d.Status(); st != StatusNeedsAttention || r != ReasonBudgetReached {
		t.Fatalf("stopping: %s %q", st, r)
	}
	d.Acknowledge() // seen before the turn ended: stays
	d.event(interruptedResult())
	if _, r := d.Status(); r != ReasonBudgetReached {
		t.Fatalf("after the result: %q", r)
	}
	d.Acknowledge()
	if st, r := d.Status(); st != StatusIdle || r != "at prompt" {
		t.Errorf("seen: %s %q", st, r)
	}

	d.sent(true)
	d.budget = true
	d.event(interruptedResult())
	d.turnStarted() // Claude starts a turn by itself
	if st, r := d.Status(); st != StatusBusy || r != "working" {
		t.Errorf("own turn: %s %q", st, r)
	}

	d.budget, d.budgetEnded = true, false
	d.sent(true)
	if st, _ := d.Status(); st != StatusBusy {
		t.Errorf("a message clears it: %s", st)
	}
}

func interruptedResult() claudestream.Event {
	return claudestream.Parse([]byte(`{"type":"result","subtype":"error_during_execution","is_error":true,"terminal_reason":"aborted_streaming"}`))
}
