package ember

import (
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

var (
	utc   = time.UTC
	now   = time.Date(2026, 10, 20, 14, 5, 0, 0, utc)
	today = time.Date(2026, 10, 20, 9, 0, 0, 0, utc)
)

func TestRenderBoard(t *testing.T) {
	worker := &TaskThread{ID: "s-111111111111", Name: "Add README line", Status: thread.StatusBusy, LastActivityAt: now.Add(-12 * time.Minute),
		Report: thread.Report{Status: thread.ReportProgress, Summary: "Drafting\nthe line"}}
	tasks := []Task{
		{ID: "t-00000001", Title: "Write docs", State: StateDoing, ThreadID: worker.ID, Thread: worker},
		{ID: "t-00000002", Title: "README part", State: StateDoing, ParentID: "t-00000001"},
		{ID: "t-00000003", Title: "Changelog part", State: StateTodo, ParentID: "t-00000001"},
		{ID: "t-00000004", Title: "Fix login", State: StateBlocked, Outcome: "needs a token", ThreadID: "s-222222222222",
			Thread: &TaskThread{ID: "s-222222222222", Removed: true}},
		{ID: "t-00000005", Title: "Bump deps", State: StateDone, DoneAt: today, Outcome: "merged #12"},
		{ID: "t-00000006", Title: "Old work", State: StateDone, DoneAt: today.Add(-24 * time.Hour)},
		{ID: "t-00000007", Title: "Dropped", State: StateCancelled},
	}
	timers := []Timer{
		{ID: "sub-aaaaaaaaaaaa", NextAt: now.Add(55 * time.Minute), Note: "remind the user to review the PWA branch (t-00000003)"},
		{ID: "sub-bbbbbbbbbbbb", NextAt: now.Add(2 * time.Minute), Every: 2 * time.Minute, Note: "ping the user"},
		{ID: "sub-cccccccccccc", NextAt: now.Add(24 * time.Hour)},
	}
	tests := []struct {
		name   string
		tasks  []Task
		timers []Timer
		want   []string
		not    []string
	}{
		{"empty", nil, nil, []string{"# Task board", "As of 2026-10-20 14:05 UTC.", "\nTime zone: UTC, local times.", "No tasks yet."}, []string{"## In progress", "## Scheduled"}},
		{"timers only", nil, timersOf(nil), []string{"No tasks yet."}, []string{"## Scheduled"}},
		{"every section", tasks, nil, []string{
			"## In progress\n\n- t-00000001 Write docs · worker s-111111111111 busy, report progress: Drafting the line, 12m\n  - t-00000002 README part\n",
			"## Up next\n\n- t-00000003 Changelog part\n",
			"## Blocked\n\n- t-00000004 Fix login · worker s-222222222222 removed — needs a token\n",
			"## Done today\n\n- t-00000005 Bump deps — merged #12\n",
			"Earlier: 1 done, 1 cancelled",
		}, []string{"Old work", "Dropped", "## Scheduled"}},
		{"only closed", tasks[5:], nil, []string{"Earlier: 1 done, 1 cancelled"}, []string{"No tasks yet", "## "}},
		{"a done-today parent keeps its cancelled piece", []Task{
			{ID: "t-00000010", Title: "Streaks", State: StateDone, DoneAt: today},
			{ID: "t-00000011", Title: "Counter", State: StateDone, DoneAt: today, ParentID: "t-00000010", Branch: "cf/counter", Outcome: "pushed"},
			{ID: "t-00000012", Title: "Freeze", State: StateCancelled, UpdatedAt: today.Add(-30 * time.Hour), ParentID: "t-00000010"},
			{ID: "t-00000013", Title: "Dropped today", State: StateCancelled, UpdatedAt: today},
			{ID: "t-00000014", Title: "Dropped before", State: StateCancelled, UpdatedAt: today.Add(-24 * time.Hour)},
		}, nil, []string{
			"## Done today\n\n- t-00000010 Streaks\n  - t-00000011 Counter · branch cf/counter — pushed\n  - t-00000012 Freeze\n- t-00000013 Dropped today\n",
			"Earlier: 0 done, 1 cancelled",
		}, []string{"Dropped before"}},
		// Scheduled sits before Done today, soonest first as given, the date when not today.
		{"scheduled", tasks, timers, []string{
			"## Blocked\n\n- t-00000004 Fix login · worker s-222222222222 removed — needs a token\n\n## Scheduled\n\n" +
				"Your timers; `code-foundry thread unsubscribe <id>` cancels one.\n\n" +
				"- 15:00 UTC · once · remind the user to review the PWA branch (t-00000003) · sub-aaaaaaaaaaaa\n" +
				"- 14:07 UTC · every 2m · ping the user · sub-bbbbbbbbbbbb\n" +
				"- Oct 21 14:05 UTC · once · sub-cccccccccccc\n\n## Done today\n",
		}, nil},
		{"scheduled with no tasks", nil, timers[:1], []string{"No tasks yet.", "## Scheduled", "· sub-aaaaaaaaaaaa\n"}, nil},
		// Waiting on Ember alone: a worker that reported and stopped, a parent whose pieces closed.
		{"unclosed", []Task{
			{ID: "t-00000020", Title: "Flag and changelog", State: StateDoing},
			{ID: "t-00000021", Title: "Flag", State: StateDone, DoneAt: today, ParentID: "t-00000020"},
			{ID: "t-00000022", Title: "README", State: StateDoing, ThreadID: "s-333333333333", Thread: &TaskThread{ID: "s-333333333333",
				State: thread.StateDisconnected, Status: thread.StatusNeedsAttention, StatusReason: "finished",
				Report: thread.Report{Status: thread.ReportDone, Summary: "pushed"}, LastActivityAt: now.Add(-4 * time.Minute)}},
		}, nil, []string{
			"## In progress\n\n- t-00000020 Flag and changelog · unclosed: all its pieces are closed, waiting for Ember to close it\n",
			"- t-00000022 README · unclosed: worker reported done, waiting for Ember to check · worker s-333333333333 needs attention (finished), report done: pushed, 4m\n",
		}, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := RenderBoard(tt.tasks, tt.timers, now, utc)
			for _, w := range tt.want {
				if !strings.Contains(got, w) {
					t.Errorf("board lacks %q:\n%s", w, got)
				}
			}
			for _, n := range tt.not {
				if strings.Contains(got, n) {
					t.Errorf("board has %q:\n%s", n, got)
				}
			}
		})
	}
}

func TestThreadState(t *testing.T) {
	tests := []struct {
		tt   TaskThread
		want string
	}{
		{TaskThread{Status: thread.StatusIdle}, "idle"},
		{TaskThread{Status: thread.StatusNeedsAttention, StatusReason: "permission: Bash"}, "needs attention (permission: Bash)"},
		{TaskThread{Status: thread.StatusUnknown, State: thread.StateDisconnected}, "stopped"},
		{TaskThread{Status: thread.StatusUnknown, State: thread.StateStarting}, "starting"},
		{TaskThread{Status: thread.StatusBusy, Archived: true}, "archived"},
		{TaskThread{Removed: true}, "removed"},
	}
	for _, tt := range tests {
		if got := ThreadState(&tt.tt); got != tt.want {
			t.Errorf("ThreadState(%+v) = %q, want %q", tt.tt, got, tt.want)
		}
	}
}

// The board names the zone its times are in: the IANA name and the abbreviation.
func TestZoneLine(t *testing.T) {
	cdt := time.FixedZone("CDT", -5*3600)
	if got := zoneLine(now, cdt); !strings.HasPrefix(got, "Time zone: CDT, local times.") {
		t.Errorf("fixed zone = %q", got)
	}
	chicago, err := time.LoadLocation("America/Chicago")
	if err != nil {
		t.Skip("no tzdata:", err)
	}
	if got := zoneLine(now, chicago); !strings.HasPrefix(got, "Time zone: America/Chicago (CDT), local times.") {
		t.Errorf("named zone = %q", got)
	}
	if got := RenderBoard(nil, nil, now, chicago); !strings.Contains(got, "As of 2026-10-20 09:05 CDT.") {
		t.Errorf("board in Chicago:\n%s", got)
	}
	t.Setenv("TZ", "Europe/Berlin")
	if got := ZoneName(time.Local); got != "Europe/Berlin" {
		t.Errorf("ZoneName(Local) with TZ = %q", got)
	}
}

func TestRenderSkills(t *testing.T) {
	if got := RenderSkills(""); got != "" {
		t.Errorf("no dir = %q", got)
	}
	got := RenderSkills("/h/claude/.claude/skills/code-foundry-orchestrate")
	for _, w := range []string{"## Skills", "`/h/claude/.claude/skills/code-foundry-orchestrate`", "`/h/claude/.claude/skills/code-foundry-orchestrate/reference/leads.md`", "never search the disk"} {
		if !strings.Contains(got, w) {
			t.Errorf("skills lack %q:\n%s", w, got)
		}
	}
}

func TestRenderProjects(t *testing.T) {
	threads := []ThreadLine{{ID: "s-1", Name: "Fix it", State: "idle"}, {ID: "s-2", Name: "Docs", State: "busy"}}
	tests := []struct {
		name string
		p    ProjectSeed
		want string
	}{
		{"github origin", ProjectSeed{ID: "p-1", Name: "app", Path: "/u/app", DefaultBranch: "main", Git: true, GitHubSlug: "acme/app", Threads: threads},
			"- **app** (`p-1`) · /u/app · git, default branch main, origin: GitHub (acme/app)\n  Latest threads: s-1 \"Fix it\" (idle); s-2 \"Docs\" (busy)\n"},
		{"local or other origin", ProjectSeed{ID: "p-3", Name: "tally", Path: "/u/tally", DefaultBranch: "main", Git: true},
			"- **tally** (`p-3`) · /u/tally · git, default branch main, origin: local/other (no pull requests)\n"},
		{"no default branch yet", ProjectSeed{ID: "p-4", Name: "new", Path: "/u/new", Git: true},
			"- **new** (`p-4`) · /u/new · git, origin: local/other (no pull requests)\n"},
		{"not git", ProjectSeed{ID: "p-2", Name: "notes", Path: "/u/notes"},
			"- **notes** (`p-2`) · /u/notes · not a git repository\n"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := RenderProjects([]ProjectSeed{tt.p}); !strings.Contains(got, tt.want) {
				t.Errorf("projects lack %q:\n%s", tt.want, got)
			}
		})
	}
	if got := RenderProjects(nil); !strings.Contains(got, "None yet") {
		t.Errorf("no projects = %q", got)
	}
}

func TestRenderRecent(t *testing.T) {
	var msgs []Message
	for i := range 45 {
		msgs = append(msgs, Message{At: today.Add(time.Duration(i) * time.Minute), User: i%2 == 0, Text: strings.Repeat("x", 10) + string(rune('a'+i%26))})
	}
	long := Message{At: now, User: true, Text: strings.Repeat("é", 3000)}
	tests := []struct {
		name   string
		msgs   []Message
		budget int
		want   []string
		max    int
	}{
		{"none", nil, 1000, []string{"None yet"}, 1000},
		{"the last 40", msgs, 1 << 20, []string{"the last 40 messages", "### 2026-10-20 09:05 · Ember", "### 2026-10-20 09:44 · user"}, 1 << 20},
		{"cut to the budget, oldest first", msgs, 600, []string{"### 2026-10-20 09:44 · user"}, 600},
		{"a long message is cut", []Message{long}, 1 << 20, []string{" […]"}, 3000},
		{"nothing fits", msgs, 10, []string{"None yet"}, 1000},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := RenderRecent(tt.msgs, tt.budget, utc)
			for _, w := range tt.want {
				if !strings.Contains(got, w) {
					t.Errorf("recent lacks %q:\n%s", w, got)
				}
			}
			if len(got) > tt.max {
				t.Errorf("recent has %d bytes, want at most %d", len(got), tt.max)
			}
			if strings.Contains(got, "09:04 ·") {
				t.Errorf("recent has a message older than the last 40")
			}
		})
	}
}

func TestPrefixAndSystemPrompt(t *testing.T) {
	p := Prefix("# Memory\n- likes tea", "# Task board", "# Projects", "# Recent messages")
	if !strings.HasPrefix(p, SeedHeader+"\n\n=== MEMORY.md ===\n# Memory\n- likes tea\n") {
		t.Errorf("prefix starts %q", p[:min(200, len(p))])
	}
	for _, w := range []string{"=== BOARD.md ===\n# Task board", "=== PROJECTS.md ===\n# Projects", "=== RECENT.md ===\n# Recent messages",
		"=== end of the seed; the message follows ==="} {
		if !strings.Contains(p, w) {
			t.Errorf("prefix lacks %q", w)
		}
	}
	huge := strings.Repeat("m", 100<<10)
	if b := RecentBudget(huge, huge, huge); b <= 0 || len(Prefix(huge, huge, huge, strings.Repeat("r", b))) > maxPrefix {
		t.Errorf("budget %d does not fit the prefix", b)
	}
	if b := RecentBudget("", "", ""); b != maxRecent {
		t.Errorf("empty budget = %d", b)
	}
	sp := SystemPrompt(Rules(), "# Soul\nbe kind")
	if !strings.HasPrefix(sp, "# You are Ember") || !strings.HasSuffix(sp, "# Soul\nbe kind") {
		t.Errorf("system prompt = %q…", sp[:60])
	}
	if len(Rules()) > 6<<10 {
		t.Errorf("rules.md has %d bytes; keep it under 6 KB", len(Rules()))
	}
	// ember-research-tasks: Ember reads to split and assign; a question about code is a
	// worker's research task, not Ember's own read loop.
	for _, w := range []string{"research included", "You read only to split the work and assign its files",
		"never to answer a question about code", "research task, a worker that touches nothing"} {
		if !strings.Contains(Rules(), w) {
			t.Errorf("rules.md lacks %q", w)
		}
	}
	// ember-rules-reply: the GUI folds every text but a turn's last into the work row, so
	// the last text is the reply and must stand alone; view.inline shows a page; Ember
	// edits files only for a piece the user explicitly tells it to do itself.
	for _, w := range []string{"The user sees only your turn's last text", "the reply must stand alone",
		"`code-foundry view.inline <path>`", "/cf/theme.css", "the text before a pending question is what shows",
		"On your own initiative, never edit", "explicitly tells you to do a piece yourself", "say so in your reply"} {
		if !strings.Contains(Rules(), w) {
			t.Errorf("rules.md lacks %q", w)
		}
	}
	if w := "Write nothing between tool calls"; strings.Contains(Rules(), w) {
		t.Errorf("rules.md still has %q", w)
	}
	if w := "never edits files, builds or pushes itself"; strings.Contains(defaultSoul, w) {
		t.Errorf("soul.md still has %q", w)
	}
	if big := SystemPrompt(Rules(), strings.Repeat("s", 60<<10)); len(big) > maxSystemPrompt || !strings.HasSuffix(big, "too long]") {
		t.Errorf("a long soul: %d bytes", len(big))
	}
}

func TestAge(t *testing.T) {
	for d, want := range map[time.Duration]string{
		10 * time.Second: "now", 5 * time.Minute: "5m", 3 * time.Hour: "3h", 47 * time.Hour: "47h", 72 * time.Hour: "3d",
	} {
		if got := Age(d); got != want {
			t.Errorf("Age(%v) = %q, want %q", d, got, want)
		}
	}
}

func TestTruncate(t *testing.T) {
	if got := truncate("ééé", 5, "…"); got != "é…" {
		t.Errorf("truncate = %q", got)
	}
	if got := truncate("abc", 5, "…"); got != "abc" {
		t.Errorf("truncate = %q", got)
	}
}

// timersOf keeps a subscriber's timers, soonest first.
func TestTimersOf(t *testing.T) {
	subs := []thread.Subscription{
		{ID: "sub-1", TargetKind: thread.TargetThread, TargetID: "s-1"},
		{ID: "sub-3", TargetKind: thread.TargetTimer, TargetID: "every:2m", NextAt: now.Add(2 * time.Minute), Every: 2 * time.Minute, Note: "ping"},
		{ID: "sub-2", TargetKind: thread.TargetTimer, TargetID: "at:x", NextAt: now.Add(time.Minute), CreatedAt: today},
	}
	got := timersOf(subs)
	if len(got) != 2 || got[0] != (Timer{ID: "sub-2", NextAt: now.Add(time.Minute), CreatedAt: today}) ||
		got[1] != (Timer{ID: "sub-3", NextAt: now.Add(2 * time.Minute), Every: 2 * time.Minute, Note: "ping"}) {
		t.Errorf("timersOf = %+v", got)
	}
	if timersOf(subs[:1]) != nil {
		t.Error("no timers is not nil")
	}
}
