package settings

import (
	"bytes"
	"fmt"
	"maps"
	"math"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/BurntSushi/toml"
)

// File format: TOML, one table per group, keys without the group prefix:
//
//	[threads]
//	default_model = "claude-sonnet-5[1m]"
//
//	[keybindings]
//	"thread.new" = "cmd+shift+n"
//
// TOML over JSON: the file is meant to be edited by hand, and TOML has comments (the
// rendered file documents every field and shows its default) and no trailing-comma or
// quoting traps. BurntSushi/toml was already in the module graph (via Wails).

// Read returns the settings in the file at path without opening a store: no watcher,
// and a missing file is not created. A missing or unparsable file yields the defaults,
// and rejected values fall back to theirs. For CLI verbs that run without the daemon.
func Read(path string) Settings {
	data, err := os.ReadFile(path)
	if err != nil {
		return Defaults()
	}
	raw, err := decode(data)
	if err != nil {
		return Defaults()
	}
	return resolve(raw, nil).settings
}

// ThemeSlots is what the file at path names for the two theme slots, as written (a theme
// that is gone included), without opening a store: the user theme store reads those
// themes' files first (usertheme.Options.InUse). Nil when the file does not read.
func ThemeSlots(path string) []string {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	raw, err := decode(data)
	if err != nil {
		return nil
	}
	var out []string
	for _, k := range []string{KeyThemeDark, KeyThemeLight} {
		if v := raw[k]; v != "" {
			out = append(out, v)
		}
	}
	return out
}

// decode parses a settings file into raw string-encoded values keyed by settings key.
// Values are stringified leniently (14 and "14" both work for an int); type errors are
// found by Field.parse. Nested tables are flattened to dotted keys: under
// [keybindings], unquoted dotted keys (thread.new = ...) parse as nested tables, and an
// unknown sub-table ([threads.experimental]) is kept, key by key, for the next save. An
// unknown key whose value TOML has no string form for (an array of tables, a table in a
// list, a date or time) keeps its value as TOML text (rawValue).
func decode(data []byte) (map[string]string, error) {
	var doc map[string]any
	if _, err := toml.Decode(string(data), &doc); err != nil {
		return nil, err
	}
	raw := map[string]string{}
	for group, v := range doc {
		tbl, ok := v.(map[string]any)
		if !ok {
			raw[group] = rawValue(group, v)
			continue
		}
		flatten(raw, group, tbl)
	}
	renameMovedKeys(raw)
	dropRetiredKeys(raw)
	dropRetiredChords(raw)
	return raw, nil
}

// retiredKeys are settings that no longer exist; a file that still sets one reads
// without an "unknown setting" issue, and the next save leaves it out.
// projects.worktree_dir went when the app took over where worktrees go (always
// <config home>/worktrees/<owner>/<repo>/<branch>). threads.show_created_threads went
// when a thread another thread created was never in the sidebar any more
// (docs/notes/no-sidebar-override-2-daemon.md). appearance.panel_keep_open went with the
// side panel (docs/notes/shell-22-retire-verbs.md).
var retiredKeys = []string{
	GroupProjects + ".worktree_dir",
	GroupThreads + ".show_created_threads",
	GroupAppearance + ".panel_keep_open",
}

// movedKeys are settings that took a new key: old key -> new key. A file that still sets
// the old key reads as if it set the new one (unless it sets that too, which wins), and
// the next save writes only the new key. threads.naming_model became models.utility when
// the utility model became the model for all of the app's small jobs
// (docs/notes/search-1-utility-model.md); threads.scrollback_lines became
// appearance.scrollback_lines once only the terminals' shells read it, not threads.
var movedKeys = map[string]string{
	GroupThreads + ".naming_model":     KeyUtilityModel,
	GroupThreads + ".scrollback_lines": KeyScrollback,
}

// renameMovedKeys moves raw's movedKeys to their new keys.
func renameMovedKeys(raw map[string]string) {
	for old, key := range movedKeys {
		v, ok := raw[old]
		if !ok {
			continue
		}
		delete(raw, old)
		// An empty new key means unset, so it does not override the old value.
		if cur, set := raw[key]; !set || cur == "" {
			raw[key] = v
		}
	}
}

// dropRetiredKeys deletes raw's retiredKeys.
func dropRetiredKeys(raw map[string]string) {
	for _, k := range retiredKeys {
		delete(raw, k)
	}
}

// retiredChords are keybindings a command once had by default that another command has
// now: keybinding key -> that chord. A file that binds the command to exactly that chord
// (in any spelling the keybinding parser reads as it) reads as unset, so the command keeps
// its default now and the chord's new owner gets it; the next save leaves it out. Any other
// chord the user bound stays. dictation.toggle had cmd+shift+m by default until 2026-11-03
// (the hold key replaced it); pane.collapse has it now
// (docs/notes/shell-25g-race-chord.md).
var retiredChords = map[string]string{
	KeybindingKey("dictation.toggle"): "cmd+shift+m",
}

// dropRetiredChords deletes raw's retiredChords.
func dropRetiredChords(raw map[string]string) {
	field := Field{Type: Keybinding}
	for k, old := range retiredChords {
		v, ok := raw[k]
		if !ok {
			continue
		}
		got, err := field.parse(v)
		if err != nil {
			continue
		}
		if want, _ := field.parse(old); got == want {
			delete(raw, k)
		}
	}
}

func flatten(raw map[string]string, prefix string, tbl map[string]any) {
	for k, v := range tbl {
		key := prefix + "." + k
		if sub, ok := v.(map[string]any); ok {
			flatten(raw, key, sub)
			continue
		}
		raw[key] = rawValue(key, v)
	}
}

// verbatimPrefix marks a raw value that is TOML text, written back as it is
// (encodeLiteral). Only unknown keys hold one: no setting accepts it.
const verbatimPrefix = "\x00toml:"

// rawValue is v as the raw value of key: stringify's text, or for an unknown key whose
// value stringify would lose the shape of (structured), the value as inline TOML after
// verbatimPrefix. A known key keeps stringify's text, which its validation reports.
func rawValue(key string, v any) string {
	if !structured(v) || isKeybindingKey(key) || movedKeys[key] != "" ||
		slices.ContainsFunc(staticFields, func(f Field) bool { return f.Key == key }) {
		return stringify(v)
	}
	return verbatimPrefix + inlineTOML(v)
}

// structured reports whether v is more than a scalar other than a date or time, or a
// list of such scalars.
func structured(v any) bool {
	switch v := v.(type) {
	case []any:
		return slices.ContainsFunc(v, structured)
	case string, int64, bool, float64:
		return false
	}
	return true
}

// inlineTOML writes a decoded value as TOML on one line: tables inline, keys sorted.
func inlineTOML(v any) string {
	switch v := v.(type) {
	case string:
		return tomlString(v)
	case float64:
		switch {
		case math.IsNaN(v):
			return "nan"
		case math.IsInf(v, 1):
			return "inf"
		case math.IsInf(v, -1):
			return "-inf"
		}
		f := strconv.FormatFloat(v, 'g', -1, 64)
		if !strings.ContainsAny(f, ".e") {
			f += ".0"
		}
		return f
	case time.Time:
		// The decoder marks TOML's local date-times, dates and times by location name.
		switch v.Location().String() {
		case "datetime-local":
			return v.Format("2006-01-02T15:04:05.999999999")
		case "date-local":
			return v.Format(time.DateOnly)
		case "time-local":
			return v.Format("15:04:05.999999999")
		}
		return v.Format(time.RFC3339Nano)
	case []any:
		parts := make([]string, len(v))
		for i, x := range v {
			parts[i] = inlineTOML(x)
		}
		return "[" + strings.Join(parts, ", ") + "]"
	case []map[string]any:
		parts := make([]string, len(v))
		for i, x := range v {
			parts[i] = inlineTOML(x)
		}
		return "[" + strings.Join(parts, ", ") + "]"
	case map[string]any:
		parts := make([]string, 0, len(v))
		for _, k := range slices.Sorted(maps.Keys(v)) {
			parts = append(parts, tomlKey(k)+" = "+inlineTOML(v[k]))
		}
		return "{" + strings.Join(parts, ", ") + "}"
	}
	return stringify(v)
}

func stringify(v any) string {
	switch v := v.(type) {
	case string:
		return v
	case int64:
		return strconv.FormatInt(v, 10)
	case bool:
		return strconv.FormatBool(v)
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	case []any:
		// A list (plugins.registries = ["a", "b"]) reads as "a, b".
		parts := make([]string, len(v))
		for i, x := range v {
			parts[i] = stringify(x)
		}
		return strings.Join(parts, ", ")
	default:
		return fmt.Sprint(v)
	}
}

const fileHeader = `# code-foundry settings.
#
# Edit here or in the app (Settings, cmd+,). Changes made here while the app runs are
# picked up immediately. Commented-out lines show defaults. Settings marked
# "applies after a daemon restart" are read when the daemon starts.
#
# Saving from the app rewrites this file: comments you add are not kept. Values the app
# cannot use (unknown keys, values that fail validation) are kept, under a "# Ignored:"
# line that says why, until you fix or remove them.
`

// unitWords spells a field's Unit out for the file's comments, which have no input to
// show it in (" seconds" in "Range 60 to 86400 seconds.").
var unitWords = map[string]string{"s": " seconds", "pt": " points", "%": " percent", "tokens": " tokens", "h": " hours"}

// render produces the file for values (resolved.fileValues: the accepted values,
// canonical, and the raw text of keys with issues), keyed by settings key. Every static
// field is listed with its description; unset ones are commented out at their default.
// Keybinding overrides are listed under [keybindings]. A key with an issue is written
// as it was, under a "# Ignored: <why>" line; unknown keys follow their table's
// fields, unknown tables come last, and keys outside any table come first.
func render(values map[string]string, issues []Issue) []byte {
	why := map[string][]string{}
	for _, is := range issues {
		why[is.Key] = append(why[is.Key], is.Message)
	}
	ignored := func(b *bytes.Buffer, key string) {
		if msgs := why[key]; len(msgs) > 0 {
			writeComment(b, "Ignored: "+strings.Join(msgs, "; ")+".")
		}
	}
	known := map[string]bool{}
	for _, f := range staticFields {
		known[f.Key] = true
	}
	groups := map[string]bool{}
	for _, g := range Groups {
		groups[g.ID] = true
	}
	// Keys that are not static fields or keybindings, by table ("" for none).
	extra := map[string][]string{}
	for _, k := range slices.Sorted(maps.Keys(values)) {
		if known[k] || isKeybindingKey(k) {
			continue
		}
		g, _, _ := strings.Cut(k, ".")
		if g == k {
			g = ""
		}
		extra[g] = append(extra[g], k)
	}
	writeExtra := func(b *bytes.Buffer, group string) {
		for _, k := range extra[group] {
			b.WriteString("\n")
			ignored(b, k)
			name := k
			if group != "" {
				name = strings.TrimPrefix(k, group+".")
			}
			fmt.Fprintf(b, "%s = %s\n", tomlKey(name), encodeLiteral(values[k]))
		}
	}

	var b bytes.Buffer
	b.WriteString(fileHeader)
	writeExtra(&b, "")
	for _, g := range Groups {
		fmt.Fprintf(&b, "\n[%s]\n", g.ID)
		if g.ID == GroupKeybindings {
			writeComment(&b, g.Description)
			b.WriteString(`# "thread.new" = "cmd+shift+n"` + "\n")
			for _, k := range slices.Sorted(maps.Keys(values)) {
				if isKeybindingKey(k) {
					ignored(&b, k)
					fmt.Fprintf(&b, "%s = %s\n", tomlString(strings.TrimPrefix(k, keybindingKeyPrefix)), tomlString(values[k]))
				}
			}
			continue
		}
		for _, f := range staticFields {
			if f.Group != g.ID {
				continue
			}
			b.WriteString("\n")
			desc := f.Title + ". " + f.Description
			if len(f.Enum) > 0 {
				desc += " One of: " + enumList(f.Enum) + "."
			}
			for i, d := range f.EnumDescriptions {
				desc += " " + f.Enum[i] + ": " + d
			}
			if f.DependsOnValue != "" {
				desc += " Used when " + f.DependsOn + " is " + f.DependsOnValue + "."
			}
			if f.Type == Int {
				desc += fmt.Sprintf(" Range %d to %d%s.", f.Min, f.Max, unitWords[f.Unit])
			}
			if f.Restart {
				desc += " Applies after a daemon restart."
			}
			writeComment(&b, desc)
			if v, ok := values[f.Key]; ok {
				ignored(&b, f.Key)
				fmt.Fprintf(&b, "%s = %s\n", f.Name(), encodeValue(f, v))
			} else {
				fmt.Fprintf(&b, "# %s = %s\n", f.Name(), encodeValue(f, f.Default))
			}
		}
		writeExtra(&b, g.ID)
	}
	for _, g := range slices.Sorted(maps.Keys(extra)) {
		if g == "" || groups[g] {
			continue
		}
		fmt.Fprintf(&b, "\n[%s]\n", tomlKey(g))
		writeExtra(&b, g)
	}
	return b.Bytes()
}

// encodeLiteral writes a raw value of an unknown key: TOML text as it is, a bare
// integer or boolean when that reads back as the same string, else a string. (The raw
// values are strings, so either way the file reads back as it was.)
func encodeLiteral(v string) string {
	if text, ok := strings.CutPrefix(v, verbatimPrefix); ok {
		return text
	}
	if n, err := strconv.ParseInt(v, 10, 64); err == nil && strconv.FormatInt(n, 10) == v {
		return v
	}
	if v == "true" || v == "false" {
		return v
	}
	return tomlString(v)
}

// tomlKey is k as a TOML key: bare when it can be, else quoted.
func tomlKey(k string) string {
	if k != "" && strings.Trim(k, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-") == "" {
		return k
	}
	return tomlString(k)
}

func encodeValue(f Field, v string) string {
	switch f.Type {
	case Int:
		if _, err := strconv.Atoi(v); err == nil {
			return v
		}
	case Bool:
		if v == "true" || v == "false" {
			return v
		}
	}
	return tomlString(v)
}

// writeComment writes text as "# " lines wrapped at about 88 columns.
func writeComment(b *bytes.Buffer, text string) {
	line := "#"
	for _, w := range strings.Fields(text) {
		if len(line)+1+len(w) > 88 && line != "#" {
			b.WriteString(line + "\n")
			line = "#"
		}
		line += " " + w
	}
	b.WriteString(line + "\n")
}

// tomlString quotes s as a TOML basic string.
func tomlString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for i, w := 0, 0; i < len(s); i += w {
		r, width := utf8.DecodeRuneInString(s[i:])
		w = width
		switch {
		case r == '"':
			b.WriteString(`\"`)
		case r == '\\':
			b.WriteString(`\\`)
		case r == '\n':
			b.WriteString(`\n`)
		case r == '\t':
			b.WriteString(`\t`)
		case r == '\r':
			b.WriteString(`\r`)
		case r < 0x20 || r == 0x7f || r == utf8.RuneError && width == 1:
			fmt.Fprintf(&b, `\u%04X`, r)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}

// writeAtomic writes data to path through a temp file in the same directory and a
// rename, so readers (and the watcher) never see a partial file. A symlink at path
// (settings.toml kept in a dotfiles repo) is followed: its target is replaced, the link
// stays. An existing file keeps its permissions; a new one gets 0600.
func writeAtomic(path string, data []byte) error {
	target := resolveLink(path)
	mode := os.FileMode(0o600)
	if fi, err := os.Stat(target); err == nil {
		mode = fi.Mode().Perm()
	}
	f, err := os.CreateTemp(filepath.Dir(target), "."+filepath.Base(target)+".*")
	if err != nil {
		return fmt.Errorf("settings: write %s: %w", path, err)
	}
	tmp := f.Name()
	defer func() { _ = os.Remove(tmp) }() // no-op after a successful rename
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		return fmt.Errorf("settings: write %s: %w", path, err)
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return fmt.Errorf("settings: sync %s: %w", path, err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("settings: write %s: %w", path, err)
	}
	if err := os.Chmod(tmp, mode); err != nil {
		return fmt.Errorf("settings: chmod %s: %w", path, err)
	}
	if err := os.Rename(tmp, target); err != nil {
		return fmt.Errorf("settings: replace %s: %w", path, err)
	}
	return nil
}

// maxLinks bounds resolveLink on a symlink loop.
const maxLinks = 40

// resolveLink follows path while it is a symlink and returns the file it ends at (which
// need not exist: a dangling link resolves to where it points). Symlinked directories on
// the way are left as they are; a rename works through them.
func resolveLink(path string) string {
	p := path
	for range maxLinks {
		fi, err := os.Lstat(p)
		if err != nil || fi.Mode()&os.ModeSymlink == 0 {
			return p
		}
		t, err := os.Readlink(p)
		if err != nil {
			return p
		}
		if !filepath.IsAbs(t) {
			t = filepath.Join(filepath.Dir(p), t)
		}
		p = t
	}
	return path
}
