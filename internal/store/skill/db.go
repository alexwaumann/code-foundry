package skill

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/skill/marketplace"
)

// Persistence for skill_installs (migration 0038).

// Record is where an installed skill came from.
type Record struct {
	Name     string
	Registry string
	// Path is the skill's repo-relative directory in Registry's checkout.
	Path string
	Tier marketplace.Tier
	// CommitSHA and CommitAt are the last commit touching Path when the skill was
	// copied. An update is offered when the registry's commit is newer.
	CommitSHA string
	CommitAt  time.Time
	// SetupScript is relative to the skill's directory; "" for none.
	SetupScript string
	// SetupSHA256 is the script's hash when setup last ran; SetupDoneAt when it exited 0
	// (zero: never).
	SetupSHA256 string
	SetupDoneAt time.Time
	InstalledAt time.Time
}

func loadRecords(ctx context.Context, db *sql.DB) (map[string]Record, error) {
	rows, err := db.QueryContext(ctx, `SELECT name, registry, path, tier, commit_sha, commit_at, setup_script,
		setup_sha256, setup_done_at, installed_at FROM skill_installs`)
	if err != nil {
		return nil, fmt.Errorf("skill: load installs: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := map[string]Record{}
	for rows.Next() {
		var r Record
		var tier string
		var commitAt, installedAt int64
		var setupDone sql.NullInt64
		if err := rows.Scan(&r.Name, &r.Registry, &r.Path, &tier, &r.CommitSHA, &commitAt, &r.SetupScript,
			&r.SetupSHA256, &setupDone, &installedAt); err != nil {
			return nil, fmt.Errorf("skill: load installs: %w", err)
		}
		r.Tier, r.CommitAt, r.InstalledAt = marketplace.Tier(tier), unixMilli(commitAt), unixMilli(installedAt)
		if setupDone.Valid {
			r.SetupDoneAt = unixMilli(setupDone.Int64)
		}
		out[r.Name] = r
	}
	return out, rows.Err()
}

// saveRecord inserts or replaces r.
func saveRecord(ctx context.Context, db *sql.DB, r Record) error {
	var setupDone sql.NullInt64
	if !r.SetupDoneAt.IsZero() {
		setupDone = sql.NullInt64{Int64: r.SetupDoneAt.UnixMilli(), Valid: true}
	}
	var commitAt int64
	if !r.CommitAt.IsZero() {
		commitAt = r.CommitAt.UnixMilli()
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO skill_installs (name, registry, path, tier, commit_sha, commit_at,
			setup_script, setup_sha256, setup_done_at, installed_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (name) DO UPDATE SET registry = excluded.registry, path = excluded.path, tier = excluded.tier,
			commit_sha = excluded.commit_sha, commit_at = excluded.commit_at, setup_script = excluded.setup_script,
			setup_sha256 = excluded.setup_sha256, setup_done_at = excluded.setup_done_at, installed_at = excluded.installed_at`,
		r.Name, r.Registry, r.Path, string(r.Tier), r.CommitSHA, commitAt, r.SetupScript, r.SetupSHA256, setupDone,
		r.InstalledAt.UnixMilli()); err != nil {
		return fmt.Errorf("skill: record install of %s: %w", r.Name, err)
	}
	return nil
}

// deleteRecord forgets name's record.
func deleteRecord(ctx context.Context, db *sql.DB, name string) error {
	if _, err := db.ExecContext(ctx, `DELETE FROM skill_installs WHERE name = ?`, name); err != nil {
		return fmt.Errorf("skill: forget install of %s: %w", name, err)
	}
	return nil
}

func unixMilli(ms int64) time.Time {
	if ms == 0 {
		return time.Time{}
	}
	return time.UnixMilli(ms)
}
