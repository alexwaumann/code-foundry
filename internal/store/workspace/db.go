package workspace

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// Persistence for the workspaces and workspace_members tables (migrations 0007, 0026,
// 0048). Members are kept sorted in memory; the table order does not matter.

func loadWorkspaces(ctx context.Context, db *sql.DB) ([]Workspace, error) {
	rows, err := db.QueryContext(ctx, `SELECT id, name, root_path, default_primary, created_at FROM workspaces`)
	if err != nil {
		return nil, fmt.Errorf("workspace: load: %w", err)
	}
	defer func() { _ = rows.Close() }()
	byID := map[string]*Workspace{}
	var order []string
	for rows.Next() {
		var w Workspace
		var created int64
		if err := rows.Scan(&w.ID, &w.Name, &w.RootPath, &w.DefaultPrimary, &created); err != nil {
			return nil, fmt.Errorf("workspace: load: %w", err)
		}
		w.CreatedAt = time.UnixMilli(created)
		byID[w.ID] = &w
		order = append(order, w.ID)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("workspace: load: %w", err)
	}
	mrows, err := db.QueryContext(ctx, `SELECT workspace_id, project_id FROM workspace_members`)
	if err != nil {
		return nil, fmt.Errorf("workspace: load members: %w", err)
	}
	defer func() { _ = mrows.Close() }()
	for mrows.Next() {
		var id, pid string
		if err := mrows.Scan(&id, &pid); err != nil {
			return nil, fmt.Errorf("workspace: load members: %w", err)
		}
		if w := byID[id]; w != nil {
			w.Members = append(w.Members, pid)
		}
	}
	if err := mrows.Err(); err != nil {
		return nil, fmt.Errorf("workspace: load members: %w", err)
	}
	out := make([]Workspace, 0, len(order))
	for _, id := range order {
		w := *byID[id]
		w.Members = sortedMembers(w.Members)
		out = append(out, w)
	}
	return out, nil
}

// saveWorkspace writes w and replaces its members, in one transaction.
func saveWorkspace(ctx context.Context, db *sql.DB, w Workspace) (err error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("workspace: save %s: %w", w.ID, err)
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()
	if _, err = tx.ExecContext(ctx, `INSERT INTO workspaces (id, name, root_path, default_primary, created_at) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT (id) DO UPDATE SET name = excluded.name, root_path = excluded.root_path, default_primary = excluded.default_primary`,
		w.ID, w.Name, w.RootPath, w.DefaultPrimary, w.CreatedAt.UnixMilli()); err != nil {
		return fmt.Errorf("workspace: save %s: %w", w.ID, err)
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM workspace_members WHERE workspace_id = ?`, w.ID); err != nil {
		return fmt.Errorf("workspace: save %s members: %w", w.ID, err)
	}
	now := time.Now().UnixMilli()
	for _, pid := range w.Members {
		if _, err = tx.ExecContext(ctx, `INSERT INTO workspace_members (workspace_id, project_id, added_at) VALUES (?, ?, ?)`,
			w.ID, pid, now); err != nil {
			return fmt.Errorf("workspace: save %s member %s: %w", w.ID, pid, err)
		}
	}
	if err = tx.Commit(); err != nil {
		return fmt.Errorf("workspace: save %s: %w", w.ID, err)
	}
	return nil
}

func deleteWorkspace(ctx context.Context, db *sql.DB, id string) error {
	if _, err := db.ExecContext(ctx, `DELETE FROM workspace_members WHERE workspace_id = ?`, id); err != nil {
		return fmt.Errorf("workspace: delete %s members: %w", id, err)
	}
	if _, err := db.ExecContext(ctx, `DELETE FROM workspaces WHERE id = ?`, id); err != nil {
		return fmt.Errorf("workspace: delete %s: %w", id, err)
	}
	return nil
}
