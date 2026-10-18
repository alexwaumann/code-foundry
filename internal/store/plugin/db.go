package plugin

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// Persistence for the plugins and plugin_secrets tables (migration 0029).

// row is one plugins row.
type row struct {
	Name        string
	Enabled     bool
	Granted     *pluginsdk.Permissions // nil: never consented
	ConsentedAt time.Time
	DevPath     string
}

func loadRows(ctx context.Context, db *sql.DB) (map[string]row, error) {
	rows, err := db.QueryContext(ctx, `SELECT name, enabled, granted_json, consented_at, dev_path FROM plugins`)
	if err != nil {
		return nil, fmt.Errorf("plugin: load: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := map[string]row{}
	for rows.Next() {
		var r row
		var enabled int
		var granted string
		var consented int64
		if err := rows.Scan(&r.Name, &enabled, &granted, &consented, &r.DevPath); err != nil {
			return nil, fmt.Errorf("plugin: load: %w", err)
		}
		r.Enabled = enabled != 0
		if granted != "" {
			var p pluginsdk.Permissions
			if err := json.Unmarshal([]byte(granted), &p); err == nil {
				r.Granted = &p
			}
		}
		if consented > 0 {
			r.ConsentedAt = time.UnixMilli(consented)
		}
		out[r.Name] = r
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("plugin: load: %w", err)
	}
	return out, nil
}

func saveRow(ctx context.Context, db *sql.DB, r row, now time.Time) error {
	granted := ""
	if r.Granted != nil {
		b, err := json.Marshal(r.Granted.Normalize())
		if err != nil {
			return fmt.Errorf("plugin: save %s: %w", r.Name, err)
		}
		granted = string(b)
	}
	var consented int64
	if !r.ConsentedAt.IsZero() {
		consented = r.ConsentedAt.UnixMilli()
	}
	enabled := 0
	if r.Enabled {
		enabled = 1
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO plugins (name, enabled, granted_json, consented_at, dev_path, updated_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT (name) DO UPDATE SET enabled = excluded.enabled, granted_json = excluded.granted_json,
			consented_at = excluded.consented_at, dev_path = excluded.dev_path, updated_at = excluded.updated_at`,
		r.Name, enabled, granted, consented, r.DevPath, now.UnixMilli()); err != nil {
		return fmt.Errorf("plugin: save %s: %w", r.Name, err)
	}
	return nil
}

func listSecrets(ctx context.Context, db *sql.DB, plugin string) ([]SecretInfo, error) {
	rows, err := db.QueryContext(ctx, `SELECT key, updated_at FROM plugin_secrets WHERE plugin = ? ORDER BY key`, plugin)
	if err != nil {
		return nil, fmt.Errorf("plugin: list secrets: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := []SecretInfo{}
	for rows.Next() {
		var s SecretInfo
		var at int64
		if err := rows.Scan(&s.Key, &at); err != nil {
			return nil, fmt.Errorf("plugin: list secrets: %w", err)
		}
		s.UpdatedAt = time.UnixMilli(at)
		out = append(out, s)
	}
	return out, rows.Err()
}

func putSecret(ctx context.Context, db *sql.DB, plugin, key string, now time.Time) error {
	if _, err := db.ExecContext(ctx, `INSERT INTO plugin_secrets (plugin, key, updated_at) VALUES (?, ?, ?)
		ON CONFLICT (plugin, key) DO UPDATE SET updated_at = excluded.updated_at`, plugin, key, now.UnixMilli()); err != nil {
		return fmt.Errorf("plugin: record secret: %w", err)
	}
	return nil
}

func dropSecret(ctx context.Context, db *sql.DB, plugin, key string) (bool, error) {
	res, err := db.ExecContext(ctx, `DELETE FROM plugin_secrets WHERE plugin = ? AND key = ?`, plugin, key)
	if err != nil {
		return false, fmt.Errorf("plugin: forget secret: %w", err)
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}
