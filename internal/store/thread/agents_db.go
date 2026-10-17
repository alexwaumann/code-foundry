package thread

import (
	"context"
	"database/sql"
	"fmt"
)

// Persistence of the agents model (migration 0019; agents.go). Runs are written with
// the usage (saveUsageUpdate) or alone (saveAgentRuns).

// saveAgentRuns writes runs' rows (not their usage) in one transaction.
func saveAgentRuns(ctx context.Context, db *sql.DB, threadID string, runs []AgentRun) error {
	if len(runs) == 0 {
		return nil
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("thread: save agent runs of %s: %w", threadID, err)
	}
	defer func() { _ = tx.Rollback() }()
	for _, r := range runs {
		if err := saveAgentRunTx(ctx, tx, threadID, r); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("thread: save agent runs of %s: %w", threadID, err)
	}
	return nil
}

// failOrphanedRuns fails every run saved as running, at startup: subagents run inside
// their thread's claude process, which did not outlive the daemon (a crash or a kill
// skipped the runner's own endRuns).
func failOrphanedRuns(ctx context.Context, db *sql.DB) (int64, error) {
	res, err := db.ExecContext(ctx, `UPDATE session_agent_runs SET status = ?, error = ? WHERE status = ?`,
		string(AgentFailed), orphanDaemonRestart+orphanSuffix, string(AgentRunning))
	if err != nil {
		return 0, fmt.Errorf("thread: fail orphaned agent runs: %w", err)
	}
	n, _ := res.RowsAffected()
	return n, nil
}
