package search

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"
)

// The history table is search_history (migrations 0055, 0056): one row per entry, hits and steps
// as JSON arrays.

const entryCols = `id, mode, query, created_at, finished_at, status, error, answer, hits, steps,
	claude_session_id, model, cost_usd, duration_ms, unseen, promoted_thread_id, find_hits`

// loadEntries reads every entry.
func loadEntries(ctx context.Context, db *sql.DB) ([]Entry, error) {
	rows, err := db.QueryContext(ctx, `SELECT `+entryCols+` FROM search_history`)
	if err != nil {
		return nil, fmt.Errorf("search: load history: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []Entry
	for rows.Next() {
		var e Entry
		var mode, status, hits, steps string
		var created, finished, dur int64
		var unseen int
		if err := rows.Scan(&e.ID, &mode, &e.Query, &created, &finished, &status, &e.Error, &e.Answer, &hits, &steps,
			&e.ClaudeSessionID, &e.Model, &e.CostUSD, &dur, &unseen, &e.PromotedThreadID, &e.FindHits); err != nil {
			return nil, fmt.Errorf("search: load history: %w", err)
		}
		e.Mode, e.Status, e.Unseen = Mode(mode), Status(status), unseen != 0
		e.CreatedAt, e.FinishedAt, e.Duration = fromMillis(created), fromMillis(finished), time.Duration(dur)*time.Millisecond
		// A bad array loses that part of the entry, not the history.
		_ = json.Unmarshal([]byte(hits), &e.Hits)
		_ = json.Unmarshal([]byte(steps), &e.Steps)
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("search: load history: %w", err)
	}
	return out, nil
}

// saveEntry writes e's row (insert or replace).
func saveEntry(ctx context.Context, db *sql.DB, e Entry) error {
	hits, err := json.Marshal(nonNil(e.Hits))
	if err != nil {
		return fmt.Errorf("search: save %s: %w", e.ID, err)
	}
	steps, err := json.Marshal(nonNil(e.Steps))
	if err != nil {
		return fmt.Errorf("search: save %s: %w", e.ID, err)
	}
	unseen := 0
	if e.Unseen {
		unseen = 1
	}
	if _, err := db.ExecContext(ctx, `INSERT OR REPLACE INTO search_history (`+entryCols+`)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		e.ID, string(e.Mode), e.Query, toMillis(e.CreatedAt), toMillis(e.FinishedAt), string(e.Status), e.Error, e.Answer,
		string(hits), string(steps), e.ClaudeSessionID, e.Model, e.CostUSD, e.Duration.Milliseconds(), unseen, e.PromotedThreadID, e.FindHits); err != nil {
		return fmt.Errorf("search: save %s: %w", e.ID, err)
	}
	return nil
}

func deleteEntry(ctx context.Context, db *sql.DB, id string) error {
	if _, err := db.ExecContext(ctx, `DELETE FROM search_history WHERE id = ?`, id); err != nil {
		return fmt.Errorf("search: forget %s: %w", id, err)
	}
	return nil
}

func nonNil[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}

func toMillis(t time.Time) int64 {
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
