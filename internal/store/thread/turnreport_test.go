package thread

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestTurnReport(t *testing.T) {
	t0 := time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)
	now := t0.Add(time.Minute)
	finished := Report{Status: ReportFinished, Summary: "Pushed it. Tests pass.", At: now}
	tests := []struct {
		name string
		rep  Report
		want Report
	}{
		{"none: the daemon files it", Report{}, finished},
		{"done in this turn stays", Report{Status: ReportDone, Summary: "x", At: t0.Add(time.Second)}, Report{Status: ReportDone, Summary: "x", At: t0.Add(time.Second)}},
		{"blocked in this turn stays", Report{Status: ReportBlocked, Summary: "x", At: t0}, Report{Status: ReportBlocked, Summary: "x", At: t0}},
		{"progress in this turn stays", Report{Status: ReportProgress, Summary: "x", At: t0}, Report{Status: ReportProgress, Summary: "x", At: t0}},
		{"done from an earlier turn is replaced", Report{Status: ReportDone, Summary: "old", At: t0.Add(-time.Hour)}, finished},
		{"finished from an earlier turn is replaced", Report{Status: ReportFinished, Summary: "old", At: t0.Add(-time.Hour)}, finished},
		{"finished after the last message moves on: a turn Claude started itself", Report{Status: ReportFinished, Summary: "old", At: t0.Add(time.Second)}, finished},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := turnReport(tt.rep, t0, "Pushed it.\nTests pass.", now); got != tt.want {
				t.Errorf("got %+v, want %+v", got, tt.want)
			}
		})
	}
	long := turnReport(Report{}, t0, strings.Repeat("a", MaxReportSummaryRunes+50), now)
	if n := len([]rune(long.Summary)); n > MaxReportSummaryRunes {
		t.Errorf("summary is %d runes", n)
	}
}

// The lead hold and Ember read final() and must not take the daemon's word for the end of
// a task: a lead that ends a turn with workers running files finished too.
func TestReportFinal(t *testing.T) {
	for st, want := range map[ReportStatus]bool{ReportNone: false, ReportProgress: false, ReportFinished: false, ReportDone: true, ReportFailed: true, ReportBlocked: true} {
		if st.final() != want {
			t.Errorf("%s final = %v", st, !want)
		}
	}
	finished := Thread{Status: StatusNeedsAttention, StatusReason: "finished", Report: Report{Status: ReportFinished}}
	p := threadWakePart{sub: Subscription{Condition: CondSettled}, t: finished, d: wakeDetail{children: wakeChildren{Working: 1, Total: 1}}}
	if !heldLeadWake(p) {
		t.Error("a lead's finished turn with workers running is not held")
	}
}

// A finished report is about a turn that ended. A thread busy at a stop with one is in a turn
// Claude started itself, and that turn was cut.
func TestFinishedDoesNotCoverACutTurn(t *testing.T) {
	t0 := time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)
	items := []Item{{Kind: KindUserMessage, CreatedAt: t0}}
	if reportCoversTurn(Report{Status: ReportFinished, At: t0.Add(time.Minute)}, items) {
		t.Error("finished covers the turn")
	}
	if !reportCoversTurn(Report{Status: ReportDone, At: t0.Add(time.Minute)}, items) {
		t.Error("done does not cover the turn")
	}
}

// A message that reached the thread after the wake fired does not take its last message away.
func TestItemsUntil(t *testing.T) {
	t0 := time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)
	items := []Item{{Kind: KindUserMessage, CreatedAt: t0}, {Kind: KindAssistantText, Text: "Done.", CreatedAt: t0.Add(time.Second)},
		{Kind: KindTurnEnd, CreatedAt: t0.Add(time.Second)}, {Kind: KindUserMessage, CreatedAt: t0.Add(3 * time.Second)}}
	_, _, text := lastTurn(itemsUntil(items, t0.Add(2*time.Second)))
	if text != "Done." {
		t.Errorf("text = %q", text)
	}
	if n := len(itemsUntil(items, t0.Add(time.Minute))); n != 4 {
		t.Errorf("%d items", n)
	}
}

func TestOwnAppend(t *testing.T) {
	tests := []struct {
		name string
		s    Thread
		want string
	}{
		{"a user's thread", Thread{}, ""},
		{"a user's thread with its own", Thread{SystemPromptAppend: "own"}, "own"},
		{"a created thread", Thread{CreatedBy: "s-1"}, CreatedThreadPrompt},
		{"a created thread with its own", Thread{CreatedBy: "s-1", SystemPromptAppend: "own"}, CreatedThreadPrompt + "\n\nown"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ownAppend(tt.s); got != tt.want {
				t.Errorf("got %q", got)
			}
		})
	}
}

func TestWakeReportLeftOut(t *testing.T) {
	at := time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)
	sub := Subscription{ID: "sub-1", Condition: CondSettled}
	th := Thread{ID: "s-1", Status: StatusIdle}
	th.Report = Report{Status: ReportFinished, Summary: "head", At: at}
	if p := threadWakePayload(sub, th, at, wakeDetail{lastMessage: "head and tail"}); p.Thread.Report != nil || p.Thread.LastMessage != "head and tail" {
		t.Errorf("finished: %+v", p.Thread)
	}
	th.Report.Status = ReportDone
	if p := threadWakePayload(sub, th, at, wakeDetail{staleReport: true}); p.Thread.Report != nil {
		t.Errorf("stale: %+v", p.Thread.Report)
	}
	if p := threadWakePayload(sub, th, at, wakeDetail{}); p.Thread.Report == nil {
		t.Error("a current report was left out")
	}
}

func TestParseShortstat(t *testing.T) {
	tests := []struct {
		in      string
		f, a, d int
	}{
		{" 3 files changed, 41 insertions(+), 2 deletions(-)", 3, 41, 2},
		{" 1 file changed, 1 insertion(+)", 1, 1, 0},
		{" 2 files changed, 7 deletions(-)", 2, 0, 7},
		{"", 0, 0, 0},
	}
	for _, tt := range tests {
		if f, a, d := parseShortstat(tt.in); f != tt.f || a != tt.a || d != tt.d {
			t.Errorf("%q = %d %d %d", tt.in, f, a, d)
		}
	}
}

// Against a real repository: a local branch, then pushed, then behind its push, then dirty.
func TestGitCheckoutFacts(t *testing.T) {
	dir := t.TempDir()
	origin, repo := filepath.Join(dir, "origin.git"), filepath.Join(dir, "repo")
	git := func(d string, args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", d}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@e", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@e")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	write := func(name, text string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(repo, name), []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(repo, 0o700); err != nil {
		t.Fatal(err)
	}
	git(dir, "init", "--bare", "--initial-branch=main", origin)
	git(repo, "init", "--initial-branch=main")
	write("a.txt", "one\n")
	git(repo, "add", ".")
	git(repo, "commit", "-m", "one")
	git(repo, "remote", "add", "origin", origin)
	git(repo, "push", "origin", "main")
	git(repo, "switch", "-c", "cf/work")
	write("a.txt", "two\nthree\n")
	git(repo, "commit", "-am", "two")

	ctx := context.Background()
	f, ok := gitCheckoutFacts(ctx, repo, "main")
	if !ok || f.Branch != "cf/work" || f.Head == "" || f.Pushed || f.Unpushed != 1 || f.Base != "origin/main" || f.Files != 1 || f.Added != 2 || f.Deleted != 1 {
		t.Fatalf("before the push: %+v %v", f, ok)
	}
	git(repo, "push", "origin", "HEAD")
	if f, _ = gitCheckoutFacts(ctx, repo, "main"); !f.Pushed || f.Unpushed != 0 || f.touched() != true {
		t.Fatalf("pushed: %+v", f)
	}
	write("a.txt", "four\n")
	write("b.txt", "new\n")
	git(repo, "commit", "-m", "three", "a.txt")
	if f, _ = gitCheckoutFacts(ctx, repo, "main"); f.Pushed || f.Unpushed != 1 || f.Uncommitted != 1 {
		t.Fatalf("ahead of its push, with an untracked file: %+v", f)
	}
	// No default branch known yet: what can be read still is.
	if f, ok = gitCheckoutFacts(ctx, repo, ""); !ok || f.Base != "" || f.Files != 0 || f.Unpushed != 1 {
		t.Fatalf("no base: %+v %v", f, ok)
	}
	if _, ok := gitCheckoutFacts(ctx, filepath.Join(dir, "missing"), "main"); ok {
		t.Fatal("a missing folder has facts")
	}
}

// End to end on the fake claude: a created thread's turn ends without a report, the daemon
// files finished, and its creator's wake has the whole message and the git facts.
func TestCreatedThreadTurnEndsInAReport(t *testing.T) {
	e := newFixtureEnvAt(t, fixturePath("text-table"), nil, func(o *Options) {
		o.CheckoutFacts = func(context.Context, string, string) (CheckoutFacts, bool) {
			return CheckoutFacts{Branch: "cf/work", Head: "3f2a1c", Pushed: true, Files: 2}, true
		}
	})
	parent := e.stopped("parent")
	kid := e.create(CreateOptions{Name: "kid", InitialPrompt: "go", CreatedBy: parent.ID, Notify: true})
	s := e.waitFor(kid.ID, "the daemon's report", func(s Thread) bool { return s.Report.Status == ReportFinished })
	if s.Report.At.IsZero() {
		t.Errorf("report = %+v", s.Report)
	}
	items := e.waitItems(parent.ID, "the wake", func(items []Item) bool { return len(wakes(items)) == 1 })
	w := wakes(items)[0]
	if !strings.Contains(w.WakeJSON, `"last_message"`) || strings.Contains(w.WakeJSON, `"report": {`) {
		t.Errorf("wake json:\n%s", w.WakeJSON)
	}
}

// A user's own thread gets no report it did not file.
func TestUserThreadTurnFilesNoReport(t *testing.T) {
	e := newFixtureEnvAt(t, fixturePath("text-table"), nil)
	s := e.create(CreateOptions{Name: "mine", InitialPrompt: "go"})
	e.waitItems(s.ID, "the turn end", func(items []Item) bool { return turnEnds(items) == 1 })
	time.Sleep(50 * time.Millisecond)
	if got, _ := e.m.Snapshot().Thread(s.ID); got.Report.Status != ReportNone {
		t.Errorf("report = %+v", got.Report)
	}
}
