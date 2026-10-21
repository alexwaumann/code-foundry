package ember

import (
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// The seed's parts are rendered by the pure functions here (tested on fixtures); the
// store gathers their input (seed.go).

// Seed bounds. The prefix goes on the first message of a fresh session (at most 256 KiB
// in the thread store); the system prompt append on claude's command line (64 KiB).
const (
	// maxSystemPrompt caps rules.md and SOUL.md together.
	maxSystemPrompt = 48 << 10
	// maxPrefix is what the seed prefix may reach, under the thread store's 256 KiB.
	maxPrefix = 250 << 10
	// maxMemory caps MEMORY.md, in the prefix and from consolidation.
	maxMemory = 32 << 10
	// maxBoard and maxProjects cap BOARD.md and PROJECTS.md in the prefix.
	maxBoard    = 32 << 10
	maxProjects = 16 << 10
	// maxRecent caps RECENT.md; maxRecentMessages and maxMessageBytes its messages.
	maxRecent         = 200 << 10
	maxRecentMessages = 40
	maxMessageBytes   = 2 << 10
	// recentThreads is how many threads PROJECTS.md lists per project.
	recentThreads = 3
)

// SeedHeader starts every seed prefix.
const SeedHeader = "[code-foundry ember seed] You are starting a new epoch; your earlier context is gone but the user's chat continues. Read on, then answer the message at the end."

// Message is one visible message of Ember's chat: the user's text or Ember's reply.
type Message struct {
	At time.Time
	// User: the user wrote it; else it is Ember's.
	User bool
	Text string
}

// ProjectSeed is a project as PROJECTS.md lists it.
type ProjectSeed struct {
	ID, Name, Path, DefaultBranch string
	Git                           bool
	// GitHubSlug is "owner/name" when origin is on GitHub (pull requests possible).
	GitHubSlug string
	// Threads are its latest threads the user sees, newest first (at most
	// recentThreads).
	Threads []ThreadLine
}

// ThreadLine is one thread of a project in PROJECTS.md.
type ThreadLine struct {
	ID, Name, State string
}

// SystemPrompt is Ember's system prompt append: the built-in rules, then the user's
// SOUL.md, cut to maxSystemPrompt.
func SystemPrompt(rules, soul string) string {
	out := strings.TrimSpace(rules)
	if soul = strings.TrimSpace(soul); soul != "" {
		out += "\n\n" + soul
	}
	return truncate(out, maxSystemPrompt, "\n\n[SOUL.md cut here: it is too long]")
}

// Prefix is a seed prefix: the header, then each part under a marker line, in order:
// MEMORY.md, BOARD.md, PROJECTS.md, RECENT.md. recent is cut (oldest messages first, by
// RenderRecent's caller) to fit maxPrefix; the others are capped on their own.
func Prefix(memory, board, projects, recent string) string {
	var b strings.Builder
	b.WriteString(SeedHeader + "\n")
	part := func(name, body string) {
		fmt.Fprintf(&b, "\n=== %s ===\n%s\n", name, strings.TrimSpace(body))
	}
	part("MEMORY.md", truncate(memory, maxMemory, "\n[MEMORY.md cut here]"))
	part("BOARD.md", truncate(board, maxBoard, "\n[BOARD.md cut here: `code-foundry ember board` prints it whole]"))
	part("PROJECTS.md", truncate(projects, maxProjects, "\n[PROJECTS.md cut here: `code-foundry project list` prints every project]"))
	part("RECENT.md", recent)
	b.WriteString("\n=== end of the seed; the message follows ===")
	return b.String()
}

// RecentBudget is how many bytes RECENT.md may take in a prefix with the other parts.
func RecentBudget(memory, board, projects string) int {
	used := len(Prefix(memory, board, projects, ""))
	return max(0, min(maxRecent, maxPrefix-used))
}

// RenderRecent is RECENT.md: the last maxRecentMessages messages, oldest first, each cut
// to maxMessageBytes, dropping the oldest until it fits in budget bytes.
func RenderRecent(msgs []Message, budget int, loc *time.Location) string {
	if len(msgs) > maxRecentMessages {
		msgs = msgs[len(msgs)-maxRecentMessages:]
	}
	entries := make([]string, len(msgs))
	for i, m := range msgs {
		who := "Ember"
		if m.User {
			who = "user"
		}
		text := truncate(strings.TrimSpace(m.Text), maxMessageBytes, " […]")
		entries[i] = fmt.Sprintf("### %s · %s\n%s\n", m.At.In(loc).Format("2006-01-02 15:04"), who, text)
	}
	head := func(n int) string {
		if n == 0 {
			return "# Recent messages\n\nNone yet: this is your first conversation with the user.\n"
		}
		return fmt.Sprintf("# Recent messages\n\nYour chat with the user, the last %d messages, oldest first (wakes and tool calls left out).\n\n", n)
	}
	for len(entries) > 0 {
		out := head(len(entries)) + strings.Join(entries, "\n")
		if len(out) <= budget {
			return out
		}
		entries = entries[1:]
	}
	return head(0)
}

// RenderBoard is BOARD.md: the tasks (in board order) by section: In progress (doing),
// Up next (todo), Blocked, Scheduled (the timers, soonest first), Done today (done or
// cancelled since local midnight, as the GUI's board, with a closed subtask of such a
// parent whenever it closed); a subtask under its parent when both are in one section,
// else marked as part of it; then a line counting the other done and cancelled tasks.
func RenderBoard(tasks []Task, timers []Timer, now time.Time, loc *time.Location) string {
	var b strings.Builder
	b.WriteString("# Task board\n\n")
	fmt.Fprintf(&b, "As of %s. `code-foundry ember board` prints it live; `ember task show <id>` one task.\n", now.In(loc).Format("2006-01-02 15:04 MST"))
	b.WriteString(zoneLine(now, loc))
	y, m, d := now.In(loc).Date()
	midnight := time.Date(y, m, d, 0, 0, 0, 0, loc)
	closedToday := func(t Task) bool {
		switch t.State {
		case StateDone:
			return !t.DoneAt.Before(midnight)
		case StateCancelled:
			return !t.UpdatedAt.Before(midnight)
		}
		return false
	}
	doneToday := func(t Task) bool {
		if closedToday(t) {
			return true
		}
		if t.State.Open() || t.ParentID == "" {
			return false
		}
		i := slices.IndexFunc(tasks, func(p Task) bool { return p.ID == t.ParentID })
		return i >= 0 && closedToday(tasks[i])
	}
	type section struct {
		title string
		in    func(Task) bool
	}
	sections := []section{
		{"In progress", func(t Task) bool { return t.State == StateDoing }},
		{"Up next", func(t Task) bool { return t.State == StateTodo }},
		{"Blocked", func(t Task) bool { return t.State == StateBlocked }},
		{"Done today", doneToday},
	}
	shown := 0
	for i, sec := range sections {
		if i == len(sections)-1 && len(timers) > 0 {
			b.WriteString(renderTimers(timers, now, loc))
		}
		var list []Task
		for _, t := range tasks {
			if sec.in(t) {
				list = append(list, t)
			}
		}
		if len(list) == 0 {
			continue
		}
		fmt.Fprintf(&b, "\n## %s\n\n", sec.title)
		inSection := func(id string) bool {
			return id != "" && slices.ContainsFunc(list, func(t Task) bool { return t.ID == id })
		}
		for _, t := range list {
			if inSection(t.ParentID) {
				continue // under its parent
			}
			b.WriteString("- " + taskLine(t, now) + "\n")
			shown++
			for _, c := range list {
				if c.ParentID == t.ID {
					b.WriteString("  - " + taskLine(c, now) + "\n")
					shown++
				}
			}
		}
	}
	if len(tasks) == 0 {
		b.WriteString("\nNo tasks yet.\n")
	}
	var done, cancelled int
	for _, t := range tasks {
		switch {
		case t.State.Open() || doneToday(t):
		case t.State == StateDone:
			done++
		case t.State == StateCancelled:
			cancelled++
		}
	}
	if done+cancelled > 0 {
		fmt.Fprintf(&b, "\nEarlier: %d done, %d cancelled (`code-foundry ember task list --all`).\n", done, cancelled)
	} else if shown == 0 && len(tasks) > 0 {
		b.WriteString("\nNothing open.\n")
	}
	return b.String()
}

// renderTimers is BOARD.md's Scheduled section: one line per timer, "- 15:00 CDT · once
// · <note> · sub-…" ("every 2m", the date when not today, no note part without one).
func renderTimers(timers []Timer, now time.Time, loc *time.Location) string {
	var b strings.Builder
	b.WriteString("\n## Scheduled\n\nYour timers; `code-foundry thread unsubscribe <id>` cancels one.\n\n")
	for _, t := range timers {
		parts := []string{clock(t.NextAt, now, loc), "once"}
		if t.Every > 0 {
			parts[1] = "every " + thread.FormatEvery(t.Every)
		}
		if t.Note != "" {
			parts = append(parts, t.Note)
		}
		b.WriteString("- " + strings.Join(append(parts, t.ID), " · ") + "\n")
	}
	return b.String()
}

// clock is t in loc for the board: "15:04 CDT" on now's day, else "Oct 21 15:04 CDT".
func clock(t, now time.Time, loc *time.Location) string {
	t, now = t.In(loc), now.In(loc)
	if t.Year() == now.Year() && t.YearDay() == now.YearDay() {
		return t.Format("15:04 MST")
	}
	return t.Format("Jan 2 15:04 MST")
}

// taskLine is one task on the board: id, title, its worker's progress, its branch and
// its outcome.
func taskLine(t Task, now time.Time) string {
	line := t.ID + " " + t.Title
	if t.Thread != nil {
		line += " · " + ThreadProgress(t.Thread, now)
	} else if t.ThreadID != "" {
		line += " · worker " + t.ThreadID
	}
	if t.Branch != "" {
		line += " · branch " + t.Branch
	}
	if t.Outcome != "" {
		line += " — " + oneLine(t.Outcome, 300)
	}
	return line
}

// ThreadProgress says how a task's worker is doing: "worker s-… busy, report progress:
// "…", 12m" (the age since the thread last changed).
func ThreadProgress(tt *TaskThread, now time.Time) string {
	if tt.Removed {
		return "worker " + tt.ID + " removed"
	}
	out := "worker " + tt.ID + " " + ThreadState(tt)
	if tt.Report.Status != thread.ReportNone {
		out += ", report " + tt.Report.Status.String()
		if tt.Report.Summary != "" {
			out += ": " + oneLine(tt.Report.Summary, 200)
		}
	}
	if !tt.LastActivityAt.IsZero() {
		out += ", " + Age(now.Sub(tt.LastActivityAt))
	}
	return out
}

// ThreadState is a worker thread's state in a word or two: "busy", "idle", "needs
// attention (permission: Bash)", "archived", "stopped".
func ThreadState(tt *TaskThread) string {
	switch {
	case tt.Removed:
		return "removed"
	case tt.Archived:
		return "archived"
	}
	s := tt.Status.String()
	if tt.Status == thread.StatusUnknown {
		s = "starting"
		if tt.State == thread.StateDisconnected {
			s = "stopped"
		}
	}
	if tt.StatusReason != "" {
		s += " (" + oneLine(tt.StatusReason, 80) + ")"
	}
	return s
}

// RenderProjects is PROJECTS.md: every project with its id, path, default branch, its
// origin's kind (originKind) and its latest threads.
func RenderProjects(ps []ProjectSeed) string {
	var b strings.Builder
	b.WriteString("# Projects\n\n")
	if len(ps) == 0 {
		b.WriteString("None yet. The user adds projects in the app (or `code-foundry project add <path>`).\n")
		return b.String()
	}
	b.WriteString("Every project the user has, with its latest threads. `--project` takes the id.\n\n")
	for _, p := range ps {
		kind := "not a git repository"
		if p.Git {
			kind = "git"
			if p.DefaultBranch != "" {
				kind += ", default branch " + p.DefaultBranch
			}
			kind += ", " + originKind(p.GitHubSlug)
		}
		fmt.Fprintf(&b, "- **%s** (`%s`) · %s · %s\n", p.Name, p.ID, p.Path, kind)
		if len(p.Threads) == 0 {
			continue
		}
		parts := make([]string, len(p.Threads))
		for i, t := range p.Threads {
			parts[i] = fmt.Sprintf("%s %q (%s)", t.ID, t.Name, t.State)
		}
		b.WriteString("  Latest threads: " + strings.Join(parts, "; ") + "\n")
	}
	return b.String()
}

// originKind says where a git project's origin is, so Ember knows whether pull requests
// are possible: "origin: GitHub (owner/name)", else "origin: local/other (no pull
// requests)" (a local path, another host, or no origin at all).
func originKind(slug string) string {
	if slug != "" {
		return "origin: GitHub (" + slug + ")"
	}
	return "origin: local/other (no pull requests)"
}

// RenderSkills is PROJECTS.md's closing section: where the code-foundry-orchestrate
// skill is (dir, absolute), so Ember reads its references by path; "" without dir.
func RenderSkills(dir string) string {
	if dir == "" {
		return ""
	}
	return "\n## Skills\n\nThe code-foundry-orchestrate skill (the thread protocol) is in `" + dir + "`: " +
		"SKILL.md, and `reference/leads.md` for leads (`" + filepath.Join(dir, "reference", "leads.md") + "`). " +
		"Read them by these paths; never search the disk for them.\n"
}

// Age is a duration in one unit: "now", "5m", "3h", "2d".
func Age(d time.Duration) string {
	switch {
	case d < time.Minute:
		return "now"
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d/time.Minute))
	case d < 48*time.Hour:
		return fmt.Sprintf("%dh", int(d/time.Hour))
	default:
		return fmt.Sprintf("%dd", int(d/(24*time.Hour)))
	}
}

// oneLine is s on one line (whitespace runs as one space), cut to n bytes.
func oneLine(s string, n int) string {
	return truncate(strings.Join(strings.Fields(s), " "), n, "…")
}

// truncate cuts s to at most n bytes (on a rune boundary), ending it with mark when it
// cut.
func truncate(s string, n int, mark string) string {
	if len(s) <= n {
		return s
	}
	cut := max(0, n-len(mark))
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut] + mark
}
