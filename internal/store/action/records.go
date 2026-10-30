package action

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// RecordHistory is how many run records are kept per project (migration 0050).
const RecordHistory = 500

// RunRecord is the persisted record of a run, written when it starts: what the thread
// info card's action row and `action list`'s last-run column read, across daemon
// restarts. The run itself (state, output) lives in memory only.
type RunRecord struct {
	RunID     string
	ActionID  string
	ProjectID string
	ThreadID  string // empty for a worktree's run
	Mode      Mode   // ModeTerminal or ModeBackground: the runner
	Trigger   Trigger
	StartedAt time.Time
}

// PickSource says why Pick chose its action.
type PickSource int

const (
	// PickNone: the project has no actions.
	PickNone PickSource = iota
	// PickThread: the action the user ran last in the thread.
	PickThread
	// PickProject: nothing ran in the thread; the action the user ran last in the
	// project, in any thread or worktree.
	PickProject
	// PickFirst: no action of the project was run yet; its first action.
	PickFirst
)

func (p PickSource) String() string {
	switch p {
	case PickThread:
		return "thread"
	case PickProject:
		return "project"
	case PickFirst:
		return "first"
	default:
		return "none"
	}
}

// Pick is the action a thread's info card offers to run again.
type Pick struct {
	Source PickSource
	Action Action
	// Last is the run that chose the action (zero with PickFirst and PickNone).
	Last RunRecord
}

// PickAction chooses the action for a thread's card: the action last run in threadID,
// else the project's most recently run action, else the project's first action.
// actions is the project's actions in order; records its run records, newest first.
// Only runs the user started count (an on-worktree-create run is a setup step, not
// what the user reaches for again), and only for actions that still exist.
func PickAction(actions []Action, records []RunRecord, threadID string) Pick {
	if len(actions) == 0 {
		return Pick{}
	}
	byID := make(map[string]Action, len(actions))
	for _, a := range actions {
		byID[a.ID] = a
	}
	var project *RunRecord
	for i, r := range records {
		a, ok := byID[r.ActionID]
		if !ok || r.Trigger != TriggerUser {
			continue
		}
		if threadID != "" && r.ThreadID == threadID {
			return Pick{Source: PickThread, Action: a, Last: r}
		}
		if project == nil {
			project = &records[i]
		}
	}
	if project != nil {
		return Pick{Source: PickProject, Action: byID[project.ActionID], Last: *project}
	}
	return Pick{Source: PickFirst, Action: actions[0]}
}

// LatestByAction is each action's newest record (any trigger), from records newest
// first.
func LatestByAction(records []RunRecord) map[string]RunRecord {
	out := map[string]RunRecord{}
	for _, r := range records {
		if _, ok := out[r.ActionID]; !ok {
			out[r.ActionID] = r
		}
	}
	return out
}

func (t Trigger) String() string {
	switch t {
	case TriggerUser:
		return "user"
	case TriggerWorktreeCreate:
		return "worktree_create"
	default:
		return "unknown"
	}
}

func parseTrigger(s string) Trigger {
	switch s {
	case "user":
		return TriggerUser
	case "worktree_create":
		return TriggerWorktreeCreate
	}
	return 0
}

func parseMode(s string) Mode {
	switch s {
	case "terminal":
		return ModeTerminal
	case "background":
		return ModeBackground
	}
	return ModeDefault
}

// RunRecords implements Store.
func (m *Manager) RunRecords(ctx context.Context, projectID string) ([]RunRecord, error) {
	return loadRunRecords(ctx, m.opts.DB, projectID)
}

// record writes r's record and drops the project's records past RecordHistory. A
// failure is logged: the run goes on.
func (m *Manager) record(ctx context.Context, r Run) {
	rec := RunRecord{RunID: r.ID, ActionID: r.ActionID, ProjectID: r.ProjectID, ThreadID: r.ThreadID, Mode: r.Mode, Trigger: r.Trigger, StartedAt: r.StartedAt}
	if err := insertRunRecord(context.WithoutCancel(ctx), m.opts.DB, rec, RecordHistory); err != nil {
		m.log.Warn("record action run", "run", r.ID, "action", r.ActionID, "err", err)
	}
}

func insertRunRecord(ctx context.Context, db *sql.DB, r RunRecord, keep int) (err error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("action: record run %s: %w", r.RunID, err)
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()
	if _, err = tx.ExecContext(ctx, `INSERT INTO action_runs (id, action_id, project_id, thread_id, runner, trigger, started_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`, r.RunID, r.ActionID, r.ProjectID, r.ThreadID, r.Mode.String(), r.Trigger.String(), r.StartedAt.UnixMilli()); err != nil {
		return fmt.Errorf("action: record run %s: %w", r.RunID, err)
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM action_runs WHERE project_id = ? AND id NOT IN
		(SELECT id FROM action_runs WHERE project_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?)`, r.ProjectID, r.ProjectID, keep); err != nil {
		return fmt.Errorf("action: trim run records of %s: %w", r.ProjectID, err)
	}
	if err = tx.Commit(); err != nil {
		return fmt.Errorf("action: record run %s: %w", r.RunID, err)
	}
	return nil
}

// loadRunRecords is projectID's records (every project's when empty), newest first.
func loadRunRecords(ctx context.Context, db *sql.DB, projectID string) ([]RunRecord, error) {
	q := `SELECT id, action_id, project_id, thread_id, runner, trigger, started_at FROM action_runs`
	var args []any
	if projectID != "" {
		q += ` WHERE project_id = ?`
		args = append(args, projectID)
	}
	rows, err := db.QueryContext(ctx, q+` ORDER BY started_at DESC, rowid DESC`, args...)
	if err != nil {
		return nil, fmt.Errorf("action: load run records: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []RunRecord
	for rows.Next() {
		var r RunRecord
		var runner, trigger string
		var started int64
		if err := rows.Scan(&r.RunID, &r.ActionID, &r.ProjectID, &r.ThreadID, &runner, &trigger, &started); err != nil {
			return nil, fmt.Errorf("action: load run records: %w", err)
		}
		r.Mode, r.Trigger, r.StartedAt = parseMode(runner), parseTrigger(trigger), time.UnixMilli(started)
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("action: load run records: %w", err)
	}
	return out, nil
}
