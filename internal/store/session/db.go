package session

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// Persistence for the sessions table (migrations 0003, 0006, 0008, 0009 and 0011) and
// session_pull_requests (0010). The terminal id is not persisted: no process survives
// a daemon restart. Status, its reason and StatusChangedAt are (0011): a disconnected
// session keeps the status it ended with.

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
			created_at, last_activity_at, parent_id, state, disconnect_reason, exit_code, last_error,
			permission_mode, base_ref, created_worktree, workspace_id, pinned,
			status, status_reason, status_changed_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
			last_error = excluded.last_error,
			permission_mode = excluded.permission_mode,
			base_ref = excluded.base_ref,
			created_worktree = excluded.created_worktree,
			workspace_id = excluded.workspace_id,
			pinned = excluded.pinned,
			status = excluded.status,
			status_reason = excluded.status_reason,
			status_changed_at = excluded.status_changed_at`,
		s.ID, s.ClaudeSessionID, s.RepoID, s.WorktreePath, s.Name, s.AutoNamed, s.Model, s.Effort,
		millis(s.CreatedAt), millis(s.LastActivityAt), s.ParentID, int(s.State), s.DisconnectReason, s.ExitCode, s.LastError,
		int(s.PermissionMode), s.BaseRef, s.CreatedWorktree, s.WorkspaceID, s.Pinned,
		int(s.Status), s.StatusReason, millis(s.StatusChangedAt))
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
			model, effort, created_at, last_activity_at, parent_id, state, disconnect_reason, exit_code, last_error,
			permission_mode, base_ref, created_worktree, workspace_id, pinned,
			status, status_reason, status_changed_at
		FROM sessions ORDER BY created_at, id`)
	if err != nil {
		return nil, fmt.Errorf("session: load: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []Session
	for rows.Next() {
		var s Session
		var created, active, statusAt int64
		var state, perm, status int
		if err := rows.Scan(&s.ID, &s.ClaudeSessionID, &s.RepoID, &s.WorktreePath, &s.Name, &s.AutoNamed,
			&s.Model, &s.Effort, &created, &active, &s.ParentID, &state, &s.DisconnectReason, &s.ExitCode, &s.LastError,
			&perm, &s.BaseRef, &s.CreatedWorktree, &s.WorkspaceID, &s.Pinned,
			&status, &s.StatusReason, &statusAt); err != nil {
			return nil, fmt.Errorf("session: load: %w", err)
		}
		s.CreatedAt, s.LastActivityAt, s.State = fromMillis(created), fromMillis(active), State(state)
		if s.PermissionMode = PermissionMode(perm); !s.PermissionMode.valid() {
			s.PermissionMode = PermissionDefault
		}
		if s.Status = Status(status); !s.Status.valid() {
			s.Status, s.StatusReason = StatusUnknown, ""
		}
		s.StatusChangedAt = fromMillis(statusAt)
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("session: load: %w", err)
	}
	links, err := loadLinks(ctx, db)
	if err != nil {
		return nil, err
	}
	for i := range out {
		out[i].LinkedPullRequests = links[out[i].ID]
	}
	return out, nil
}

// saveLinks records newly linked pull requests. A URL the session already has is
// ignored.
func saveLinks(ctx context.Context, db *sql.DB, sessionID string, links []LinkedPullRequest) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("session: save links of %s: %w", sessionID, err)
	}
	defer func() { _ = tx.Rollback() }()
	for _, l := range links {
		if _, err := tx.ExecContext(ctx, `INSERT INTO session_pull_requests (session_id, slug, number, url, linked_at)
			VALUES (?, ?, ?, ?, ?) ON CONFLICT (session_id, url) DO NOTHING`,
			sessionID, l.Slug, l.Number, l.URL, millis(l.LinkedAt)); err != nil {
			return fmt.Errorf("session: save links of %s: %w", sessionID, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("session: save links of %s: %w", sessionID, err)
	}
	return nil
}

// loadLinks returns every session's linked pull requests in first-seen (insertion)
// order.
func loadLinks(ctx context.Context, db *sql.DB) (map[string][]LinkedPullRequest, error) {
	rows, err := db.QueryContext(ctx, `SELECT session_id, slug, number, url, linked_at
		FROM session_pull_requests ORDER BY session_id, rowid`)
	if err != nil {
		return nil, fmt.Errorf("session: load links: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := map[string][]LinkedPullRequest{}
	for rows.Next() {
		var id string
		var l LinkedPullRequest
		var at int64
		if err := rows.Scan(&id, &l.Slug, &l.Number, &l.URL, &at); err != nil {
			return nil, fmt.Errorf("session: load links: %w", err)
		}
		l.LinkedAt = fromMillis(at)
		out[id] = append(out[id], l)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("session: load links: %w", err)
	}
	return out, nil
}
