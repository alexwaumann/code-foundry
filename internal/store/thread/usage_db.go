package thread

import (
	"context"
	"database/sql"
	"fmt"
)

// Persistence for session_usage and usage_retired (migration 0012). The per-source
// tables of 0013 are in usage_runs_db.go.

const usageColumns = `model, tier, speed, day, requests, input, output, cache_read, cache_write_5m, cache_write_1h`

func usageArgs(b UsageBucket) []any {
	return []any{b.Model, b.Tier, b.Speed, b.Day, b.Requests, b.Input, b.Output, b.CacheRead, b.CacheWrite5m, b.CacheWrite1h}
}

func scanBucket(sc interface{ Scan(...any) error }, prefix ...any) (UsageBucket, error) {
	var b UsageBucket
	err := sc.Scan(append(prefix, &b.Model, &b.Tier, &b.Speed, &b.Day, &b.Requests, &b.Input, &b.Output,
		&b.CacheRead, &b.CacheWrite5m, &b.CacheWrite1h)...)
	return b, err
}

// saveUsage replaces a thread's usage rows with buckets in one transaction.
func saveUsage(ctx context.Context, db *sql.DB, threadID string, buckets []UsageBucket) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("thread: save usage of %s: %w", threadID, err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := replaceUsageTx(ctx, tx, threadID, buckets); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("thread: save usage of %s: %w", threadID, err)
	}
	return nil
}

// replaceUsageTx replaces a thread's session_usage rows inside tx.
func replaceUsageTx(ctx context.Context, tx *sql.Tx, threadID string, buckets []UsageBucket) error {
	if _, err := tx.ExecContext(ctx, `DELETE FROM session_usage WHERE session_id = ?`, threadID); err != nil {
		return fmt.Errorf("thread: save usage of %s: %w", threadID, err)
	}
	for _, b := range buckets {
		if _, err := tx.ExecContext(ctx, `INSERT INTO session_usage (session_id, `+usageColumns+`)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, append([]any{threadID}, usageArgs(b)...)...); err != nil {
			return fmt.Errorf("thread: save usage of %s: %w", threadID, err)
		}
	}
	return nil
}

// loadUsage returns every thread's usage, each sorted by (Day, Model, Tier, Speed).
func loadUsage(ctx context.Context, db *sql.DB) (map[string][]UsageBucket, error) {
	rows, err := db.QueryContext(ctx, `SELECT session_id, `+usageColumns+`
		FROM session_usage ORDER BY session_id, day, model, tier, speed`)
	if err != nil {
		return nil, fmt.Errorf("thread: load usage: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := map[string][]UsageBucket{}
	for rows.Next() {
		var id string
		b, err := scanBucket(rows, &id)
		if err != nil {
			return nil, fmt.Errorf("thread: load usage: %w", err)
		}
		out[id] = append(out[id], b)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("thread: load usage: %w", err)
	}
	return out, nil
}

// loadRetiredUsage returns the retired ledger sorted by (Day, Model, Tier, Speed).
func loadRetiredUsage(ctx context.Context, db *sql.DB) ([]UsageBucket, error) {
	rows, err := db.QueryContext(ctx, `SELECT `+usageColumns+` FROM usage_retired ORDER BY day, model, tier, speed`)
	if err != nil {
		return nil, fmt.Errorf("thread: load retired usage: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []UsageBucket
	for rows.Next() {
		b, err := scanBucket(rows)
		if err != nil {
			return nil, fmt.Errorf("thread: load retired usage: %w", err)
		}
		out = append(out, b)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("thread: load retired usage: %w", err)
	}
	return out, nil
}

// retireThread adds the thread's usage into usage_retired and deletes the thread
// (its session_usage rows cascade) in one transaction, so a crash either keeps the
// thread with its rows or retires them exactly once.
func retireThread(ctx context.Context, db *sql.DB, id string, buckets []UsageBucket) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("thread: delete %s: %w", id, err)
	}
	defer func() { _ = tx.Rollback() }()
	for _, b := range buckets {
		if _, err := tx.ExecContext(ctx, `INSERT INTO usage_retired (`+usageColumns+`)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (model, tier, speed, day) DO UPDATE SET
				requests = requests + excluded.requests,
				input = input + excluded.input,
				output = output + excluded.output,
				cache_read = cache_read + excluded.cache_read,
				cache_write_5m = cache_write_5m + excluded.cache_write_5m,
				cache_write_1h = cache_write_1h + excluded.cache_write_1h`, usageArgs(b)...); err != nil {
			return fmt.Errorf("thread: retire usage of %s: %w", id, err)
		}
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM sessions WHERE id = ?`, id); err != nil {
		return fmt.Errorf("thread: delete %s: %w", id, err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("thread: delete %s: %w", id, err)
	}
	return nil
}
