package command

import (
	"context"
	"fmt"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/ember"
)

// ember.task.*: Ember's task board. A task is a unit of work, optionally owned by a
// worker thread whose progress (status, report, age) is derived when it is read.

// registerEmberTasks registers ember.task.add, ember.task.update, ember.task.done,
// ember.task.cancel, ember.task.list and ember.task.show.
func registerEmberTasks(r *Registry, d EmberDeps) error {
	idArg := ArgSpec{Name: "id", Type: String, Required: true, Positional: true, ID: EmberTaskID, Description: "Task id (t-…; a unique suffix of 4+ characters)"}
	stateArg := ArgSpec{Name: "state", Type: Enum, Enum: ember.StateNames, Description: "todo, doing, blocked, done or cancelled"}
	threadArg := ArgSpec{Name: "thread", Type: String, ID: ThreadID, Description: "The worker thread that owns the task"}
	one := func(t ember.Task, verb string) Result {
		return Result{Message: verb + " " + emberTaskLine(t, d.Now()), JSON: emberTaskView(t, d.Now())}
	}
	update := func(ctx context.Context, id, verb string, u ember.TaskUpdate) (Result, error) {
		t, err := d.Ember.UpdateTask(ctx, id, u)
		if err != nil {
			return Result{}, emberErr("id", err)
		}
		return one(t, verb), nil
	}
	ptr := func(a Args, name string) *string {
		if !a.Has(name) {
			return nil
		}
		v := a.String(name)
		return &v
	}
	return r.RegisterAll(
		Command{
			Name:  "ember.task.add",
			Title: "Ember: Add Task",
			Description: "Add a task to Ember's board, at the end (state todo unless given). A subtask names its parent " +
				"(a top-level task: one level only). Prints the task's id.",
			Category:     emberCategory,
			NoKeybinding: true,
			Args: []ArgSpec{
				{Name: "title", Type: String, Required: true, Positional: true, Description: "One line, at most 200 characters"},
				{Name: "detail", Type: String, FileOrStdin: true, Description: "What it takes, at most 4000 characters (@file: from a file, -: stdin)"},
				{Name: "parent", Type: String, ID: EmberTaskID, Description: "The top-level task it is part of"},
				threadArg, stateArg,
			},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				n := ember.NewTask{Title: a.String("title"), Detail: a.String("detail"), ParentID: a.String("parent"), ThreadID: a.String("thread")}
				if a.Has("state") {
					s, err := ember.ParseState(a.String("state"))
					if err != nil {
						return Result{}, InvalidArg("state", "%s", err)
					}
					n.State = s
				}
				t, err := d.Ember.AddTask(ctx, n)
				if err != nil {
					return Result{}, emberErr("title", err)
				}
				return one(t, "added"), nil
			},
		},
		Command{
			Name:  "ember.task.update",
			Title: "Ember: Update Task",
			Description: "Change a task: its title, detail, state, worker thread or outcome. Done stamps its done time; " +
				"leaving done clears it.",
			Category:     emberCategory,
			NoKeybinding: true,
			Args: []ArgSpec{
				idArg,
				{Name: "title", Type: String, Description: "New title"},
				{Name: "detail", Type: String, FileOrStdin: true, Description: "New detail (@file: from a file, -: stdin)"},
				stateArg, threadArg,
				{Name: "outcome", Type: String, Description: "What came of it, or why it stopped (at most 2000 characters)"},
			},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				u := ember.TaskUpdate{Title: ptr(a, "title"), Detail: ptr(a, "detail"), ThreadID: ptr(a, "thread"), Outcome: ptr(a, "outcome")}
				if a.Has("state") {
					s, err := ember.ParseState(a.String("state"))
					if err != nil {
						return Result{}, InvalidArg("state", "%s", err)
					}
					u.State = &s
				}
				if u == (ember.TaskUpdate{}) {
					return Result{}, InvalidArg("id", "nothing to change: give title, detail, state, thread or outcome")
				}
				return update(ctx, a.String("id"), "updated", u)
			},
		},
		Command{
			Name:         "ember.task.done",
			Title:        "Ember: Task Done",
			Description:  "Mark a task done, with its outcome (what came of it: a PR, a branch, a finding).",
			Category:     emberCategory,
			NoKeybinding: true,
			Args:         []ArgSpec{idArg, {Name: "outcome", Type: String, Positional: true, Description: "What came of it"}},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				s := ember.StateDone
				return update(ctx, a.String("id"), "done:", ember.TaskUpdate{State: &s, Outcome: ptr(a, "outcome")})
			},
		},
		Command{
			Name:         "ember.task.cancel",
			Title:        "Ember: Cancel Task",
			Description:  "Cancel a task, saying why. Its worker thread, if any, is left as it is.",
			Category:     emberCategory,
			NoKeybinding: true,
			Args:         []ArgSpec{idArg, {Name: "why", Type: String, Positional: true, Description: "Why it is dropped"}},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				s := ember.StateCancelled
				return update(ctx, a.String("id"), "cancelled:", ember.TaskUpdate{State: &s, Outcome: ptr(a, "why")})
			},
		},
		Command{
			Name:         "ember.task.list",
			Title:        "Ember: List Tasks",
			Description:  "List Ember's open tasks (todo, doing, blocked), one line each with its worker's progress; --all adds done and cancelled ones.",
			Category:     emberCategory,
			NoKeybinding: true,
			Args:         []ArgSpec{{Name: "all", Type: Bool, Description: "Also done and cancelled tasks"}},
			Run: func(_ context.Context, _ Context, a Args) (Result, error) {
				var list []ember.Task
				for _, t := range d.Ember.Snapshot().Tasks {
					if a.Bool("all") || t.State.Open() {
						list = append(list, t)
					}
				}
				if len(list) == 0 {
					msg := "no open tasks (--all includes done and cancelled ones)"
					if a.Bool("all") {
						msg = "no tasks"
					}
					return Result{Message: msg, JSON: []EmberTaskView{}}, nil
				}
				return Result{Message: formatEmberTasks(list, d.Now()), JSON: emberTaskViews(list, d.Now())}, nil
			},
		},
		Command{
			Name:         "ember.task.show",
			Title:        "Ember: Show Task",
			Description:  "Show one task: its state, detail, outcome, parent and subtasks, and its worker thread's status and report.",
			Category:     emberCategory,
			NoKeybinding: true,
			Args:         []ArgSpec{idArg},
			Run: func(_ context.Context, _ Context, a Args) (Result, error) {
				snap := d.Ember.Snapshot()
				t, ok := snap.Task(a.String("id"))
				if !ok {
					return Result{}, emberErr("id", fmt.Errorf("%w: no task %s", ember.ErrNotFound, a.String("id")))
				}
				return Result{Message: formatEmberTask(t, snap.Tasks, d.Now()), JSON: emberTaskView(t, d.Now())}, nil
			},
		},
	)
}

// EmberTaskView is a task in the ember.task.* commands' JSON.
type EmberTaskView struct {
	ID        string     `json:"id"`
	Title     string     `json:"title"`
	Detail    string     `json:"detail,omitempty"`
	State     string     `json:"state"`
	ParentID  string     `json:"parentId,omitempty"`
	ThreadID  string     `json:"threadId,omitempty"`
	Outcome   string     `json:"outcome,omitempty"`
	Position  int        `json:"position"`
	CreatedAt time.Time  `json:"createdAt"`
	UpdatedAt time.Time  `json:"updatedAt"`
	DoneAt    *time.Time `json:"doneAt,omitempty"`
	// Thread is the worker's progress, derived now.
	Thread *EmberTaskThreadView `json:"thread,omitempty"`
}

// EmberTaskThreadView is a task's worker thread in the JSON.
type EmberTaskThreadView struct {
	ID            string     `json:"id"`
	Name          string     `json:"name,omitempty"`
	State         string     `json:"state"`
	ReportStatus  string     `json:"reportStatus,omitempty"`
	ReportSummary string     `json:"reportSummary,omitempty"`
	ReportAt      *time.Time `json:"reportAt,omitempty"`
	AgeSeconds    int64      `json:"ageSeconds"`
	Archived      bool       `json:"archived,omitempty"`
	Removed       bool       `json:"removed,omitempty"`
}

func emberTaskViews(ts []ember.Task, now time.Time) []EmberTaskView {
	out := make([]EmberTaskView, len(ts))
	for i, t := range ts {
		out[i] = emberTaskView(t, now)
	}
	return out
}

func emberTaskView(t ember.Task, now time.Time) EmberTaskView {
	v := EmberTaskView{
		ID: t.ID, Title: t.Title, Detail: t.Detail, State: t.State.String(), ParentID: t.ParentID, ThreadID: t.ThreadID,
		Outcome: t.Outcome, Position: t.Position, CreatedAt: t.CreatedAt, UpdatedAt: t.UpdatedAt,
	}
	if !t.DoneAt.IsZero() {
		at := t.DoneAt
		v.DoneAt = &at
	}
	if w := t.Thread; w != nil {
		tv := &EmberTaskThreadView{ID: w.ID, Name: w.Name, State: ember.ThreadState(w), Archived: w.Archived, Removed: w.Removed}
		if w.Report.Status.String() != "none" {
			at := w.Report.At
			tv.ReportStatus, tv.ReportSummary, tv.ReportAt = w.Report.Status.String(), w.Report.Summary, &at
		}
		if !w.LastActivityAt.IsZero() {
			tv.AgeSeconds = int64(now.Sub(w.LastActivityAt) / time.Second)
		}
		v.Thread = tv
	}
	return v
}

// emberTaskLine is one task in a sentence: "t-… [doing] Title · worker … — outcome".
func emberTaskLine(t ember.Task, now time.Time) string {
	line := fmt.Sprintf("%s [%s] %s", t.ID, t.State, t.Title)
	if t.Thread != nil {
		line += " · " + ember.ThreadProgress(t.Thread, now)
	}
	if t.Outcome != "" {
		line += " — " + t.Outcome
	}
	return line
}

// formatEmberTasks is one line per task: id, state, title (a subtask indented), and
// its worker's progress.
func formatEmberTasks(ts []ember.Task, now time.Time) string {
	var b strings.Builder
	w := tabwriter.NewWriter(&b, 0, 4, 2, ' ', 0)
	for _, t := range ts {
		title := t.Title
		if t.ParentID != "" {
			title = "  ↳ " + title
		}
		worker := "-"
		if t.Thread != nil {
			worker = ember.ThreadProgress(t.Thread, now)
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\n", t.ID, t.State, title, worker)
	}
	_ = w.Flush()
	return strings.TrimRight(b.String(), "\n")
}

// formatEmberTask is ember.task.show's text.
func formatEmberTask(t ember.Task, all []ember.Task, now time.Time) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s [%s] %s\n", t.ID, t.State, t.Title)
	if t.ParentID != "" {
		parent := t.ParentID
		for _, p := range all {
			if p.ID == t.ParentID {
				parent += " " + p.Title
			}
		}
		fmt.Fprintf(&b, "part of: %s\n", parent)
	}
	for _, c := range all {
		if c.ParentID == t.ID {
			fmt.Fprintf(&b, "subtask: %s [%s] %s\n", c.ID, c.State, c.Title)
		}
	}
	fmt.Fprintf(&b, "created %s, updated %s", t.CreatedAt.Local().Format("Jan 2 15:04"), t.UpdatedAt.Local().Format("Jan 2 15:04"))
	if !t.DoneAt.IsZero() {
		fmt.Fprintf(&b, ", done %s", t.DoneAt.Local().Format("Jan 2 15:04"))
	}
	b.WriteString("\n")
	if t.Thread != nil {
		fmt.Fprintf(&b, "worker: %s\n", ember.ThreadProgress(t.Thread, now))
		if t.Thread.Name != "" {
			fmt.Fprintf(&b, "worker name: %s\n", t.Thread.Name)
		}
	}
	if t.Outcome != "" {
		fmt.Fprintf(&b, "outcome: %s\n", t.Outcome)
	}
	if t.Detail != "" {
		fmt.Fprintf(&b, "\n%s\n", t.Detail)
	}
	return strings.TrimRight(b.String(), "\n")
}
