package settings

import (
	"bytes"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/BurntSushi/toml"
)

// File format: TOML, one table per group, keys without the group prefix:
//
//	[sessions]
//	default_model = "opus"
//
//	[keybindings]
//	"session.new" = "cmd+shift+n"
//
// TOML over JSON: the file is meant to be edited by hand, and TOML has comments (the
// rendered file documents every field and shows its default) and no trailing-comma or
// quoting traps. BurntSushi/toml was already in the module graph (via Wails).

// decode parses a settings file into raw string-encoded values keyed by settings key.
// Values are stringified leniently (14 and "14" both work for an int); type errors are
// found by Field.parse. Under [keybindings], unquoted dotted keys (session.new = ...)
// parse as nested tables and are flattened back.
func decode(data []byte) (map[string]string, error) {
	var doc map[string]any
	if _, err := toml.Decode(string(data), &doc); err != nil {
		return nil, err
	}
	raw := map[string]string{}
	for group, v := range doc {
		tbl, ok := v.(map[string]any)
		if !ok {
			raw[group] = stringify(v)
			continue
		}
		flatten(raw, group, tbl, group == GroupKeybindings)
	}
	return raw, nil
}

func flatten(raw map[string]string, prefix string, tbl map[string]any, nested bool) {
	for k, v := range tbl {
		key := prefix + "." + k
		if sub, ok := v.(map[string]any); ok && nested {
			flatten(raw, key, sub, true)
			continue
		}
		raw[key] = stringify(v)
	}
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
# Saving from the app rewrites this file: comments you add and unknown keys are not kept.
`

// render produces the file for the accepted values (canonical, keyed by settings key).
// Every static field is listed with its description; unset ones are commented out at
// their default. Keybinding overrides are listed under [keybindings].
func render(accepted map[string]string) []byte {
	var b bytes.Buffer
	b.WriteString(fileHeader)
	for _, g := range Groups {
		fmt.Fprintf(&b, "\n[%s]\n", g.ID)
		if g.ID == GroupKeybindings {
			writeComment(&b, g.Description)
			b.WriteString(`# "session.new" = "cmd+shift+n"` + "\n")
			keys := slices.Sorted(maps.Keys(accepted))
			for _, k := range keys {
				if isKeybindingKey(k) {
					fmt.Fprintf(&b, "%s = %s\n", tomlString(strings.TrimPrefix(k, keybindingKeyPrefix)), tomlString(accepted[k]))
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
			if f.Type == Int {
				desc += fmt.Sprintf(" Range %d to %d.", f.Min, f.Max)
			}
			if f.Restart {
				desc += " Applies after a daemon restart."
			}
			writeComment(&b, desc)
			if v, ok := accepted[f.Key]; ok {
				fmt.Fprintf(&b, "%s = %s\n", f.Name(), encodeValue(f, v))
			} else {
				fmt.Fprintf(&b, "# %s = %s\n", f.Name(), encodeValue(f, f.Default))
			}
		}
	}
	return b.Bytes()
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
// rename, so readers (and the watcher) never see a partial file.
func writeAtomic(path string, data []byte) error {
	f, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
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
	if err := os.Chmod(tmp, 0o600); err != nil {
		return fmt.Errorf("settings: chmod %s: %w", path, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("settings: replace %s: %w", path, err)
	}
	return nil
}
