package thread

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// Persistence for thread_subscriptions (migrations 0024, 0034 args, 0037 suppressed_at and
// 0044 note; subscriptions.go). Times are
// unix milliseconds, 0 for none. Rows of a removed subscriber go with its threads row
// (ON DELETE CASCADE); the store deletes the rest itself.

func loadSubscriptions(ctx context.Context, db *sql.DB) ([]Subscription, error) {
	rows, err := db.QueryContext(ctx, `SELECT id, subscriber_thread_id, target_kind, target_id, condition, repeat,
			created_at, fired_count, last_fired_at, args, suppressed_at, note
		FROM thread_subscriptions ORDER BY created_at, id`)
	if err != nil {
		return nil, fmt.Errorf("thread: load subscriptions: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []Subscription
	for rows.Next() {
		var s Subscription
		var kind, cond, args string
		var repeat int
		var created, fired, suppressed int64
		if err := rows.Scan(&s.ID, &s.SubscriberID, &kind, &s.TargetID, &cond, &repeat, &created, &s.FiredCount, &fired, &args,
			&suppressed, &s.Note); err != nil {
			return nil, fmt.Errorf("thread: load subscriptions: %w", err)
		}
		s.TargetKind, s.Condition, s.Repeat = TargetKind(kind), Condition(cond), repeat != 0
		s.CreatedAt, s.LastFiredAt, s.SuppressedAt = fromMillis(created), fromMillis(fired), fromMillis(suppressed)
		s.Args = decodeArgs(args)
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("thread: load subscriptions: %w", err)
	}
	return out, nil
}

// saveSubscription inserts s or rewrites its repeat flag, counts, suppressed fire and note.
func saveSubscription(ctx context.Context, db *sql.DB, s Subscription) error {
	repeat := 0
	if s.Repeat {
		repeat = 1
	}
	_, err := db.ExecContext(ctx, `INSERT INTO thread_subscriptions
			(id, subscriber_thread_id, target_kind, target_id, condition, repeat, created_at, fired_count, last_fired_at, args,
			suppressed_at, note)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (id) DO UPDATE SET
			repeat = excluded.repeat,
			fired_count = excluded.fired_count,
			last_fired_at = excluded.last_fired_at,
			suppressed_at = excluded.suppressed_at,
			note = excluded.note`,
		s.ID, s.SubscriberID, string(s.TargetKind), s.TargetID, string(s.Condition), repeat,
		millis(s.CreatedAt), s.FiredCount, millis(s.LastFiredAt), encodeArgs(s.Args), millis(s.SuppressedAt), s.Note)
	if err != nil {
		return fmt.Errorf("thread: save subscription %s: %w", s.ID, err)
	}
	return nil
}

func deleteSubscriptions(ctx context.Context, db *sql.DB, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	q := `DELETE FROM thread_subscriptions WHERE id IN (?` + strings.Repeat(", ?", len(ids)-1) + `)`
	if _, err := db.ExecContext(ctx, q, args...); err != nil {
		return fmt.Errorf("thread: delete subscriptions: %w", err)
	}
	return nil
}
