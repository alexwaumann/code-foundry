package notification

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"
)

// Persistence for the notifications table (migration 0063).

const columns = `id, source, key, level, time_sensitive, title, body, thread_id, actions, show_at, state,
	created_at, updated_at, arrived_at, snoozed_until`

func loadAll(ctx context.Context, db *sql.DB) ([]Notification, error) {
	rows, err := db.QueryContext(ctx, `SELECT `+columns+` FROM notifications`)
	if err != nil {
		return nil, fmt.Errorf("notification: load: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []Notification
	for rows.Next() {
		var n Notification
		var level, state, actions string
		var ts int64
		var showAt, created, updated, arrived, snoozed int64
		if err := rows.Scan(&n.ID, &n.Source, &n.Key, &level, &ts, &n.Title, &n.Body, &n.ThreadID, &actions, &showAt, &state,
			&created, &updated, &arrived, &snoozed); err != nil {
			return nil, fmt.Errorf("notification: load: %w", err)
		}
		n.Level, n.State, n.TimeSensitive = Level(level), State(state), ts != 0
		if err := json.Unmarshal([]byte(actions), &n.Actions); err != nil {
			return nil, fmt.Errorf("notification: load %s actions: %w", n.ID, err)
		}
		if len(n.Actions) == 0 {
			n.Actions = nil
		}
		n.ShowAt, n.CreatedAt, n.UpdatedAt = fromMillis(showAt), fromMillis(created), fromMillis(updated)
		n.ArrivedAt, n.SnoozedUntil = fromMillis(arrived), fromMillis(snoozed)
		out = append(out, n)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("notification: load: %w", err)
	}
	return out, nil
}

// save writes every notification in ns in one transaction.
func save(ctx context.Context, db *sql.DB, ns []Notification) (err error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("notification: save: %w", err)
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()
	for _, n := range ns {
		actions, err := json.Marshal(n.Actions)
		if err != nil {
			return fmt.Errorf("notification: save %s: %w", n.ID, err)
		}
		if n.Actions == nil {
			actions = []byte("[]")
		}
		ts := 0
		if n.TimeSensitive {
			ts = 1
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO notifications (`+columns+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (id) DO UPDATE SET level = excluded.level, time_sensitive = excluded.time_sensitive,
				title = excluded.title, body = excluded.body, thread_id = excluded.thread_id, actions = excluded.actions,
				show_at = excluded.show_at, state = excluded.state, updated_at = excluded.updated_at,
				arrived_at = excluded.arrived_at, snoozed_until = excluded.snoozed_until`,
			n.ID, n.Source, n.Key, string(n.Level), ts, n.Title, n.Body, n.ThreadID, string(actions), millis(n.ShowAt), string(n.State),
			millis(n.CreatedAt), millis(n.UpdatedAt), millis(n.ArrivedAt), millis(n.SnoozedUntil)); err != nil {
			return fmt.Errorf("notification: save %s: %w", n.ID, err)
		}
	}
	if err = tx.Commit(); err != nil {
		return fmt.Errorf("notification: save: %w", err)
	}
	return nil
}

// remove deletes the rows with ids.
func remove(ctx context.Context, db *sql.DB, ids []string) (err error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("notification: prune: %w", err)
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()
	for _, id := range ids {
		if _, err = tx.ExecContext(ctx, `DELETE FROM notifications WHERE id = ?`, id); err != nil {
			return fmt.Errorf("notification: prune %s: %w", id, err)
		}
	}
	if err = tx.Commit(); err != nil {
		return fmt.Errorf("notification: prune: %w", err)
	}
	return nil
}

func millis(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.UnixMilli()
}

func fromMillis(ms int64) time.Time {
	if ms == 0 {
		return time.Time{}
	}
	return time.UnixMilli(ms)
}
