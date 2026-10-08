package gh

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/awaumann/code-foundry/internal/bus"
)

// gh_activity keys (schema.sql).
const (
	activityDashboard     = "dashboard"
	activityStats         = "stats"
	activityRepoStats     = "repo_stats:"
	activityDefaultBranch = "default_branch:"
	activityBranch        = "branch:"
)

func activityBranchKey(k branchKey) string { return activityBranch + k.slug + ":" + k.head }

func (c cache) saveActivity(ctx context.Context, key string, at time.Time, v any) error {
	payload, err := encodePayload(v)
	if err != nil {
		return err
	}
	_, err = c.db.ExecContext(ctx,
		`INSERT INTO gh_activity (key, fetched_at, payload) VALUES (?, ?, ?)
		 ON CONFLICT (key) DO UPDATE SET fetched_at = excluded.fetched_at, payload = excluded.payload`,
		key, toMillis(at), payload)
	if err != nil {
		return fmt.Errorf("gh: save %s: %w", key, err)
	}
	return nil
}

// loadActivityRow reads one row. ok is false when it is missing or of another version.
func loadActivityRow[T any](ctx context.Context, c cache, key string) (T, bool, error) {
	var zero T
	var payload string
	err := c.db.QueryRowContext(ctx, `SELECT payload FROM gh_activity WHERE key = ?`, key).Scan(&payload)
	if errors.Is(err, sql.ErrNoRows) {
		return zero, false, nil
	}
	if err != nil {
		return zero, false, fmt.Errorf("gh: load %s: %w", key, err)
	}
	v, ok := decodePayload[T](payload)
	return v, ok, nil
}

// loadActivity initializes the activity state and fills snap with the cached
// dashboard, stats, and per-repository activity. Branch rows are loaded on demand;
// those older than cacheRetention are pruned. Failures are logged: the cache is an
// optimization.
func (s *Store) loadActivity(ctx context.Context, snap *Snapshot) {
	s.act.repoStats = map[string]*schedule{}
	s.act.branches = map[branchKey]*branchWatch{}
	s.act.searchFirst = map[string]int{}
	s.act.branchStates = map[branchKey]BranchPullRequests{}
	if err := s.loadActivityRows(ctx, snap); err != nil {
		s.log.Warn("gh activity cache load failed", "err", err)
	}
	if f := snap.Dashboard.FetchedAt; !f.IsZero() {
		s.act.dashboardNext = f.Add(s.opts.DashboardInterval)
	}
	if f := snap.Dashboard.Stats.FetchedAt; !f.IsZero() {
		s.act.statsNext = f.Add(s.opts.StatsInterval)
	}
}

func (s *Store) loadActivityRows(ctx context.Context, snap *Snapshot) error {
	cutoff := toMillis(s.opts.Now().Add(-cacheRetention))
	if _, err := s.cache.db.ExecContext(ctx,
		`DELETE FROM gh_activity WHERE key LIKE 'branch:%' AND fetched_at < ?`, cutoff); err != nil {
		return fmt.Errorf("gh: prune activity: %w", err)
	}
	rows, err := s.cache.db.QueryContext(ctx, `SELECT key, payload FROM gh_activity WHERE key NOT LIKE 'branch:%'`)
	if err != nil {
		return fmt.Errorf("gh: load activity: %w", err)
	}
	defer func() { _ = rows.Close() }()
	repo := func(slug string, fn func(*RepoState)) {
		r := snap.Repos[slug]
		r.Slug = slug
		fn(&r)
		snap.Repos[slug] = r
	}
	for rows.Next() {
		var key, payload string
		if err := rows.Scan(&key, &payload); err != nil {
			return fmt.Errorf("gh: load activity: %w", err)
		}
		switch {
		case key == activityDashboard:
			if d, ok := decodePayload[Dashboard](payload); ok {
				stats := snap.Dashboard.Stats
				snap.Dashboard = d
				snap.Dashboard.Stats = stats
			}
		case key == activityStats:
			if st, ok := decodePayload[MonthlyStats](payload); ok {
				snap.Dashboard.Stats = st
			}
		case strings.HasPrefix(key, activityRepoStats):
			if st, ok := decodePayload[MonthlyStats](payload); ok {
				repo(strings.TrimPrefix(key, activityRepoStats), func(r *RepoState) { r.Activity.Stats = st })
			}
		case strings.HasPrefix(key, activityDefaultBranch):
			if ci, ok := decodePayload[BranchCI](payload); ok {
				repo(strings.TrimPrefix(key, activityDefaultBranch), func(r *RepoState) { r.Activity.DefaultBranch = ci })
			}
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("gh: load activity: %w", err)
	}
	return nil
}

// publish sends ev on the bus (topic T), if the store has one.
func publish[T any](s *Store, ev T) {
	if s.opts.Bus != nil {
		bus.Publish(s.opts.Bus, ev)
	}
}
