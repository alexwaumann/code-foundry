package thread

import (
	"cmp"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"
)

// Persistence for the threads table (migrations 0003, 0006, 0008, 0009, 0011, 0014,
// 0015, 0016, 0017, 0018, 0023, 0027, 0028, 0032, 0036, 0040 and 0041) and thread_pull_requests (0010, 0039); thread_usage and usage_retired
// (0012) are in usage_db.go, which also deletes threads (retireThread). No process
// survives a daemon restart. Status, its reason and StatusChangedAt are (0011): a disconnected
// thread keeps the status it ended with.

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

// nullBool is a nullable INTEGER column's value: NULL for nil.
func nullBool(b *bool) any {
	if b == nil {
		return nil
	}
	return *b
}

func saveThread(ctx context.Context, db *sql.DB, s Thread) error {
	_, err := db.ExecContext(ctx, `INSERT INTO threads (
			id, claude_session_id, project_id, worktree_path, name, auto_named, model, effort,
			created_at, last_activity_at, parent_id, state, disconnect_reason, exit_code, last_error,
			permission_mode, base_ref, created_worktree, workspace_id, pinned,
			status, status_reason, status_changed_at,
			context_tokens, context_model, last_result_at, archived_at, snoozed_until,
			created_by, created_by_name, brief, labels,
			report_status, report_summary, report_data, report_at, budget_usd, budget_hit_usd, branch, name_provisional, owner, spawn_env, spawn_add_dirs, resume_note,
			in_sidebar, kind, resident_name, epoch, system_prompt_append, fresh_start, seed_prefix)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
			?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (id) DO UPDATE SET
			claude_session_id = excluded.claude_session_id,
			project_id = excluded.project_id,
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
			status_changed_at = excluded.status_changed_at,
			context_tokens = excluded.context_tokens,
			context_model = excluded.context_model,
			last_result_at = excluded.last_result_at,
			archived_at = excluded.archived_at,
			snoozed_until = excluded.snoozed_until,
			created_by = excluded.created_by,
			created_by_name = excluded.created_by_name,
			brief = excluded.brief,
			labels = excluded.labels,
			report_status = excluded.report_status,
			report_summary = excluded.report_summary,
			report_data = excluded.report_data,
			report_at = excluded.report_at,
			budget_usd = excluded.budget_usd,
			budget_hit_usd = excluded.budget_hit_usd,
			branch = excluded.branch,
			name_provisional = excluded.name_provisional,
			owner = excluded.owner,
			spawn_env = excluded.spawn_env,
			spawn_add_dirs = excluded.spawn_add_dirs,
			resume_note = excluded.resume_note,
			in_sidebar = excluded.in_sidebar,
			epoch = excluded.epoch,
			system_prompt_append = excluded.system_prompt_append,
			fresh_start = excluded.fresh_start,
			seed_prefix = excluded.seed_prefix`,
		s.ID, s.ClaudeSessionID, s.ProjectID, s.WorktreePath, s.Name, s.AutoNamed, s.Model, s.Effort,
		millis(s.CreatedAt), millis(s.LastActivityAt), s.ParentID, int(s.State), s.DisconnectReason, s.ExitCode, s.LastError,
		int(s.PermissionMode), s.BaseRef, s.CreatedWorktree, s.WorkspaceID, s.Pinned,
		int(s.Status), s.StatusReason, millis(s.StatusChangedAt),
		s.ContextTokens, s.ContextModel, millis(s.LastResultAt), millis(s.ArchivedAt), millis(s.SnoozedUntil),
		s.CreatedBy, s.CreatedByName, s.Brief, labelsJSON(s.Labels),
		int(s.Report.Status), s.Report.Summary, s.Report.Data, millis(s.Report.At), s.BudgetUSD, s.BudgetHitUSD, s.Branch, s.NameProvisional, s.Owner, labelsJSON(s.SpawnEnv), labelsJSON(s.SpawnAddDirs), resumeNoteJSON(s.ResumeNote),
		nullBool(s.SidebarOverride), int(s.Kind), s.ResidentName, max(s.Epoch, 1), s.SystemPromptAppend, s.FreshStart, s.SeedPrefix)
	if err != nil {
		return fmt.Errorf("thread: save %s: %w", s.ID, err)
	}
	return nil
}

func loadThreads(ctx context.Context, db *sql.DB) ([]Thread, error) {
	rows, err := db.QueryContext(ctx, `SELECT id, claude_session_id, project_id, worktree_path, name, auto_named,
			model, effort, created_at, last_activity_at, parent_id, state, disconnect_reason, exit_code, last_error,
			permission_mode, base_ref, created_worktree, workspace_id, pinned,
			status, status_reason, status_changed_at,
			context_tokens, context_model, last_result_at, archived_at, snoozed_until,
			created_by, created_by_name, brief, labels,
			report_status, report_summary, report_data, report_at, budget_usd, budget_hit_usd, branch, name_provisional, owner, spawn_env, spawn_add_dirs, resume_note,
			in_sidebar, kind, resident_name, epoch, system_prompt_append, fresh_start, seed_prefix
		FROM threads ORDER BY created_at, id`)
	if err != nil {
		return nil, fmt.Errorf("thread: load: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []Thread
	for rows.Next() {
		var s Thread
		var created, active, statusAt, lastResult, archived, snoozed, reportAt int64
		var state, perm, status, reportStatus, kind int
		var labels, spawnEnv, spawnAddDirs, resumeNote string
		var inSidebar sql.NullBool
		if err := rows.Scan(&s.ID, &s.ClaudeSessionID, &s.ProjectID, &s.WorktreePath, &s.Name, &s.AutoNamed,
			&s.Model, &s.Effort, &created, &active, &s.ParentID, &state, &s.DisconnectReason, &s.ExitCode, &s.LastError,
			&perm, &s.BaseRef, &s.CreatedWorktree, &s.WorkspaceID, &s.Pinned,
			&status, &s.StatusReason, &statusAt,
			&s.ContextTokens, &s.ContextModel, &lastResult, &archived, &snoozed,
			&s.CreatedBy, &s.CreatedByName, &s.Brief, &labels,
			&reportStatus, &s.Report.Summary, &s.Report.Data, &reportAt, &s.BudgetUSD, &s.BudgetHitUSD, &s.Branch, &s.NameProvisional, &s.Owner, &spawnEnv, &spawnAddDirs, &resumeNote,
			&inSidebar, &kind, &s.ResidentName, &s.Epoch, &s.SystemPromptAppend, &s.FreshStart, &s.SeedPrefix); err != nil {
			return nil, fmt.Errorf("thread: load: %w", err)
		}
		s.CreatedAt, s.LastActivityAt, s.State = fromMillis(created), fromMillis(active), State(state)
		if s.PermissionMode = PermissionMode(perm); !s.PermissionMode.valid() {
			s.PermissionMode = PermissionDefault
		}
		if s.Status = Status(status); !s.Status.valid() {
			s.Status, s.StatusReason = StatusUnknown, ""
		}
		s.StatusChangedAt = fromMillis(statusAt)
		s.LastResultAt = fromMillis(lastResult)
		s.ArchivedAt = fromMillis(archived)
		s.SnoozedUntil = fromMillis(snoozed)
		s.Labels = parseLabels(labels)
		s.SpawnEnv, s.SpawnAddDirs = parseLabels(spawnEnv), parseLabels(spawnAddDirs)
		s.ResumeNote = parseResumeNote(resumeNote)
		if s.Kind = ThreadKind(kind); !s.Kind.valid() {
			s.Kind = KindNormal
		}
		if inSidebar.Valid {
			s.SidebarOverride = sidebarOverride(inSidebar.Bool)
		}
		if s.Report.Status = ReportStatus(reportStatus); !s.Report.Status.valid() {
			s.Report.Status = ReportNone
		}
		s.Report.At = fromMillis(reportAt)
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("thread: load: %w", err)
	}
	links, err := loadLinks(ctx, db)
	if err != nil {
		return nil, err
	}
	usage, err := loadUsage(ctx, db)
	if err != nil {
		return nil, err
	}
	transcripts, err := loadTranscripts(ctx, db)
	if err != nil {
		return nil, err
	}
	runs, err := loadAgentRuns(ctx, db)
	if err != nil {
		return nil, err
	}
	for i := range out {
		id := out[i].ID
		out[i].LinkedPullRequests = links[id]
		out[i].Usage = usage[id]
		out[i].Transcripts = transcripts[id]
		out[i].AgentRuns = runs[id]
	}
	return out, nil
}

// saveLinks records newly linked pull requests. A URL the thread already has is
// ignored.
func saveLinks(ctx context.Context, db *sql.DB, threadID string, links []LinkedPullRequest) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("thread: save links of %s: %w", threadID, err)
	}
	defer func() { _ = tx.Rollback() }()
	for _, l := range links {
		if _, err := tx.ExecContext(ctx, `INSERT INTO thread_pull_requests (thread_id, slug, number, url, linked_at, source, via_thread_id)
			VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (thread_id, url) DO NOTHING`,
			threadID, l.Slug, l.Number, l.URL, millis(l.LinkedAt), string(cmp.Or(l.Source, LinkClaude)), l.ViaThreadID); err != nil {
			return fmt.Errorf("thread: save links of %s: %w", threadID, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("thread: save links of %s: %w", threadID, err)
	}
	return nil
}

// loadLinks returns every thread's linked pull requests in first-seen (insertion)
// order.
func loadLinks(ctx context.Context, db *sql.DB) (map[string][]LinkedPullRequest, error) {
	rows, err := db.QueryContext(ctx, `SELECT thread_id, slug, number, url, linked_at, source, via_thread_id
		FROM thread_pull_requests ORDER BY thread_id, rowid`)
	if err != nil {
		return nil, fmt.Errorf("thread: load links: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := map[string][]LinkedPullRequest{}
	for rows.Next() {
		var id string
		var l LinkedPullRequest
		var at int64
		var source string
		if err := rows.Scan(&id, &l.Slug, &l.Number, &l.URL, &at, &source, &l.ViaThreadID); err != nil {
			return nil, fmt.Errorf("thread: load links: %w", err)
		}
		l.LinkedAt, l.Source = fromMillis(at), LinkSource(source)
		out[id] = append(out[id], l)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("thread: load links: %w", err)
	}
	return out, nil
}

// labelsJSON is the labels column: a JSON array, "[]" for none.
func labelsJSON(labels []string) string {
	if len(labels) == 0 {
		return "[]"
	}
	b, err := json.Marshal(labels)
	if err != nil {
		return "[]" // a []string always marshals
	}
	return string(b)
}

// parseLabels reads the labels column; a malformed value (hand-edited) is no labels.
func parseLabels(col string) []string {
	var out []string
	if json.Unmarshal([]byte(col), &out) != nil || len(out) == 0 {
		return nil
	}
	return out
}
