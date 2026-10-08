package gh

import (
	"context"
	"database/sql"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// DB is the subset of *sql.DB the store needs. The daemon passes its shared handle.
type DB interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

//go:embed schema.sql
var schemaSQL string

// cacheVersion is bumped when the cached JSON shape changes incompatibly. Rows with
// another version are treated as missing.
const cacheVersion = 1

// cacheRetention is how long on-demand detail rows (PR details, ref checks) are kept.
const cacheRetention = 7 * 24 * time.Hour

// Migrate creates the gh_* cache tables. It is idempotent and safe to run on every
// start.
func Migrate(ctx context.Context, db DB) error {
	for _, stmt := range schemaStatements(schemaSQL) {
		if _, err := db.ExecContext(ctx, stmt); err != nil {
			return fmt.Errorf("gh: migrate: %w", err)
		}
	}
	return nil
}

// schemaStatements splits schema.sql into statements, dropping comment lines. The
// schema has no semicolons inside statements.
func schemaStatements(schema string) []string {
	var b strings.Builder
	for line := range strings.Lines(schema) {
		if strings.HasPrefix(strings.TrimSpace(line), "--") {
			continue
		}
		b.WriteString(line)
	}
	var out []string
	for stmt := range strings.SplitSeq(b.String(), ";") {
		if s := strings.TrimSpace(stmt); s != "" {
			out = append(out, s)
		}
	}
	return out
}

type envelope[T any] struct {
	V    int `json:"v"`
	Data T   `json:"data"`
}

func encodePayload[T any](v T) (string, error) {
	b, err := json.Marshal(envelope[T]{V: cacheVersion, Data: v})
	if err != nil {
		return "", fmt.Errorf("gh: encode cache: %w", err)
	}
	return string(b), nil
}

// decodePayload returns ok=false for a payload of another version or shape.
func decodePayload[T any](payload string) (T, bool) {
	var env envelope[T]
	if err := json.Unmarshal([]byte(payload), &env); err != nil || env.V != cacheVersion {
		var zero T
		return zero, false
	}
	return env.Data, true
}

func toMillis(t time.Time) int64 { return t.UnixMilli() }

func fromMillis(ms int64) time.Time { return time.UnixMilli(ms) }

// cache is the SQLite persistence for the store.
type cache struct {
	db DB
}

// loadSnapshot reads the viewer and every repository's PR list.
func (c cache) loadSnapshot(ctx context.Context) (*Snapshot, error) {
	snap := &Snapshot{Viewer: ViewerState{Authenticated: true}, Repos: map[string]RepoState{}}

	var fetched int64
	var payload string
	err := c.db.QueryRowContext(ctx, `SELECT fetched_at, payload FROM gh_viewer WHERE id = 1`).Scan(&fetched, &payload)
	switch {
	case err == nil:
		if v, ok := decodePayload[Viewer](payload); ok {
			snap.Viewer.Viewer = &v
			snap.Viewer.FetchedAt = fromMillis(fetched)
		}
	case !errors.Is(err, sql.ErrNoRows):
		return nil, fmt.Errorf("gh: load viewer: %w", err)
	}

	rows, err := c.db.QueryContext(ctx, `SELECT slug, fetched_at, total_count, payload FROM gh_pull_requests`)
	if err != nil {
		return nil, fmt.Errorf("gh: load pull requests: %w", err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var slug string
		var total int
		if err := rows.Scan(&slug, &fetched, &total, &payload); err != nil {
			return nil, fmt.Errorf("gh: load pull requests: %w", err)
		}
		prs, ok := decodePayload[[]PullRequest](payload)
		if !ok {
			continue
		}
		snap.Repos[slug] = RepoState{Slug: slug, PullRequests: prs, TotalCount: total, FetchedAt: fromMillis(fetched)}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("gh: load pull requests: %w", err)
	}
	return snap, nil
}

func (c cache) saveViewer(ctx context.Context, v Viewer, at time.Time) error {
	payload, err := encodePayload(v)
	if err != nil {
		return err
	}
	_, err = c.db.ExecContext(ctx,
		`INSERT INTO gh_viewer (id, fetched_at, payload) VALUES (1, ?, ?)
		 ON CONFLICT (id) DO UPDATE SET fetched_at = excluded.fetched_at, payload = excluded.payload`,
		toMillis(at), payload)
	if err != nil {
		return fmt.Errorf("gh: save viewer: %w", err)
	}
	return nil
}

func (c cache) savePullRequests(ctx context.Context, slug string, prs []PullRequest, total int, at time.Time) error {
	payload, err := encodePayload(prs)
	if err != nil {
		return err
	}
	_, err = c.db.ExecContext(ctx,
		`INSERT INTO gh_pull_requests (slug, fetched_at, total_count, payload) VALUES (?, ?, ?, ?)
		 ON CONFLICT (slug) DO UPDATE SET fetched_at = excluded.fetched_at,
		   total_count = excluded.total_count, payload = excluded.payload`,
		slug, toMillis(at), total, payload)
	if err != nil {
		return fmt.Errorf("gh: save pull requests: %w", err)
	}
	return nil
}

func (c cache) loadDetail(ctx context.Context, slug string, number int) (PullRequestDetail, bool, error) {
	var payload string
	err := c.db.QueryRowContext(ctx,
		`SELECT payload FROM gh_pull_request_details WHERE slug = ? AND number = ?`, slug, number).Scan(&payload)
	if errors.Is(err, sql.ErrNoRows) {
		return PullRequestDetail{}, false, nil
	}
	if err != nil {
		return PullRequestDetail{}, false, fmt.Errorf("gh: load pull request: %w", err)
	}
	d, ok := decodePayload[PullRequestDetail](payload)
	return d, ok, nil
}

func (c cache) saveDetail(ctx context.Context, slug string, d PullRequestDetail) error {
	payload, err := encodePayload(d)
	if err != nil {
		return err
	}
	_, err = c.db.ExecContext(ctx,
		`INSERT INTO gh_pull_request_details (slug, number, fetched_at, payload) VALUES (?, ?, ?, ?)
		 ON CONFLICT (slug, number) DO UPDATE SET fetched_at = excluded.fetched_at, payload = excluded.payload`,
		slug, d.PullRequest.Number, toMillis(d.FetchedAt), payload)
	if err != nil {
		return fmt.Errorf("gh: save pull request: %w", err)
	}
	return nil
}

func (c cache) loadChecks(ctx context.Context, slug, ref string) (RefChecks, bool, error) {
	var payload string
	err := c.db.QueryRowContext(ctx,
		`SELECT payload FROM gh_ref_checks WHERE slug = ? AND ref = ?`, slug, ref).Scan(&payload)
	if errors.Is(err, sql.ErrNoRows) {
		return RefChecks{}, false, nil
	}
	if err != nil {
		return RefChecks{}, false, fmt.Errorf("gh: load checks: %w", err)
	}
	d, ok := decodePayload[RefChecks](payload)
	return d, ok, nil
}

func (c cache) saveChecks(ctx context.Context, slug, ref string, d RefChecks) error {
	payload, err := encodePayload(d)
	if err != nil {
		return err
	}
	_, err = c.db.ExecContext(ctx,
		`INSERT INTO gh_ref_checks (slug, ref, fetched_at, payload) VALUES (?, ?, ?, ?)
		 ON CONFLICT (slug, ref) DO UPDATE SET fetched_at = excluded.fetched_at, payload = excluded.payload`,
		slug, ref, toMillis(d.FetchedAt), payload)
	if err != nil {
		return fmt.Errorf("gh: save checks: %w", err)
	}
	return nil
}

// prune drops on-demand rows older than cacheRetention.
func (c cache) prune(ctx context.Context, now time.Time) error {
	cutoff := toMillis(now.Add(-cacheRetention))
	for _, table := range []string{"gh_pull_request_details", "gh_ref_checks"} {
		if _, err := c.db.ExecContext(ctx, `DELETE FROM `+table+` WHERE fetched_at < ?`, cutoff); err != nil {
			return fmt.Errorf("gh: prune %s: %w", table, err)
		}
	}
	return nil
}
