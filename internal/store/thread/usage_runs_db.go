package thread

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// Persistence for session_transcripts, session_agent_runs and session_source_usage
// (migrations 0013 and 0019; usage_runs.go, agents.go).

// saveUsageUpdate writes a usage update in one transaction: the thread's total
// (session_usage, replaced whole), the changed sources' buckets (each replaced whole),
// and the runs whose info changed.
func saveUsageUpdate(ctx context.Context, db *sql.DB, sessionID string, up usageUpdate, runs []AgentRun) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("session: save usage of %s: %w", sessionID, err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := replaceUsageTx(ctx, tx, sessionID, up.total); err != nil {
		return err
	}
	for source, buckets := range up.sources {
		if _, err := tx.ExecContext(ctx, `DELETE FROM session_source_usage WHERE session_id = ? AND source = ?`, sessionID, source); err != nil {
			return fmt.Errorf("session: save usage of %s: %w", sessionID, err)
		}
		for _, b := range buckets {
			if _, err := tx.ExecContext(ctx, `INSERT INTO session_source_usage (session_id, source, `+usageColumns+`)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, append([]any{sessionID, source}, usageArgs(b)...)...); err != nil {
				return fmt.Errorf("session: save usage of %s: %w", sessionID, err)
			}
		}
	}
	for _, r := range runs {
		if err := saveAgentRunTx(ctx, tx, sessionID, r); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("session: save usage of %s: %w", sessionID, err)
	}
	return nil
}

// saveAgentRunTx writes one run's row (everything but its usage).
func saveAgentRunTx(ctx context.Context, tx *sql.Tx, sessionID string, r AgentRun) error {
	if _, err := tx.ExecContext(ctx, `INSERT INTO session_agent_runs (session_id, agent_id, claude_session_id,
			tool_use_id, description, agent_type, model, effort, spawn_depth, background, open, started_at,
			parent_id, status, activity, last_tool, total_tokens, tool_uses, duration_ms, summary, error,
			resumed_at, ended_at, note_item_id)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (session_id, agent_id) DO UPDATE SET
			claude_session_id = excluded.claude_session_id,
			tool_use_id = excluded.tool_use_id,
			description = excluded.description,
			agent_type = excluded.agent_type,
			model = excluded.model,
			effort = excluded.effort,
			spawn_depth = excluded.spawn_depth,
			background = excluded.background,
			open = excluded.open,
			started_at = excluded.started_at,
			parent_id = excluded.parent_id,
			status = excluded.status,
			activity = excluded.activity,
			last_tool = excluded.last_tool,
			total_tokens = excluded.total_tokens,
			tool_uses = excluded.tool_uses,
			duration_ms = excluded.duration_ms,
			summary = excluded.summary,
			error = excluded.error,
			resumed_at = excluded.resumed_at,
			ended_at = excluded.ended_at,
			note_item_id = excluded.note_item_id`,
		sessionID, r.ID, r.ClaudeSessionID, r.ToolUseID, r.Description, r.AgentType, r.Model, r.Effort,
		r.SpawnDepth, r.Background, r.Open, millis(r.StartedAt),
		r.ParentID, string(r.Status), r.Activity, r.LastTool, r.TotalTokens, r.ToolUses, r.DurationMS, r.Summary, r.Error,
		millis(r.ResumedAt), millis(r.EndedAt), r.NoteItemID); err != nil {
		return fmt.Errorf("session: save agent run %s of %s: %w", r.ID, sessionID, err)
	}
	return nil
}

// saveTranscript records that a thread used Claude session id cid, at position seq.
func saveTranscript(ctx context.Context, db *sql.DB, sessionID, cid string, seq int) error {
	if _, err := db.ExecContext(ctx, `INSERT INTO session_transcripts (session_id, claude_session_id, seq)
		VALUES (?, ?, ?) ON CONFLICT (session_id, claude_session_id) DO NOTHING`, sessionID, cid, seq); err != nil {
		return fmt.Errorf("session: save transcript %s of %s: %w", cid, sessionID, err)
	}
	return nil
}

// loadTranscripts returns every session's transcript ids, oldest first.
func loadTranscripts(ctx context.Context, db *sql.DB) (map[string][]string, error) {
	rows, err := db.QueryContext(ctx, `SELECT session_id, claude_session_id FROM session_transcripts
		ORDER BY session_id, seq, rowid`)
	if err != nil {
		return nil, fmt.Errorf("session: load transcripts: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := map[string][]string{}
	for rows.Next() {
		var id, cid string
		if err := rows.Scan(&id, &cid); err != nil {
			return nil, fmt.Errorf("session: load transcripts: %w", err)
		}
		out[id] = append(out[id], cid)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("session: load transcripts: %w", err)
	}
	return out, nil
}

// loadAgentRuns returns every session's runs (sorted like Session.AgentRuns) with
// their usage.
func loadAgentRuns(ctx context.Context, db *sql.DB) (map[string][]AgentRun, error) {
	rows, err := db.QueryContext(ctx, `SELECT session_id, agent_id, claude_session_id, tool_use_id, description,
			agent_type, model, effort, spawn_depth, background, open, started_at,
			parent_id, status, activity, last_tool, total_tokens, tool_uses, duration_ms, summary, error,
			resumed_at, ended_at, note_item_id
		FROM session_agent_runs`)
	if err != nil {
		return nil, fmt.Errorf("session: load agent runs: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := map[string][]AgentRun{}
	for rows.Next() {
		var id, status string
		var r AgentRun
		var started, resumed, ended int64
		if err := rows.Scan(&id, &r.ID, &r.ClaudeSessionID, &r.ToolUseID, &r.Description, &r.AgentType, &r.Model,
			&r.Effort, &r.SpawnDepth, &r.Background, &r.Open, &started,
			&r.ParentID, &status, &r.Activity, &r.LastTool, &r.TotalTokens, &r.ToolUses, &r.DurationMS, &r.Summary, &r.Error,
			&resumed, &ended, &r.NoteItemID); err != nil {
			return nil, fmt.Errorf("session: load agent runs: %w", err)
		}
		if started != 0 {
			r.StartedAt = time.UnixMilli(started).UTC()
		}
		r.Status, r.ResumedAt, r.EndedAt = AgentStatus(status), fromMillis(resumed), fromMillis(ended)
		out[id] = append(out[id], r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("session: load agent runs: %w", err)
	}
	if len(out) == 0 {
		return out, nil
	}
	sources, err := loadSourceUsage(ctx, db, "")
	if err != nil {
		return nil, err
	}
	for id, runs := range out {
		for i := range runs {
			runs[i].Usage = sources[id][runSource(runs[i].ID)]
		}
		sortRuns(runs)
	}
	return out, nil
}

// loadSourceUsage returns the per-source buckets of one session (sessionID != "") or
// of all: session id -> source -> buckets sorted by (Day, Model, Tier, Speed).
func loadSourceUsage(ctx context.Context, db *sql.DB, sessionID string) (map[string]map[string][]UsageBucket, error) {
	q := `SELECT session_id, source, ` + usageColumns + ` FROM session_source_usage`
	var args []any
	if sessionID != "" {
		q += ` WHERE session_id = ?`
		args = append(args, sessionID)
	}
	rows, err := db.QueryContext(ctx, q+` ORDER BY session_id, source, day, model, tier, speed`, args...)
	if err != nil {
		return nil, fmt.Errorf("session: load source usage: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := map[string]map[string][]UsageBucket{}
	for rows.Next() {
		var id, source string
		b, err := scanBucket(rows, &id, &source)
		if err != nil {
			return nil, fmt.Errorf("session: load source usage: %w", err)
		}
		if out[id] == nil {
			out[id] = map[string][]UsageBucket{}
		}
		out[id][source] = append(out[id][source], b)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("session: load source usage: %w", err)
	}
	return out, nil
}
