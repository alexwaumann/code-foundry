package thread

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// Plugins' thread flags are notifications now (thread/setFlag is rerouted by the daemon;
// docs/notes/plugin-flag-retirement.md): the thread store no longer carries them, so a
// flag never changes a thread's status, section or attention. What the store keeps for
// them:
//
//   - the moment the user sees a thread (SetSeenHook): a viewer opening while presence is
//     attended, or presence rising with the thread open (attended.go), the acknowledge
//     points of a finished turn. The daemon dismisses the thread's until-seen flag
//     notifications then.
//   - Seen: whether the user sees a thread now, so an until-seen flag raised on an open
//     thread is seen at once and never shown.
//   - the rows thread_flags (migration 0030) held before: LegacyFlags reads them and
//     DropLegacyFlag deletes one once the daemon has converted it, at start. Nothing else
//     reads or writes that table any more; it stays so no migration is needed.

// SetSeenHook sets the function told each time the user sees a thread (seenLocked). It
// is called with the store's lock held: it must not call back into the thread store.
func (m *Manager) SetSeenHook(f func(threadID string)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.seenHook = f
}

// Seen reports whether the user sees thread id now: it has a viewer (WatchItems) and
// presence is attended.
func (m *Manager) Seen(id string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.viewers[id] > 0 && m.attended()
}

// seenHookLocked tells the seen hook that the user sees rec. m.mu held.
func (m *Manager) seenHookLocked(rec *record) {
	if m.seenHook != nil {
		m.seenHook(rec.s.ID)
	}
}

// LegacyFlag is a plugin's flag as thread_flags kept it before flags became
// notifications.
type LegacyFlag struct {
	ThreadID string
	// Source is the plugin's name, SourceName its display name when the flag was set.
	Source, SourceName string
	// Level is "attention" or "error".
	Level     string
	Reason    string
	UntilSeen bool
	SetAt     time.Time
}

// legacyFlagLevels are thread_flags.level's values.
var legacyFlagLevels = map[int]string{1: "attention", 2: "error"}

// LegacyFlags returns the rows left in thread_flags, oldest first.
func (m *Manager) LegacyFlags(ctx context.Context) ([]LegacyFlag, error) {
	return loadLegacyFlags(ctx, m.opts.DB)
}

// DropLegacyFlag deletes source's row on thread id from thread_flags.
func (m *Manager) DropLegacyFlag(ctx context.Context, id, source string) error {
	if _, err := m.opts.DB.ExecContext(ctx, `DELETE FROM thread_flags WHERE thread_id = ? AND source = ?`, id, source); err != nil {
		return fmt.Errorf("thread: drop legacy flag: %w", err)
	}
	return nil
}

func loadLegacyFlags(ctx context.Context, db *sql.DB) ([]LegacyFlag, error) {
	rows, err := db.QueryContext(ctx, `SELECT thread_id, source, source_name, level, reason, until_seen, set_at FROM thread_flags ORDER BY set_at, thread_id, source`)
	if err != nil {
		return nil, fmt.Errorf("thread: load legacy flags: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []LegacyFlag
	for rows.Next() {
		var f LegacyFlag
		var level, until int
		var at int64
		if err := rows.Scan(&f.ThreadID, &f.Source, &f.SourceName, &level, &f.Reason, &until, &at); err != nil {
			return nil, fmt.Errorf("thread: load legacy flags: %w", err)
		}
		f.Level, f.UntilSeen, f.SetAt = legacyFlagLevels[level], until != 0, time.UnixMilli(at)
		if f.Level == "" {
			f.Level = "attention"
		}
		out = append(out, f)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("thread: load legacy flags: %w", err)
	}
	return out, nil
}
