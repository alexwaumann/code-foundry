package theme

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
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
	// `--sh-*`), `#rrggbb` or `#rrggbbaa`. Each must be one of SlotNames(), the GUI's
	// slots (its parseThemeFile, src/themes/slots.ts, refuses the same names).
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
	f, _, err := parse(data, false)
	return f, err
}

// retiredSlots are slots the app no longer has (docs/notes/theme-slots-3-hardening.md),
// with what to pin instead. ParseFile refuses them with that hint; ParseStored drops them.
var retiredSlots = map[string]string{
	"--cf-icon":               "icons take their label's colour, or pin --cf-icon-muted",
	"--cf-sidebar-row-active": "pin --cf-sidebar-row-selected",
}

// ParseStored is ParseFile for a file already in the themes directory, forgiving what an
// older release accepted (docs/notes/theme-fuzz-daemon.md), so an upgrade does not turn a
// working theme into an issue: a pin of a name that is not a slot (a retired slot, a
// misspelling, a shadcn name) is dropped, and a scheme its surface contradicts (a light
// surface on a "dark" theme) is read as the surface's. Each forgiveness is a note ("dropped
// the pin --cf-primary: not a slot"). A mid-grey surface suits neither scheme and is still
// refused. Writes go through ParseFile, so the file is put right the next time it is saved.
func ParseStored(data []byte) (File, []string, error) {
	return parse(data, true)
}

// utf8BOM is what some editors put before the JSON; it is not part of it.
var utf8BOM = []byte("\xef\xbb\xbf")

func parse(data []byte, stored bool) (File, []string, error) {
	if len(data) > MaxFileBytes {
		return File{}, nil, fmt.Errorf("%w: more than %d KiB", ErrInvalid, MaxFileBytes>>10)
	}
	data = bytes.TrimPrefix(data, utf8BOM)
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	var f File
	if err := dec.Decode(&f); err != nil {
		return File{}, nil, fmt.Errorf("%w: %s", ErrInvalid, jsonProblem(err))
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return File{}, nil, fmt.Errorf("%w: more than one JSON value", ErrInvalid)
	}
	f.normalise()
	var notes []string
	if stored {
		notes = f.forgive()
	}
	if err := f.Validate(); err != nil {
		return File{}, nil, err
	}
	return f, notes, nil
}

// forgive puts right what ParseStored forgives, and says what it did.
func (f *File) forgive() []string {
	var notes []string
	for _, k := range slices.Sorted(maps.Keys(f.Overrides)) {
		if _, retired := retiredSlots[k]; retired {
			notes = append(notes, fmt.Sprintf("dropped the pin %s: the app no longer has that slot", k))
		} else if !IsSlot(k) {
			notes = append(notes, fmt.Sprintf("dropped the pin %s: not a slot", k))
		} else {
			continue
		}
		delete(f.Overrides, k)
	}
	if len(f.Overrides) == 0 {
		f.Overrides = nil
	}
	if l, ok := oklabLightness(f.Base.Surface); ok && SchemeProblem(f.Scheme, f.Base.Surface) != "" {
		switch {
		case f.Scheme == SchemeDark && l >= SchemeLightMinL:
			f.Scheme = SchemeLight
		case f.Scheme == SchemeLight && l <= SchemeDarkMaxL:
			f.Scheme = SchemeDark
		default:
			return notes
		}
		notes = append(notes, fmt.Sprintf("read as a %s theme: its surface %s is %s", f.Scheme, f.Base.Surface, f.Scheme))
	}
	return notes
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
			return fmt.Sprintf("%s: want a %s, got %s", typ.Field, typ.Type, withArticle(typ.Value))
		}
		return fmt.Sprintf("want a JSON object, got %s", withArticle(typ.Value))
	case errors.Is(err, io.ErrUnexpectedEOF):
		return "not JSON (it ends too soon)"
	case errors.Is(err, io.EOF):
		return "empty file"
	}
	return strings.TrimPrefix(err.Error(), "json: ")
}

// withArticle is "an array", "a string".
func withArticle(noun string) string {
	if noun != "" && strings.ContainsRune("aeiou", rune(noun[0])) {
		return "an " + noun
	}
	return "a " + noun
}

func (f *File) normalise() {
	// The GUI's parseThemeFile trims the ids too.
	for _, p := range []*string{&f.ID, &f.Name, &f.Pair, &f.From, &f.CreatedBy} {
		*p = strings.TrimSpace(*p)
	}
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

// Validate checks what the GUI's parseThemeFile (src/themes/slots.ts) checks, so a file
// one accepts the other does too: an id, a name, a scheme its surface can carry
// (SchemeProblem), the nine base colours and the terminal foreground as #rrggbb, 16 ANSI
// colours, and overrides of slots (SlotNames, the GUI's list) with #rrggbb or #rrggbbaa
// values. It does not check that an id exists anywhere. Errors wrap ErrInvalid.
func (f File) Validate() error {
	bad := func(format string, a ...any) error {
		return fmt.Errorf("%w: "+format, append([]any{ErrInvalid}, a...)...)
	}
	switch {
	case f.ID == "":
		return bad("no id")
	case !ValidID(f.ID):
		return bad("id %q: use lowercase letters, digits and dashes (at most %d)", f.ID, MaxIDLen)
	case f.Name == "":
		return bad("no name")
	case utf8.RuneCountInString(f.Name) > MaxNameLen:
		return bad("name: at most %d characters", MaxNameLen)
	case strings.ContainsFunc(f.Name, invisible):
		return bad("name: no control or format characters (a zero-width space, a direction override)")
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
	if p := SchemeProblem(f.Scheme, b.Surface); p != "" {
		return bad("%s", p)
	}
	for _, k := range slices.Sorted(maps.Keys(f.Overrides)) {
		v := f.Overrides[k]
		if !overridePattern.MatchString(k) {
			return bad("overrides: %q is not a slot name (--cf-…, --terminal-…, --syn-… or --sh-…)", k)
		}
		if hint, ok := retiredSlots[k]; ok {
			return bad("overrides: %q was removed from the app; %s", k, hint)
		}
		if !IsSlot(k) {
			return bad("overrides: %q is not a slot (the Slots section of THEMES.md, the help skill's reference/themes.md, lists them; theme show github-dark prints a file to start from)", k)
		}
		if !anyHexPattern.MatchString(v) {
			return bad("overrides[%q]: %q is not #rrggbb or #rrggbbaa", k, v)
		}
	}
	return nil
}

// invisible: a control character, or a format character (U+200B, U+202E…) that hides
// itself or reorders the rest of a line.
func invisible(r rune) bool { return unicode.IsControl(r) || unicode.Is(unicode.Cf, r) }

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

// SameColours reports whether a and b paint the same: scheme, base and overrides. A save
// that changes only the name, pair, from or source repaints nothing.
func SameColours(a, b File) bool {
	paint := func(f File) string {
		return string(File{Scheme: f.Scheme, Base: f.Base, Overrides: f.Overrides}.Marshal())
	}
	return paint(a) == paint(b)
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

// Version identifies the file's contents: the first 16 bytes of the SHA-256 of Marshal,
// in hex. ThemeService sends it with each user theme and the GUI keys its contrast report
// on it (Reports), so theme save can wait for the report on the file it just wrote.
func (f File) Version() string {
	sum := sha256.Sum256(f.Marshal())
	return hex.EncodeToString(sum[:16])
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
