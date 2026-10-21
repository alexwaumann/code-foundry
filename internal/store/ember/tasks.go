package ember

import (
	"cmp"
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// The task board: Ember's units of work (ember_tasks). Ember (or the CLI) adds and
// updates tasks; the store only blocks a doing task whose worker reports failed or
// blocked (blockFailedLocked), rolls an open parent's state up from its subtasks
// (rollupLocked) and, at load, puts back to todo a doing task whose worker never
// started (resetOrphansLocked). A worker's done report does not complete its task: Ember
// checks the work and marks it done.

// Bounds of a task's text.
const (
	maxTitle   = 200
	maxDetail  = 4000
	maxOutcome = 2000
	maxBranch  = 250
)

// NewTask is a task to add.
type NewTask struct {
	// ID is the task's id when the caller reserved one (NewTaskID); "" makes one.
	ID            string
	Title, Detail string
	// ParentID makes it part of a top-level task.
	ParentID string
	// ThreadID is its worker thread (it must exist).
	ThreadID string
	// State is StateTodo when unspecified.
	State State
}

// TaskUpdate changes a task: each non-nil field replaces the task's ("" clears the
// detail, thread, outcome or branch).
type TaskUpdate struct {
	Title, Detail, ThreadID, Outcome, Branch *string
	State                                    *State
}

// TaskIDs are every task's id, for the CLI's id suffixes.
func (s *Store) TaskIDs() []string {
	snap := s.Snapshot()
	out := make([]string, len(snap.Tasks))
	for i, t := range snap.Tasks {
		out[i] = t.ID
	}
	return out
}

// CheckTask reports whether AddTask would take n, but for its thread and id: the
// title, detail, state and parent. ember task start checks a task before it starts its
// worker, and adds it only once the worker exists.
func (s *Store) CheckTask(n NewTask) error {
	if _, err := cleanNewTask(n); err != nil {
		return err
	}
	if n.ParentID == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.parentLocked(n.ParentID)
	return err
}

// AddTask adds a task at the end of the board.
func (s *Store) AddTask(ctx context.Context, n NewTask) (Task, error) {
	n, err := cleanNewTask(n)
	if err != nil {
		return Task{}, err
	}
	if err := s.checkThread(n.ThreadID); err != nil {
		return Task{}, err
	}
	id := n.ID
	if id == "" {
		if id, err = NewTaskID(); err != nil {
			return Task{}, err
		}
	}
	now := s.opts.Now()
	t := Task{ID: id, Title: n.Title, Detail: n.Detail, State: n.State, ThreadID: n.ThreadID, CreatedAt: now, UpdatedAt: now}
	if t.State == StateDone {
		t.DoneAt = now
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.taskLocked(id); ok {
		return Task{}, fmt.Errorf("%w: task %s exists", ErrInvalidArgument, id)
	}
	if n.ParentID != "" {
		p, err := s.parentLocked(n.ParentID)
		if err != nil {
			return Task{}, err
		}
		t.ParentID = p.ID
	}
	for _, x := range s.tasks {
		t.Position = max(t.Position, x.Position+1)
	}
	if err := saveTask(ctx, s.opts.DB, t); err != nil {
		return Task{}, err
	}
	s.tasks = append(s.tasks, t)
	s.rollupLocked(ctx, t.ParentID, now)
	s.publishLocked(s.opts.Threads.Snapshot())
	s.log.Info("ember: task added", "task", t.ID, "title", t.Title, "state", t.State, "parent", t.ParentID, "thread", t.ThreadID)
	return s.publishedTask(t.ID), nil
}

// cleanNewTask is n with its title and detail cleaned and its state defaulted, or why
// it cannot be added.
func cleanNewTask(n NewTask) (NewTask, error) {
	var err error
	if n.Title, err = cleanTitle(n.Title); err != nil {
		return n, err
	}
	if n.Detail, err = cleanText("detail", n.Detail, maxDetail); err != nil {
		return n, err
	}
	if n.State == StateUnspecified {
		n.State = StateTodo
	}
	if _, ok := stateNames[n.State]; !ok {
		return n, fmt.Errorf("%w: task state %d", ErrInvalidArgument, n.State)
	}
	return n, nil
}

// parentLocked is task id as a new subtask's parent: it exists and is top-level (s.mu
// held).
func (s *Store) parentLocked(id string) (Task, error) {
	p, ok := s.taskLocked(id)
	switch {
	case !ok:
		return Task{}, fmt.Errorf("%w: no task %s", ErrNotFound, id)
	case p.ParentID != "":
		return Task{}, fmt.Errorf("%w: task %s is part of %s; a subtask's parent must be a top-level task", ErrInvalidArgument, p.ID, p.ParentID)
	}
	return p, nil
}

// UpdateTask applies u to task id.
func (s *Store) UpdateTask(ctx context.Context, id string, u TaskUpdate) (Task, error) {
	if u.ThreadID != nil {
		if err := s.checkThread(*u.ThreadID); err != nil {
			return Task{}, err
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	i := slices.IndexFunc(s.tasks, func(t Task) bool { return t.ID == id })
	if i < 0 {
		return Task{}, fmt.Errorf("%w: no task %s", ErrNotFound, id)
	}
	t := s.tasks[i]
	if u.Title != nil {
		title, err := cleanTitle(*u.Title)
		if err != nil {
			return Task{}, err
		}
		t.Title = title
	}
	if u.Detail != nil {
		detail, err := cleanText("detail", *u.Detail, maxDetail)
		if err != nil {
			return Task{}, err
		}
		t.Detail = detail
	}
	if u.Outcome != nil {
		outcome, err := cleanText("outcome", *u.Outcome, maxOutcome)
		if err != nil {
			return Task{}, err
		}
		t.Outcome = outcome
	}
	if u.Branch != nil {
		branch, err := cleanBranch(*u.Branch)
		if err != nil {
			return Task{}, err
		}
		t.Branch = branch
	}
	if u.ThreadID != nil {
		t.ThreadID = *u.ThreadID
	}
	now := s.opts.Now()
	if u.State != nil {
		if _, ok := stateNames[*u.State]; !ok {
			return Task{}, fmt.Errorf("%w: task state %d", ErrInvalidArgument, *u.State)
		}
		switch {
		case *u.State == StateDone && t.State != StateDone:
			t.DoneAt = now
		case *u.State != StateDone:
			t.DoneAt = time.Time{}
		}
		t.State = *u.State
	}
	t.UpdatedAt = now
	if err := saveTask(ctx, s.opts.DB, t); err != nil {
		return Task{}, err
	}
	s.tasks[i] = t
	s.rollupLocked(ctx, t.ParentID, now)
	s.publishLocked(s.opts.Threads.Snapshot())
	s.log.Info("ember: task updated", "task", t.ID, "state", t.State, "thread", t.ThreadID)
	return s.publishedTask(t.ID), nil
}

// blockFailedLocked blocks every doing task whose worker reported failed or blocked
// after the task last changed, with the report's summary as its outcome (s.mu held).
func (s *Store) blockFailedLocked(threads *thread.Snapshot, now time.Time) {
	for i, t := range s.tasks {
		if t.State != StateDoing || t.ThreadID == "" {
			continue
		}
		w, ok := threads.Thread(t.ThreadID)
		if !ok || (w.Report.Status != thread.ReportFailed && w.Report.Status != thread.ReportBlocked) || !w.Report.At.After(t.UpdatedAt) {
			continue
		}
		t.State, t.UpdatedAt = StateBlocked, now
		t.Outcome = cmp.Or(truncate(strings.TrimSpace(w.Report.Summary), maxOutcome, "…"), "the worker reported "+w.Report.Status.String())
		if err := saveTask(s.ctx, s.opts.DB, t); err != nil {
			s.log.Error("ember: block a task", "task", t.ID, "err", err)
			continue
		}
		s.tasks[i] = t
		s.log.Info("ember: task blocked by its worker's report", "task", t.ID, "thread", w.ID, "report", w.Report.Status)
		s.rollupLocked(s.ctx, t.ParentID, now)
	}
}

// Rolled is a parent task's state derived from its subtasks' states, for an open
// parent with subtasks; ok false leaves the parent as it is:
//
//   - every open subtask blocked: blocked;
//   - any subtask doing or blocked, or one done while others still wait: doing;
//   - no open subtask (all done or cancelled): unchanged, Ember closes the parent;
//   - else (none started yet): todo.
//
// A done or cancelled parent stays as Ember set it.
func Rolled(parent State, subs []State) (_ State, ok bool) {
	if !parent.Open() || len(subs) == 0 {
		return parent, false
	}
	var open, blocked, active, done int
	for _, c := range subs {
		switch c {
		case StateTodo:
			open++
		case StateDoing:
			open++
			active++
		case StateBlocked:
			open++
			active++
			blocked++
		case StateDone:
			done++
		}
	}
	switch {
	case open == 0:
		return parent, false
	case blocked == open:
		return StateBlocked, true
	case active > 0 || done > 0:
		return StateDoing, true
	}
	return StateTodo, true
}

// rollupLocked sets parent id's state from its subtasks (Rolled) and saves it when it
// changed (s.mu held). "" is no parent.
func (s *Store) rollupLocked(ctx context.Context, id string, now time.Time) {
	if id == "" {
		return
	}
	i := slices.IndexFunc(s.tasks, func(t Task) bool { return t.ID == id })
	if i < 0 {
		return
	}
	var subs []State
	for _, c := range s.tasks {
		if c.ParentID == id {
			subs = append(subs, c.State)
		}
	}
	p := s.tasks[i]
	st, ok := Rolled(p.State, subs)
	if !ok || st == p.State {
		return
	}
	from := p.State
	p.State, p.UpdatedAt = st, now
	if err := saveTask(ctx, s.opts.DB, p); err != nil {
		s.log.Error("ember: roll a parent task up", "task", p.ID, "err", err)
		return
	}
	s.tasks[i] = p
	s.log.Info("ember: parent task follows its subtasks", "task", p.ID, "from", from, "to", st)
}

// resetOrphansLocked runs at load: every doing task with no worker and no subtask goes
// back to todo (its ember task start was cut before the worker existed: the app
// stopped), then every parent is rolled up. Returns the tasks it reset (s.mu held).
func (s *Store) resetOrphansLocked(ctx context.Context, now time.Time) []Task {
	var out []Task
	for i, t := range s.tasks {
		if t.State != StateDoing || t.ThreadID != "" || slices.ContainsFunc(s.tasks, func(c Task) bool { return c.ParentID == t.ID }) {
			continue
		}
		t.State, t.UpdatedAt = StateTodo, now
		t.Outcome = "its worker never started (the app restarted at " + now.In(s.opts.Location).Format("15:04") + ")"
		if err := saveTask(ctx, s.opts.DB, t); err != nil {
			s.log.Error("ember: reset a task whose worker never started", "task", t.ID, "err", err)
			continue
		}
		s.tasks[i] = t
		out = append(out, t)
		s.log.Warn("ember: a doing task had no worker; back to todo", "task", t.ID, "title", t.Title)
	}
	for _, t := range s.tasks {
		if t.ParentID == "" {
			s.rollupLocked(ctx, t.ID, now)
		}
	}
	return out
}

// ResetAtStart are the tasks the store put back to todo when it loaded because their
// worker never started (resetOrphansLocked), as they were then. Ember's restart notice
// lists them.
func (s *Store) ResetAtStart() []Task {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.reset)
}

// checkThread refuses a worker thread id that names no thread ("" is none).
func (s *Store) checkThread(id string) error {
	if id == "" {
		return nil
	}
	if _, ok := s.opts.Threads.Snapshot().Thread(id); !ok {
		return fmt.Errorf("%w: no thread %s", ErrInvalidArgument, id)
	}
	return nil
}

// taskLocked is task id (s.mu held).
func (s *Store) taskLocked(id string) (Task, bool) {
	i := slices.IndexFunc(s.tasks, func(t Task) bool { return t.ID == id })
	if i < 0 {
		return Task{}, false
	}
	return s.tasks[i], true
}

// publishedTask is task id from the published snapshot (with its worker's progress).
func (s *Store) publishedTask(id string) Task {
	t, _ := s.snap.Load().Task(id)
	return t
}

// sortTasks puts tasks in board order: position, then creation, then id.
func sortTasks(tasks []Task) {
	slices.SortFunc(tasks, func(a, b Task) int {
		return cmp.Or(a.Position-b.Position, a.CreatedAt.Compare(b.CreatedAt), strings.Compare(a.ID, b.ID))
	})
}

// cleanTitle is a task title: one line, trimmed, 1 to maxTitle bytes.
func cleanTitle(s string) (string, error) {
	s = strings.TrimSpace(s)
	switch {
	case s == "":
		return "", fmt.Errorf("%w: a task needs a title", ErrInvalidArgument)
	case strings.ContainsAny(s, "\r\n"):
		return "", fmt.Errorf("%w: a task title is one line", ErrInvalidArgument)
	case len(s) > maxTitle:
		return "", fmt.Errorf("%w: the title has %d bytes (at most %d)", ErrInvalidArgument, len(s), maxTitle)
	}
	return s, nil
}

// cleanText is a task's detail or outcome: trimmed, valid UTF-8 without NUL, at most n
// bytes.
func cleanText(what, s string, n int) (string, error) {
	s = strings.TrimSpace(s)
	switch {
	case !utf8.ValidString(s) || strings.ContainsRune(s, 0):
		return "", fmt.Errorf("%w: the %s is not valid text", ErrInvalidArgument, what)
	case len(s) > n:
		return "", fmt.Errorf("%w: the %s has %d bytes (at most %d)", ErrInvalidArgument, what, len(s), n)
	}
	return s, nil
}

// cleanBranch is a task's branch: trimmed, without "origin/", one word of at most
// maxBranch bytes ("" clears it).
func cleanBranch(s string) (string, error) {
	s = strings.TrimPrefix(strings.TrimSpace(s), "origin/")
	switch {
	case strings.ContainsFunc(s, unicode.IsSpace) || !utf8.ValidString(s) || strings.ContainsRune(s, 0):
		return "", fmt.Errorf("%w: %q is not a branch name", ErrInvalidArgument, s)
	case len(s) > maxBranch:
		return "", fmt.Errorf("%w: the branch has %d bytes (at most %d)", ErrInvalidArgument, len(s), maxBranch)
	}
	return s, nil
}

// NewTaskID is "t-" and 8 random hex digits: a fresh task id, for a caller that needs
// it before it adds the task (NewTask.ID).
func NewTaskID() (string, error) {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("ember: task id: %w", err)
	}
	return "t-" + hex.EncodeToString(b[:]), nil
}
