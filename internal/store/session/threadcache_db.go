package session

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
)

// Persistence of what a thread's Claude last reported about itself (migration 0021):
// its slash commands (slashcommands.go) and its MCP status (mcp.go). Both outlive the
// process, so a thread stopped at its cache expiry (lifecycle.go) still offers its
// commands and shows its servers, also after a daemon restart; the next process
// replaces them. Written when they change, read when the thread's log is loaded
// (Manager.thread).

// saveSlashCommands records a thread's slash commands (nil: none).
func saveSlashCommands(ctx context.Context, db *sql.DB, sessionID string, cs []SlashCommand) error {
	v := ""
	if cs != nil {
		b, err := json.Marshal(cs)
		if err != nil {
			return fmt.Errorf("session: encode slash commands of %s: %w", sessionID, err)
		}
		v = string(b)
	}
	return saveThreadCache(ctx, db, sessionID, "slash_commands", v)
}

// saveMcpStatus records a thread's MCP status (nil: none).
func saveMcpStatus(ctx context.Context, db *sql.DB, sessionID string, s *McpStatus) error {
	v := ""
	if s != nil {
		b, err := json.Marshal(s)
		if err != nil {
			return fmt.Errorf("session: encode MCP status of %s: %w", sessionID, err)
		}
		v = string(b)
	}
	return saveThreadCache(ctx, db, sessionID, "mcp_status", v)
}

// saveThreadCache upserts one column; col is one of the two above, never user input.
func saveThreadCache(ctx context.Context, db *sql.DB, sessionID, col, v string) error {
	_, err := db.ExecContext(ctx, `INSERT INTO session_thread_cache (session_id, `+col+`) VALUES (?, ?)
		ON CONFLICT (session_id) DO UPDATE SET `+col+` = excluded.`+col, sessionID, v)
	if err != nil {
		return fmt.Errorf("session: save %s of %s: %w", col, sessionID, err)
	}
	return nil
}

// loadThreadCache returns a thread's saved slash commands and MCP status (nil when
// none were saved). A value that does not decode is dropped, with an error the caller
// logs: the next process reports it again.
func loadThreadCache(ctx context.Context, db *sql.DB, sessionID string) ([]SlashCommand, *McpStatus, error) {
	var cmds, mcp string
	err := db.QueryRowContext(ctx, `SELECT slash_commands, mcp_status FROM session_thread_cache WHERE session_id = ?`,
		sessionID).Scan(&cmds, &mcp)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		return nil, nil, nil
	case err != nil:
		return nil, nil, fmt.Errorf("session: load thread cache of %s: %w", sessionID, err)
	}
	var cs []SlashCommand
	var st *McpStatus
	var errs []error
	if cmds != "" {
		if err := json.Unmarshal([]byte(cmds), &cs); err != nil {
			cs = nil
			errs = append(errs, fmt.Errorf("session: decode slash commands of %s: %w", sessionID, err))
		} else if cs == nil {
			cs = []SlashCommand{} // "[]": Claude reported none (visibleSlashCommands is never nil)
		}
	}
	if mcp != "" {
		st = &McpStatus{}
		if err := json.Unmarshal([]byte(mcp), st); err != nil {
			st = nil
			errs = append(errs, fmt.Errorf("session: decode MCP status of %s: %w", sessionID, err))
		}
	}
	return cs, st, errors.Join(errs...)
}
