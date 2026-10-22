package theme

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"regexp"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"
)

// File is one theme as a file: a curated catalog entry or a user theme in the themes
// directory (docs/notes/user-themes.md). The GUI resolves its slots from Base and
// Overrides with the rules in src/themes/slots.ts; the daemon only checks the shape and
// stores it. The JSON names are the GUI's (`cursorText` is camelCase there too).
type File struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Scheme string `json:"scheme"`
	// Pair is the sibling of the other scheme, or "": a hint the Themes page offers
	// after an Apply.
	Pair string `json:"pair,omitempty"`
	// From is the theme this one was copied from (curated or user), or "". A setting
	// naming this theme falls back to it when this one is gone.
	From string `json:"from,omitempty"`
	// CreatedBy is the thread that wrote it, or "" (the user, or unknown).
	CreatedBy string `json:"created_by,omitempty"`
	// Source is where the colours came from; optional in a user theme.
	Source string `json:"source,omitempty"`
	Base   Base   `json:"base"`
	// Overrides are final values for single slots (`--cf-*`, `--terminal-*`, `--syn-*`,
	// `--sh-*`), `#rrggbb` or `#rrggbbaa`. The daemon cannot resolve slots: a name that
	// is shaped like one but is not a slot is kept, and the GUI ignores it.
	Overrides map[string]string `json:"overrides,omitempty"`
}

// Base is what a theme must supply (ThemeBase in src/themes/slots.ts). Every colour is
// `#rrggbb`.
type Base struct {
	Canvas    string   `json:"canvas"`
	Surface   string   `json:"surface"`
	Text      string   `json:"text"`
	Accent    string   `json:"accent"`
	Success   string   `json:"success"`
	Warning   string   `json:"warning"`
	Error     string   `json:"error"`
	Info      string   `json:"info"`
	Highlight string   `json:"highlight"`
	Link      string   `json:"link,omitempty"`
	Terminal  Terminal `json:"terminal"`
}

// Terminal is the terminal palette: the foreground, optional cursor, cursor text and
// selection, and ANSI 0-15.
type Terminal struct {
	Foreground string   `json:"foreground"`
	Cursor     string   `json:"cursor,omitempty"`
	CursorText string   `json:"cursorText,omitempty"`
	Selection  string   `json:"selection,omitempty"`
	ANSI       []string `json:"ansi"`
}

// Limits on a theme file.
const (
	// MaxFileBytes bounds a theme file (a full one with every slot pinned is ~6 KiB).
	MaxFileBytes = 64 << 10
	// MaxIDLen and MaxNameLen bound the id and the name (characters).
	MaxIDLen   = 64
	MaxNameLen = 80
	// MaxOverrides bounds the pinned slots (there are fewer than 100 slots).
	MaxOverrides = 256
	maxSourceLen = 500
	maxThreadLen = 64
)

// ErrInvalid wraps every problem ParseFile and Validate report.
var ErrInvalid = errors.New("invalid theme")

var (
	idPattern       = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)
	threadPattern   = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
	opaquePattern   = regexp.MustCompile(`^#[0-9a-f]{6}$`)
	anyHexPattern   = regexp.MustCompile(`^#[0-9a-f]{6}(?:[0-9a-f]{2})?$`)
	overridePattern = regexp.MustCompile(`^--(?:cf|terminal|syn|sh)-[a-z0-9]+(?:-[a-z0-9]+)*$`)
)

// ValidID reports whether id is shaped like a theme id: lowercase letters, digits and
// single dashes, at most MaxIDLen.
func ValidID(id string) bool { return len(id) <= MaxIDLen && idPattern.MatchString(id) }

// ParseFile reads a theme file: a JSON object with no unknown fields, then Validate.
// The result is normalised (lowercase hex, trimmed name). Errors wrap ErrInvalid and
// name the first problem ("base.accent: "#12" is not #rrggbb").
func ParseFile(data []byte) (File, error) {
	if len(data) > MaxFileBytes {
		return File{}, fmt.Errorf("%w: more than %d KiB", ErrInvalid, MaxFileBytes>>10)
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	var f File
	if err := dec.Decode(&f); err != nil {
		return File{}, fmt.Errorf("%w: %s", ErrInvalid, jsonProblem(err))
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return File{}, fmt.Errorf("%w: more than one JSON value", ErrInvalid)
	}
	f.normalise()
	if err := f.Validate(); err != nil {
		return File{}, err
	}
	return f, nil
}

// jsonProblem phrases a decode error for a person (or a model) fixing the file.
func jsonProblem(err error) string {
	var syn *json.SyntaxError
	var typ *json.UnmarshalTypeError
	switch {
	case errors.As(err, &syn):
		return fmt.Sprintf("not JSON (%s at byte %d)", syn.Error(), syn.Offset)
	case errors.As(err, &typ):
		if typ.Field != "" {
			return fmt.Sprintf("%s: want a %s, got a %s", typ.Field, typ.Type, typ.Value)
		}
		return fmt.Sprintf("want a JSON object, got a %s", typ.Value)
	case errors.Is(err, io.ErrUnexpectedEOF):
		return "not JSON (it ends too soon)"
	case errors.Is(err, io.EOF):
		return "empty file"
	}
	return strings.TrimPrefix(err.Error(), "json: ")
}

func (f *File) normalise() {
	f.Name = strings.TrimSpace(f.Name)
	f.Source = strings.TrimSpace(f.Source)
	lower := func(s *string) { *s = strings.ToLower(strings.TrimSpace(*s)) }
	b := &f.Base
	for _, p := range []*string{&b.Canvas, &b.Surface, &b.Text, &b.Accent, &b.Success, &b.Warning, &b.Error, &b.Info, &b.Highlight, &b.Link,
		&b.Terminal.Foreground, &b.Terminal.Cursor, &b.Terminal.CursorText, &b.Terminal.Selection} {
		lower(p)
	}
	for i := range b.Terminal.ANSI {
		lower(&b.Terminal.ANSI[i])
	}
	if len(f.Overrides) > 0 {
		out := make(map[string]string, len(f.Overrides))
		for k, v := range f.Overrides {
			out[strings.TrimSpace(k)] = strings.ToLower(strings.TrimSpace(v))
		}
		f.Overrides = out
	}
	if len(f.Overrides) == 0 {
		f.Overrides = nil
	}
}

// Validate checks the shape the GUI needs: an id, a name, a scheme, the nine base
// colours and the terminal foreground as #rrggbb, 16 ANSI colours, and overrides whose
// names look like slots (`--cf-…`, `--terminal-…`, `--syn-…`, `--sh-…`) with #rrggbb or
// #rrggbbaa values. It does not check that an override names a real slot (the GUI owns
// the slot list) or that an id exists anywhere. Errors wrap ErrInvalid.
func (f File) Validate() error {
	bad := func(format string, a ...any) error { return fmt.Errorf("%w: "+format, append([]any{ErrInvalid}, a...)...) }
	switch {
	case f.ID == "":
		return bad("no id")
	case !ValidID(f.ID):
		return bad("id %q: use lowercase letters, digits and dashes (at most %d)", f.ID, MaxIDLen)
	case f.Name == "":
		return bad("no name")
	case utf8.RuneCountInString(f.Name) > MaxNameLen:
		return bad("name: at most %d characters", MaxNameLen)
	case strings.ContainsFunc(f.Name, unicode.IsControl):
		return bad("name: no control characters")
	case f.Scheme != SchemeDark && f.Scheme != SchemeLight:
		return bad("scheme %q: must be dark or light", f.Scheme)
	case f.Pair != "" && !ValidID(f.Pair):
		return bad("pair %q is not a theme id", f.Pair)
	case f.From != "" && !ValidID(f.From):
		return bad("from %q is not a theme id", f.From)
	case f.From == f.ID:
		return bad("from: a theme cannot be copied from itself")
	case f.CreatedBy != "" && (len(f.CreatedBy) > maxThreadLen || !threadPattern.MatchString(f.CreatedBy)):
		return bad("created_by %q is not a thread id", f.CreatedBy)
	case utf8.RuneCountInString(f.Source) > maxSourceLen:
		return bad("source: at most %d characters", maxSourceLen)
	}
	b := f.Base
	colours := []struct{ name, v string }{
		{"canvas", b.Canvas}, {"surface", b.Surface}, {"text", b.Text}, {"accent", b.Accent},
		{"success", b.Success}, {"warning", b.Warning}, {"error", b.Error}, {"info", b.Info}, {"highlight", b.Highlight},
		{"terminal.foreground", b.Terminal.Foreground},
	}
	for _, c := range colours {
		if err := opaque("base."+c.name, c.v, true); err != nil {
			return err
		}
	}
	for _, c := range []struct{ name, v string }{{"link", b.Link}, {"terminal.cursor", b.Terminal.Cursor}, {"terminal.cursorText", b.Terminal.CursorText}, {"terminal.selection", b.Terminal.Selection}} {
		if err := opaque("base."+c.name, c.v, false); err != nil {
			return err
		}
	}
	if len(b.Terminal.ANSI) != 16 {
		return bad("base.terminal.ansi: want 16 colours, got %d", len(b.Terminal.ANSI))
	}
	for i, c := range b.Terminal.ANSI {
		if err := opaque(fmt.Sprintf("base.terminal.ansi[%d]", i), c, true); err != nil {
			return err
		}
	}
	if len(f.Overrides) > MaxOverrides {
		return bad("overrides: at most %d", MaxOverrides)
	}
	for _, k := range slices.Sorted(maps.Keys(f.Overrides)) {
		v := f.Overrides[k]
		if !overridePattern.MatchString(k) {
			return bad("overrides: %q is not a slot name (--cf-…, --terminal-…, --syn-… or --sh-…)", k)
		}
		if !anyHexPattern.MatchString(v) {
			return bad("overrides[%q]: %q is not #rrggbb or #rrggbbaa", k, v)
		}
	}
	return nil
}

func opaque(where, v string, required bool) error {
	if v == "" {
		if required {
			return fmt.Errorf("%w: %s: missing", ErrInvalid, where)
		}
		return nil
	}
	if !opaquePattern.MatchString(v) {
		return fmt.Errorf("%w: %s: %q is not #rrggbb", ErrInvalid, where, v)
	}
	return nil
}

// Pinned is how many slots the file overrides.
func (f File) Pinned() int { return len(f.Overrides) }

// Theme is the file's catalog entry.
func (f File) Theme() Theme {
	return Theme{ID: f.ID, Name: f.Name, Scheme: f.Scheme, Pair: f.Pair, From: f.From, CreatedBy: f.CreatedBy}
}

// Clone is a deep copy (the ANSI slice and the overrides map are not shared).
func (f File) Clone() File {
	f.Base.Terminal.ANSI = append([]string(nil), f.Base.Terminal.ANSI...)
	if f.Overrides != nil {
		f.Overrides = maps.Clone(f.Overrides)
	}
	return f
}

// Marshal is the file as written to disk and printed by theme.show: indented JSON in
// the field order above (overrides sorted by name), with a trailing newline.
func (f File) Marshal() []byte {
	b, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		// Every field is a string, a slice of strings or a map of strings.
		return nil
	}
	return append(b, '\n')
}

// Header is the little of a file a setting's fallback needs, read from a file that does
// not validate: its id, scheme and from, when they are there (store/usertheme).
type Header struct {
	ID     string `json:"id"`
	Scheme string `json:"scheme"`
	From   string `json:"from"`
}

// ReadHeader reads a Header leniently: whatever of the three parses. ok is false when
// the data is not a JSON object.
func ReadHeader(data []byte) (Header, bool) {
	var raw map[string]json.RawMessage
	if json.Unmarshal(data, &raw) != nil {
		return Header{}, false
	}
	var h Header
	str := func(k string) string {
		var s string
		if v, ok := raw[k]; ok && json.Unmarshal(v, &s) == nil {
			return strings.TrimSpace(s)
		}
		return ""
	}
	h.ID, h.Scheme, h.From = str("id"), str("scheme"), str("from")
	return h, true
}
