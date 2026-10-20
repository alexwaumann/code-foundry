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
	"unicode/utf8"

	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// The task board: Ember's units of work (ember_tasks). Ember (or the CLI) adds and
// updates tasks; the store only blocks a doing task whose worker reports failed or
// blocked (blockFailedLocked). A worker's done report does not complete its task: Ember
// checks the work and marks it done.

// Bounds of a task's text.
const (
	maxTitle   = 200
	maxDetail  = 4000
	maxOutcome = 2000
)

// NewTask is a task to add.
type NewTask struct {
	Title, Detail string
	// ParentID makes it part of a top-level task.
	ParentID string
	// ThreadID is its worker thread (it must exist).
	ThreadID string
	// State is StateTodo when unspecified.
	State State
}

// TaskUpdate changes a task: each non-nil field replaces the task's ("" clears the
// detail, thread or outcome).
type TaskUpdate struct {
	Title, Detail, ThreadID, Outcome *string
	State                            *State
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

// AddTask adds a task at the end of the board.
func (s *Store) AddTask(ctx context.Context, n NewTask) (Task, error) {
	title, err := cleanTitle(n.Title)
	if err != nil {
		return Task{}, err
	}
	detail, err := cleanText("detail", n.Detail, maxDetail)
	if err != nil {
		return Task{}, err
	}
	if n.State == StateUnspecified {
		n.State = StateTodo
	}
	if _, ok := stateNames[n.State]; !ok {
		return Task{}, fmt.Errorf("%w: task state %d", ErrInvalidArgument, n.State)
	}
	if err := s.checkThread(n.ThreadID); err != nil {
		return Task{}, err
	}
	id, err := newTaskID()
	if err != nil {
		return Task{}, err
	}
	now := s.opts.Now()
	t := Task{ID: id, Title: title, Detail: detail, State: n.State, ThreadID: n.ThreadID, CreatedAt: now, UpdatedAt: now}
	if t.State == StateDone {
		t.DoneAt = now
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if n.ParentID != "" {
		p, ok := s.taskLocked(n.ParentID)
		switch {
		case !ok:
			return Task{}, fmt.Errorf("%w: no task %s", ErrNotFound, n.ParentID)
		case p.ParentID != "":
			return Task{}, fmt.Errorf("%w: task %s is part of %s; a subtask's parent must be a top-level task", ErrInvalidArgument, p.ID, p.ParentID)
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
	s.publishLocked(s.opts.Threads.Snapshot())
	s.log.Info("ember: task added", "task", t.ID, "title", t.Title, "state", t.State, "parent", t.ParentID, "thread", t.ThreadID)
	return s.publishedTask(t.ID), nil
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
	}
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

// newTaskID is "t-" and 8 random hex digits.
func newTaskID() (string, error) {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("ember: task id: %w", err)
	}
	return "t-" + hex.EncodeToString(b[:]), nil
}
