package thread

import (
	"cmp"
	"context"
	"database/sql"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
)

// Flags are an overlay on a thread's status that plugins raise (thread/setFlag;
// docs/notes/plugins-3-events-flags-env.md): one per (thread, source), attention or
// error with a one-line reason. They never touch Status, which belongs to the stream:
// the GUI reads a flagged thread as needing attention. The store knows nothing about
// plugins: Source is opaque (the daemon passes the plugin's name).
//
// A flag goes when its source clears it (SetFlag with FlagNone, ClearFlags,
// ClearFlagSource: the daemon calls it when a plugin is disabled or removed), when the
// thread is archived or removed, and, for an UntilSeen flag, when the thread is opened
// (WatchItems starts) or at once when it is set on a thread someone watches: the same
// acknowledge points as a finished turn (runner.acknowledge). Persisted (thread_flags).

// FlagLevel is how loud a flag is. Values mirror codefoundry.v1.ThreadFlagLevel.
type FlagLevel int

// Flag levels.
const (
	// FlagNone clears a flag (SetFlag); never stored.
	FlagNone FlagLevel = iota
	// FlagAttention: the thread needs the user (amber).
	FlagAttention
	// FlagError: something failed (red).
	FlagError
)

func (l FlagLevel) String() string {
	switch l {
	case FlagAttention:
		return "attention"
	case FlagError:
		return "error"
	default:
		return "none"
	}
}

// ParseFlagLevel reads "attention", "error" or "none".
func ParseFlagLevel(s string) (FlagLevel, bool) {
	switch s {
	case "attention":
		return FlagAttention, true
	case "error":
		return FlagError, true
	case "none", "":
		return FlagNone, true
	}
	return FlagNone, false
}

// MaxFlagReasonRunes bounds a flag's reason.
const MaxFlagReasonRunes = 80

// Flag is one source's flag on a thread. A value in Thread.Flags: never mutated.
type Flag struct {
	// Source is who raised it (a plugin's name); opaque to the store.
	Source string
	// SourceName is the source's display name when the flag was set.
	SourceName string
	Level      FlagLevel
	// Reason is one line, at most MaxFlagReasonRunes.
	Reason string
	SetAt  time.Time
	// UntilSeen clears the flag when the user opens the thread, or, when it was open
	// while they were away from the app, once they look at the app again (attended.go).
	UntilSeen bool
}

// CleanFlagReason trims a reason and checks it: one line, at most MaxFlagReasonRunes,
// not empty.
func CleanFlagReason(r string) (string, error) {
	r = strings.TrimSpace(r)
	switch {
	case r == "":
		return "", fmt.Errorf("%w: a flag needs a reason", ErrInvalidArgument)
	case strings.ContainsAny(r, "\r\n\x00"):
		return "", fmt.Errorf("%w: a flag's reason is one line", ErrInvalidArgument)
	case utf8.RuneCountInString(r) > MaxFlagReasonRunes:
		return "", fmt.Errorf("%w: a flag's reason is %d characters; at most %d", ErrInvalidArgument, utf8.RuneCountInString(r), MaxFlagReasonRunes)
	}
	return r, nil
}

// sortFlags orders flags as Thread.Flags keeps them: errors first, then newest first,
// then by source.
func sortFlags(fs []Flag) {
	slices.SortFunc(fs, func(a, b Flag) int {
		if c := cmp.Compare(b.Level, a.Level); c != 0 {
			return c
		}
		if c := b.SetAt.Compare(a.SetAt); c != 0 {
			return c
		}
		return strings.Compare(a.Source, b.Source)
	})
}

// withoutFlags returns flags minus those drop matches (a new slice, nil when none are
// left) and whether any went.
func withoutFlags(flags []Flag, drop func(Flag) bool) ([]Flag, bool) {
	if !slices.ContainsFunc(flags, drop) {
		return flags, false
	}
	var out []Flag
	for _, f := range flags {
		if !drop(f) {
			out = append(out, f)
		}
	}
	return out, true
}

// SetFlag raises source's flag on thread id, replacing the one it had, or clears it
// with FlagNone. changed is false when nothing changed (the same flag again, or nothing
// to clear). An archived thread refuses a flag (ErrFailedPrecondition); an UntilSeen flag
// on a thread someone watches while presence is attended (attended.go) is seen at once,
// so it only clears the source's flag.
func (m *Manager) SetFlag(ctx context.Context, id string, f Flag) (t Thread, changed bool, err error) {
	if f.Source == "" {
		return Thread{}, false, fmt.Errorf("%w: a flag needs a source", ErrInvalidArgument)
	}
	if f.Level != FlagNone {
		if f.Level != FlagAttention && f.Level != FlagError {
			return Thread{}, false, fmt.Errorf("%w: flag level %d", ErrInvalidArgument, f.Level)
		}
		if f.Reason, err = CleanFlagReason(f.Reason); err != nil {
			return Thread{}, false, err
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, err := m.record(id)
	if err != nil {
		return Thread{}, false, err
	}
	i := slices.IndexFunc(rec.s.Flags, func(x Flag) bool { return x.Source == f.Source })
	seen := f.UntilSeen && m.viewers[id] > 0 && m.attended()
	if f.Level == FlagNone || seen {
		if i < 0 {
			return rec.s, false, nil
		}
		if err := deleteFlags(ctx, m.opts.DB, id, f.Source); err != nil {
			return Thread{}, false, err
		}
		rec.s.Flags, _ = withoutFlags(rec.s.Flags, func(x Flag) bool { return x.Source == f.Source })
		m.commitLocked(rec, false)
		return rec.s, true, nil
	}
	if !rec.s.ArchivedAt.IsZero() {
		return Thread{}, false, fmt.Errorf("%w: thread %s is archived", ErrFailedPrecondition, id)
	}
	if i >= 0 {
		old := rec.s.Flags[i]
		if old.Level == f.Level && old.Reason == f.Reason && old.UntilSeen == f.UntilSeen && old.SourceName == f.SourceName {
			return rec.s, false, nil
		}
	}
	f.SetAt = m.opts.Now().Truncate(time.Millisecond)
	if err := saveFlag(ctx, m.opts.DB, id, f); err != nil {
		return Thread{}, false, err
	}
	flags, _ := withoutFlags(rec.s.Flags, func(x Flag) bool { return x.Source == f.Source })
	flags = append(slices.Clip(flags), f)
	sortFlags(flags)
	rec.s.Flags = flags
	m.commitLocked(rec, false)
	return rec.s, true, nil
}

// ClearFlags removes source's flag from thread id, or every flag with source "", and
// returns the thread and how many went.
func (m *Manager) ClearFlags(ctx context.Context, id, source string) (Thread, int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, err := m.record(id)
	if err != nil {
		return Thread{}, 0, err
	}
	n, err := m.dropFlagsLocked(ctx, rec, func(f Flag) bool { return source == "" || f.Source == source })
	if err != nil {
		return Thread{}, 0, err
	}
	if n > 0 {
		m.commitLocked(rec, false)
	}
	return rec.s, n, nil
}

// ClearFlagSource removes source's flags from every thread (the plugin was disabled or
// removed) and returns how many went.
func (m *Manager) ClearFlagSource(ctx context.Context, source string) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	total := 0
	for _, rec := range m.recs {
		n, err := m.dropFlagsLocked(ctx, rec, func(f Flag) bool { return f.Source == source })
		if err != nil {
			return total, err
		}
		if n > 0 {
			total += n
			m.commitLocked(rec, false)
		}
	}
	return total, nil
}

// FlagsOf returns source's flags by thread id.
func (m *Manager) FlagsOf(source string) map[string]Flag {
	out := map[string]Flag{}
	for _, t := range m.Snapshot().Threads {
		for _, f := range t.Flags {
			if f.Source == source {
				out[t.ID] = f
			}
		}
	}
	return out
}

// dropFlagsLocked removes rec's flags that drop matches, from the database first, and
// returns how many went. The caller commits. m.mu held.
func (m *Manager) dropFlagsLocked(ctx context.Context, rec *record, drop func(Flag) bool) (int, error) {
	n := 0
	for _, f := range rec.s.Flags {
		if !drop(f) {
			continue
		}
		if err := deleteFlags(ctx, m.opts.DB, rec.s.ID, f.Source); err != nil {
			return 0, err
		}
		n++
	}
	if n > 0 {
		rec.s.Flags, _ = withoutFlags(rec.s.Flags, drop)
	}
	return n, nil
}

// seenFlagsLocked clears rec's UntilSeen flags: the user opened the thread. It reports
// whether any went; the caller commits. m.mu held.
func (m *Manager) seenFlagsLocked(rec *record) bool {
	n, err := m.dropFlagsLocked(context.Background(), rec, func(f Flag) bool { return f.UntilSeen })
	if err != nil {
		m.log.Warn("clear seen flags", "thread", rec.s.ID, "err", err)
	}
	return n > 0
}

func saveFlag(ctx context.Context, db *sql.DB, id string, f Flag) error {
	until := 0
	if f.UntilSeen {
		until = 1
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO thread_flags (thread_id, source, source_name, level, reason, until_seen, set_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (thread_id, source) DO UPDATE SET source_name = excluded.source_name, level = excluded.level,
			reason = excluded.reason, until_seen = excluded.until_seen, set_at = excluded.set_at`,
		id, f.Source, f.SourceName, int(f.Level), f.Reason, until, f.SetAt.UnixMilli()); err != nil {
		return fmt.Errorf("thread: save flag: %w", err)
	}
	return nil
}

func deleteFlags(ctx context.Context, db *sql.DB, id, source string) error {
	if _, err := db.ExecContext(ctx, `DELETE FROM thread_flags WHERE thread_id = ? AND source = ?`, id, source); err != nil {
		return fmt.Errorf("thread: delete flag: %w", err)
	}
	return nil
}

// loadFlags reads every thread's flags, sorted as Thread.Flags.
func loadFlags(ctx context.Context, db *sql.DB) (map[string][]Flag, error) {
	rows, err := db.QueryContext(ctx, `SELECT thread_id, source, source_name, level, reason, until_seen, set_at FROM thread_flags`)
	if err != nil {
		return nil, fmt.Errorf("thread: load flags: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := map[string][]Flag{}
	for rows.Next() {
		var id string
		var f Flag
		var level, until int
		var at int64
		if err := rows.Scan(&id, &f.Source, &f.SourceName, &level, &f.Reason, &until, &at); err != nil {
			return nil, fmt.Errorf("thread: load flags: %w", err)
		}
		f.Level, f.UntilSeen, f.SetAt = FlagLevel(level), until != 0, time.UnixMilli(at)
		out[id] = append(out[id], f)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("thread: load flags: %w", err)
	}
	for _, fs := range out {
		sortFlags(fs)
	}
	return out, nil
}
