package ember

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// loadTasks reads every task, in no particular order.
func loadTasks(ctx context.Context, db *sql.DB) ([]Task, error) {
	rows, err := db.QueryContext(ctx, `SELECT id, title, detail, state, parent_id, thread_id, outcome, branch, position,
		created_at, updated_at, done_at FROM ember_tasks`)
	if err != nil {
		return nil, fmt.Errorf("ember: load tasks: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []Task
	for rows.Next() {
		var t Task
		var state string
		var created, updated int64
		var done sql.NullInt64
		if err := rows.Scan(&t.ID, &t.Title, &t.Detail, &state, &t.ParentID, &t.ThreadID, &t.Outcome, &t.Branch, &t.Position,
			&created, &updated, &done); err != nil {
			return nil, fmt.Errorf("ember: load tasks: %w", err)
		}
		if t.State, err = ParseState(state); err != nil {
			t.State = StateTodo // a row this build does not know; keep it visible
		}
		t.CreatedAt, t.UpdatedAt = fromMillis(created), fromMillis(updated)
		if done.Valid {
			t.DoneAt = fromMillis(done.Int64)
		}
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ember: load tasks: %w", err)
	}
	return out, nil
}

// saveTask inserts or replaces t's row.
func saveTask(ctx context.Context, db *sql.DB, t Task) error {
	var done any
	if !t.DoneAt.IsZero() {
		done = millis(t.DoneAt)
	}
	_, err := db.ExecContext(ctx, `INSERT INTO ember_tasks (id, title, detail, state, parent_id, thread_id, outcome, branch, position,
		created_at, updated_at, done_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (id) DO UPDATE SET title = excluded.title, detail = excluded.detail, state = excluded.state,
		parent_id = excluded.parent_id, thread_id = excluded.thread_id, outcome = excluded.outcome,
		branch = excluded.branch, position = excluded.position, updated_at = excluded.updated_at, done_at = excluded.done_at`,
		t.ID, t.Title, t.Detail, t.State.String(), t.ParentID, t.ThreadID, t.Outcome, t.Branch, t.Position,
		millis(t.CreatedAt), millis(t.UpdatedAt), done)
	if err != nil {
		return fmt.Errorf("ember: save task %s: %w", t.ID, err)
	}
	return nil
}

func millis(t time.Time) int64 { return t.UnixMilli() }

func fromMillis(ms int64) time.Time {
	if ms == 0 {
		return time.Time{}
	}
	return time.UnixMilli(ms)
}
