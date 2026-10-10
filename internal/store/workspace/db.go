package workspace

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// Persistence for the workspaces and workspace_members tables (migration 0007).

func loadWorkspaces(ctx context.Context, db *sql.DB) ([]Workspace, error) {
	rows, err := db.QueryContext(ctx, `SELECT id, name, branch, created_at FROM workspaces`)
	if err != nil {
		return nil, fmt.Errorf("workspace: load: %w", err)
	}
	defer func() { _ = rows.Close() }()
	byID := map[string]*Workspace{}
	var order []string
	for rows.Next() {
		var w Workspace
		var created int64
		if err := rows.Scan(&w.ID, &w.Name, &w.Branch, &created); err != nil {
			return nil, fmt.Errorf("workspace: load: %w", err)
		}
		w.CreatedAt = time.UnixMilli(created)
		byID[w.ID] = &w
		order = append(order, w.ID)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("workspace: load: %w", err)
	}
	mrows, err := db.QueryContext(ctx, `SELECT workspace_id, repo_id, worktree_path FROM workspace_members
		ORDER BY added_at, rowid`)
	if err != nil {
		return nil, fmt.Errorf("workspace: load members: %w", err)
	}
	defer func() { _ = mrows.Close() }()
	for mrows.Next() {
		var id string
		var m Member
		if err := mrows.Scan(&id, &m.RepoID, &m.WorktreePath); err != nil {
			return nil, fmt.Errorf("workspace: load members: %w", err)
		}
		if w := byID[id]; w != nil {
			w.Members = append(w.Members, m)
		}
	}
	if err := mrows.Err(); err != nil {
		return nil, fmt.Errorf("workspace: load members: %w", err)
	}
	out := make([]Workspace, 0, len(order))
	for _, id := range order {
		out = append(out, *byID[id])
	}
	return out, nil
}

// insertWorkspace stores a new workspace and its members in one transaction.
func insertWorkspace(ctx context.Context, db *sql.DB, w Workspace) (err error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("workspace: save %s: %w", w.ID, err)
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()
	if _, err = tx.ExecContext(ctx, `INSERT INTO workspaces (id, name, branch, created_at) VALUES (?, ?, ?, ?)`,
		w.ID, w.Name, w.Branch, w.CreatedAt.UnixMilli()); err != nil {
		return fmt.Errorf("workspace: save %s: %w", w.ID, err)
	}
	for _, m := range w.Members {
		if _, err = tx.ExecContext(ctx, `INSERT INTO workspace_members (workspace_id, repo_id, worktree_path, added_at)
			VALUES (?, ?, ?, ?)`, w.ID, m.RepoID, m.WorktreePath, w.CreatedAt.UnixMilli()); err != nil {
			return fmt.Errorf("workspace: save %s member %s: %w", w.ID, m.RepoID, err)
		}
	}
	if err = tx.Commit(); err != nil {
		return fmt.Errorf("workspace: save %s: %w", w.ID, err)
	}
	return nil
}

func insertMember(ctx context.Context, db *sql.DB, id string, m Member, at time.Time) error {
	if _, err := db.ExecContext(ctx, `INSERT INTO workspace_members (workspace_id, repo_id, worktree_path, added_at)
		VALUES (?, ?, ?, ?)`, id, m.RepoID, m.WorktreePath, at.UnixMilli()); err != nil {
		return fmt.Errorf("workspace: add member %s to %s: %w", m.RepoID, id, err)
	}
	return nil
}

func deleteMember(ctx context.Context, db *sql.DB, id, repoID string) error {
	if _, err := db.ExecContext(ctx, `DELETE FROM workspace_members WHERE workspace_id = ? AND repo_id = ?`, id, repoID); err != nil {
		return fmt.Errorf("workspace: remove member %s from %s: %w", repoID, id, err)
	}
	return nil
}

func deleteWorkspace(ctx context.Context, db *sql.DB, id string) error {
	if _, err := db.ExecContext(ctx, `DELETE FROM workspaces WHERE id = ?`, id); err != nil {
		return fmt.Errorf("workspace: delete %s: %w", id, err)
	}
	return nil
}
