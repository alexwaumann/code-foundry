package settings

import (
	"errors"
	"os"
	"slices"
	"strings"
)

// A once clear drops a value from the user's settings one time: the value a file still
// holds from before a change that made it harmful, which a user could also choose on
// purpose now. Unlike retiredChords (a value that is never wanted, cleared by decode on
// every read), it is cleared only until the user has had the chance to choose: once the
// settings file no longer holds it, the clear's id goes into the marker file beside the
// settings file (settings.toml.cleared), and from then on the value is the user's again.
//
// While a clear is pending, the value is dropped from every load, with no issue, so the
// next save leaves it out; the file itself is left alone until then, so nothing else in
// it is rewritten. It is done when:
//   - a load reads the file and it does not hold the value (never had it, or the user
//     changed it by hand), or
//   - the app saves the file (Update): the saved file leaves the value out, or holds the
//     one the user just chose.
type onceClear struct {
	// id is recorded in the marker file once the clear is done. Never reuse one.
	id string
	// key is the setting cleared.
	key string
	// stale reports whether the file's raw value is the one to clear.
	stale func(raw string) bool
}

// onceClears are the one-time clears, in the order they were added.
//
// terminal.new-none: until 2026-11-12 the shell window ran cmd+t itself, ahead of the
// registry's bindings, so a [keybindings] "terminal.new" = "none" from the classic window
// did nothing there. Since the commands' keybindings are the shell's keymap (90669a9c7,
// 57035987a) it unbinds cmd+t, and New Terminal has no key (docs/notes/keybinding-reset-default.md).
var onceClears = []onceClear{
	{id: "terminal.new-none-2026-11", key: KeybindingKey("terminal.new"), stale: isKeybindingNone},
}

func isKeybindingNone(raw string) bool {
	v, err := Field{Type: Keybinding}.parse(raw)
	return err == nil && v == KeybindingNone
}

// ClearedSuffix names the marker file of the once clears that are done, beside the
// settings file (settings.toml.cleared): one id per line.
const ClearedSuffix = ".cleared"

func (s *Store) clearedPath() string { return s.opts.Path + ClearedSuffix }

// readCleared loads the marker file into s.cleared. A missing file means none is done; an
// unreadable one is logged and treated the same (the clears only drop stale values).
func (s *Store) readCleared() {
	s.cleared = map[string]bool{}
	data, err := os.ReadFile(s.clearedPath())
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			s.log.Warn("settings: could not read the cleared values' marker", "path", s.clearedPath(), "err", err)
		}
		return
	}
	for _, id := range strings.Fields(string(data)) {
		s.cleared[id] = true
	}
}

// applyOnceClears drops the pending clears' stale values from raw. fromFile is set when
// raw is what the settings file holds now (not the last-good copy): a pending clear whose
// stale value it lacks is done. s.mu held (or Open).
func (s *Store) applyOnceClears(raw map[string]string, fromFile bool) {
	var done []string
	for _, c := range onceClears {
		if s.cleared[c.id] {
			continue
		}
		if v, ok := raw[c.key]; ok && c.stale(v) {
			delete(raw, c.key)
			s.log.Info("settings: cleared a value left from before a change", "key", c.key, "value", v, "clear", c.id)
			continue
		}
		if fromFile {
			done = append(done, c.id)
		}
	}
	s.markCleared(done)
}

// markPendingCleared marks every pending clear done: the app has just written the file.
// s.mu held.
func (s *Store) markPendingCleared() {
	var done []string
	for _, c := range onceClears {
		if !s.cleared[c.id] {
			done = append(done, c.id)
		}
	}
	s.markCleared(done)
}

// markCleared records ids as done, in memory and in the marker file. A failed write is
// logged: this process keeps them done, and a later start clears again only a value the
// file still holds.
func (s *Store) markCleared(ids []string) {
	if len(ids) == 0 {
		return
	}
	for _, id := range ids {
		s.cleared[id] = true
	}
	all := make([]string, 0, len(s.cleared))
	for id := range s.cleared {
		all = append(all, id)
	}
	slices.Sort(all)
	if err := writeAtomic(s.clearedPath(), []byte(strings.Join(all, "\n")+"\n")); err != nil {
		s.log.Warn("settings: could not record the cleared values", "path", s.clearedPath(), "err", err)
	}
}
