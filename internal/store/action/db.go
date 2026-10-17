package action

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// Persistence for the actions table (migration 0020).

const actionColumns = `id, repo_id, name, command, icon, in_terminal, on_worktree_create, position, created_at, updated_at`

type scanner interface{ Scan(dest ...any) error }

func scanAction(row scanner) (Action, error) {
	var a Action
	var inTerm, onCreate int
	var created, updated int64
	if err := row.Scan(&a.ID, &a.ProjectID, &a.Name, &a.Command, &a.Icon, &inTerm, &onCreate, &a.Position, &created, &updated); err != nil {
		return Action{}, err
	}
	a.InTerminal, a.OnWorktreeCreate = inTerm != 0, onCreate != 0
	a.CreatedAt, a.UpdatedAt = time.UnixMilli(created), time.UnixMilli(updated)
	return a, nil
}

func loadActions(ctx context.Context, db *sql.DB) ([]Action, error) {
	rows, err := db.QueryContext(ctx, `SELECT `+actionColumns+` FROM actions ORDER BY repo_id, position, rowid`)
	if err != nil {
		return nil, fmt.Errorf("action: load: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []Action
	for rows.Next() {
		a, err := scanAction(rows)
		if err != nil {
			return nil, fmt.Errorf("action: load: %w", err)
		}
		out = append(out, a)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("action: load: %w", err)
	}
	return out, nil
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

func insertAction(ctx context.Context, db *sql.DB, a Action) error {
	if _, err := db.ExecContext(ctx, `INSERT INTO actions (`+actionColumns+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		a.ID, a.ProjectID, a.Name, a.Command, a.Icon, b2i(a.InTerminal), b2i(a.OnWorktreeCreate), a.Position,
		a.CreatedAt.UnixMilli(), a.UpdatedAt.UnixMilli()); err != nil {
		return fmt.Errorf("action: save %s: %w", a.Name, err)
	}
	return nil
}

// saveActions writes every action in as (one project's, after an edit or a move) in one
// transaction.
func saveActions(ctx context.Context, db *sql.DB, as []Action) (err error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("action: save: %w", err)
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()
	for _, a := range as {
		if _, err = tx.ExecContext(ctx, `UPDATE actions SET name = ?, command = ?, icon = ?, in_terminal = ?,
			on_worktree_create = ?, position = ?, updated_at = ? WHERE id = ?`,
			a.Name, a.Command, a.Icon, b2i(a.InTerminal), b2i(a.OnWorktreeCreate), a.Position, a.UpdatedAt.UnixMilli(), a.ID); err != nil {
			return fmt.Errorf("action: save %s: %w", a.Name, err)
		}
	}
	if err = tx.Commit(); err != nil {
		return fmt.Errorf("action: save: %w", err)
	}
	return nil
}

func deleteAction(ctx context.Context, db *sql.DB, id string) error {
	if _, err := db.ExecContext(ctx, `DELETE FROM actions WHERE id = ?`, id); err != nil {
		return fmt.Errorf("action: delete %s: %w", id, err)
	}
	return nil
}

// deleteProjectActions removes a project's actions. Unregistering the project cascades
// already (actions.repo_id references repos); this makes ProjectRemoved exact either way.
func deleteProjectActions(ctx context.Context, db *sql.DB, projectID string) error {
	if _, err := db.ExecContext(ctx, `DELETE FROM actions WHERE repo_id = ?`, projectID); err != nil {
		return fmt.Errorf("action: delete project %s's actions: %w", projectID, err)
	}
	return nil
}
