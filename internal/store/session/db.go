package session

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// Persistence for the sessions table (migration 0003). Terminal id and status are not
// persisted: no process survives a daemon restart.

func millis(t time.Time) int64 {
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

func saveSession(ctx context.Context, db *sql.DB, s Session) error {
	_, err := db.ExecContext(ctx, `INSERT INTO sessions (
			id, claude_session_id, repo_id, worktree_path, name, auto_named, model, effort,
			created_at, last_activity_at, parent_id, state, disconnect_reason, exit_code, last_error)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (id) DO UPDATE SET
			claude_session_id = excluded.claude_session_id,
			repo_id = excluded.repo_id,
			worktree_path = excluded.worktree_path,
			name = excluded.name,
			auto_named = excluded.auto_named,
			model = excluded.model,
			effort = excluded.effort,
			last_activity_at = excluded.last_activity_at,
			parent_id = excluded.parent_id,
			state = excluded.state,
			disconnect_reason = excluded.disconnect_reason,
			exit_code = excluded.exit_code,
			last_error = excluded.last_error`,
		s.ID, s.ClaudeSessionID, s.RepoID, s.WorktreePath, s.Name, s.AutoNamed, s.Model, s.Effort,
		millis(s.CreatedAt), millis(s.LastActivityAt), s.ParentID, int(s.State), s.DisconnectReason, s.ExitCode, s.LastError)
	if err != nil {
		return fmt.Errorf("session: save %s: %w", s.ID, err)
	}
	return nil
}

func deleteSession(ctx context.Context, db *sql.DB, id string) error {
	if _, err := db.ExecContext(ctx, `DELETE FROM sessions WHERE id = ?`, id); err != nil {
		return fmt.Errorf("session: delete %s: %w", id, err)
	}
	return nil
}

func loadSessions(ctx context.Context, db *sql.DB) ([]Session, error) {
	rows, err := db.QueryContext(ctx, `SELECT id, claude_session_id, repo_id, worktree_path, name, auto_named,
			model, effort, created_at, last_activity_at, parent_id, state, disconnect_reason, exit_code, last_error
		FROM sessions ORDER BY created_at, id`)
	if err != nil {
		return nil, fmt.Errorf("session: load: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []Session
	for rows.Next() {
		var s Session
		var created, active int64
		var state int
		if err := rows.Scan(&s.ID, &s.ClaudeSessionID, &s.RepoID, &s.WorktreePath, &s.Name, &s.AutoNamed,
			&s.Model, &s.Effort, &created, &active, &s.ParentID, &state, &s.DisconnectReason, &s.ExitCode, &s.LastError); err != nil {
			return nil, fmt.Errorf("session: load: %w", err)
		}
		s.CreatedAt, s.LastActivityAt, s.State = fromMillis(created), fromMillis(active), State(state)
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("session: load: %w", err)
	}
	return out, nil
}
