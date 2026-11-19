package settings

import (
	"context"
	"maps"
)

// A default change is a setting whose schema default changed in a way an existing user
// would notice. A new home gets the new default; a home from before the change keeps
// what it had: once, at the first start after the change, the daemon writes the old
// default into the settings file when the file does not set the key
// (docs/notes/threads-open-as-3-default.md). After that the value is the user's like any
// other, and the key is never looked at again.
//
// The step's progress lives in the marker file of the once clears (settings.toml.cleared,
// once.go), one id per line, so an older daemon keeps the lines:
//
//   - <id>: decided. A new home, a file that already set the key, or the old default
//     written. The key is never looked at again.
//   - <id>.notice: the old default is being written on a home from before the change, so
//     the user is owed a notice (DueNotices). Recorded before the write: a daemon killed
//     between the write and <id> finds the key set on its next start and still owes it.
//   - <id>.noticed: the notice was posted (MarkNoticed); it is never posted again.
type defaultChange struct {
	// id is recorded in the marker file. Never reuse one.
	id string
	// key is the setting whose default changed.
	key string
	// old is its default before the change: what a home from before it keeps.
	old string
}

// defaultChanges are the default changes, in the order they were made.
//
// threads-open-as-panes: layout.threads_open_as defaulted to tabs until 2026-11-19
// (docs/notes/threads-open-as-3-default.md).
var defaultChanges = []defaultChange{
	{id: ThreadsOpenAsPanesDefault, key: KeyThreadsOpenAs, old: ThreadsOpenAsTabs},
}

// ThreadsOpenAsPanesDefault is the id of the change that made Panes the default of
// layout.threads_open_as: DueNotices names it when its notice is owed.
const ThreadsOpenAsPanesDefault = "layout.threads_open_as-panes-2026-11"

const (
	noticeSuffix  = ".notice"
	noticedSuffix = ".noticed"
)

// KeepOldDefaults runs every default change not yet decided. existing says the home has
// data from before this daemon started (the daemon checks for its database before
// opening it): a new home takes the new defaults. On an existing home whose file does not
// set a changed key, the old default is written through Update, as a save from the app
// writes the file. When that write fails (the file does not parse, or cannot be written),
// the old default is held in memory for this run, so the snapshot says it while the file
// does not set the key, nothing is recorded, and the next start tries again. Call it right
// after Open, before anything reads the settings.
func (s *Store) KeepOldDefaults(ctx context.Context, existing bool) {
	for _, c := range defaultChanges {
		s.keepOldDefault(ctx, c, existing)
	}
}

func (s *Store) keepOldDefault(ctx context.Context, c defaultChange, existing bool) {
	s.mu.Lock()
	switch {
	case s.cleared[c.id]:
		s.mu.Unlock()
		return
	case !existing:
		s.log.Info("settings: a new home takes the new default", "change", c.id, "key", c.key)
		s.markCleared([]string{c.id})
		s.mu.Unlock()
		return
	case s.loadErr != "":
		// The file does not parse: whether it sets the key is not known, and Update would
		// refuse. The last good copy's values stand in for it (Open); hold the old default
		// unless they set the key.
		if _, set := s.raw[c.key]; !set {
			s.holdLocked(c)
		}
		s.log.Warn("settings: the settings file does not parse; keeping the old default for this run and trying again at the next start",
			"change", c.id, "key", c.key, "value", c.old)
		s.mu.Unlock()
		return
	}
	if _, set := s.raw[c.key]; set {
		// The user's own choice (any value), or this step's write from a start that was
		// killed before it recorded <id>.
		s.markCleared([]string{c.id})
		s.mu.Unlock()
		return
	}
	s.markCleared([]string{c.id + noticeSuffix})
	s.mu.Unlock()

	if _, err := s.Update(ctx, map[string]string{c.key: c.old}); err != nil {
		s.mu.Lock()
		s.holdLocked(c)
		s.mu.Unlock()
		s.log.Warn("settings: could not keep the old default in the settings file; keeping it for this run and trying again at the next start",
			"change", c.id, "key", c.key, "value", c.old, "err", err)
		return
	}
	s.mu.Lock()
	s.markCleared([]string{c.id})
	s.mu.Unlock()
	s.log.Info("settings: kept the old default on a home from before the change", "change", c.id, "key", c.key, "value", c.old)
}

// holdLocked holds c's old default for this run and publishes it. s.mu held.
func (s *Store) holdLocked(c defaultChange) {
	if s.held == nil {
		s.held = map[string]string{}
	}
	s.held[c.key] = c.old
	s.publishLocked(resolveThemes(s.withHeld(s.raw), s.cmds, s.themes))
}

// withHeld is raw with the held old defaults for the keys raw does not set.
func (s *Store) withHeld(raw map[string]string) map[string]string {
	if len(s.held) == 0 {
		return raw
	}
	out := maps.Clone(raw)
	for k, v := range s.held {
		if _, set := out[k]; !set {
			out[k] = v
		}
	}
	return out
}

// DueNotices are the ids of the default changes whose notice is owed: decided, the old
// default written on a home from before the change, the notice not yet posted, and the
// key still holding the old default (a user who changed it since needs no telling).
func (s *Store) DueNotices() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	values := s.Snapshot().Values
	var due []string
	for _, c := range defaultChanges {
		if s.cleared[c.id] && s.cleared[c.id+noticeSuffix] && !s.cleared[c.id+noticedSuffix] && values[c.key] == c.old {
			due = append(due, c.id)
		}
	}
	return due
}

// MarkNoticed records that the notice of the default change id was posted.
func (s *Store) MarkNoticed(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.markCleared([]string{id + noticedSuffix})
}
