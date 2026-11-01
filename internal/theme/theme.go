// Package theme is the daemon's view of the GUI's colour themes: the curated catalog
// (ids, names, schemes, the default of each scheme, and each theme's file), enough to
// validate and list the appearance.theme_dark and appearance.theme_light settings, print
// a theme and copy one. catalog.json is generated with the GUI's own catalog by
// gui/frontend/themes/convert.ts (`bun run themes`) and committed; its drift test covers
// this copy too. Never edit it by hand. The user's own themes are files in the themes
// directory (store/usertheme, file.go); a Set is both (set.go). The colours are resolved
// only in the GUI (docs/notes/theme-slots-1-engine.md); the daemon keeps the GUI's
// published slots for the frame stylesheet (frame.go, docs/notes/theme-css-route.md) and
// derives none.
package theme

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"slices"
	"strconv"
	"strings"
)

// Schemes. Every theme has exactly one.
const (
	SchemeDark  = "dark"
	SchemeLight = "light"
)

// Theme is one theme's entry: a curated one, or (User) one of the user's.
type Theme struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Scheme string `json:"scheme"`
	// Pair is the sibling of the other scheme (GitHub Dark and Light), or "".
	Pair string `json:"pair,omitempty"`
	// From is the theme a user theme was copied from, or "" (File.From).
	From string `json:"from,omitempty"`
	// CreatedBy is the thread that wrote a user theme, or "" (File.CreatedBy).
	CreatedBy string `json:"created_by,omitempty"`
	// User is true for a theme in the themes directory, false for a curated one.
	User bool `json:"user,omitempty"`
}

type catalogFile struct {
	Defaults map[string]string `json:"defaults"`
	Themes   []File            `json:"themes"`
}

type parsedCatalog struct {
	Defaults map[string]string
	Themes   []Theme
	Files    map[string]File
}

//go:embed catalog.json
var catalogJSON []byte

var catalog = mustParse(catalogJSON)

// mustParse reads the embedded catalog. A malformed file is a build defect that
// TestCatalog catches, so it yields an empty catalog rather than a panic.
func mustParse(data []byte) parsedCatalog {
	var c catalogFile
	if err := json.Unmarshal(data, &c); err != nil {
		return parsedCatalog{}
	}
	out := parsedCatalog{Defaults: c.Defaults, Files: make(map[string]File, len(c.Themes))}
	for _, f := range c.Themes {
		out.Themes = append(out.Themes, Theme{ID: f.ID, Name: f.Name, Scheme: f.Scheme, Pair: f.Pair})
		out.Files[f.ID] = f
	}
	return out
}

// Curated returns a curated theme's file (a copy), as the GUI's catalog has it.
func Curated(id string) (File, bool) {
	f, ok := catalog.Files[id]
	if !ok {
		return File{}, false
	}
	return f.Clone(), true
}

// IsCurated reports whether id is a curated theme's id: a user theme may not use it.
func IsCurated(id string) bool {
	_, ok := catalog.Files[id]
	return ok
}

// Themes returns every theme: dark ones first, the default (GitHub) first in each scheme.
func Themes() []Theme { return slices.Clone(catalog.Themes) }

// For returns the themes of one scheme, in catalog order.
func For(scheme string) []Theme {
	var out []Theme
	for _, t := range catalog.Themes {
		if t.Scheme == scheme {
			out = append(out, t)
		}
	}
	return out
}

// IDs returns the ids of one scheme's themes, in catalog order.
func IDs(scheme string) []string {
	ts := For(scheme)
	out := make([]string, len(ts))
	for i, t := range ts {
		out[i] = t.ID
	}
	return out
}

// Names returns the names of one scheme's themes, parallel to IDs.
func Names(scheme string) []string {
	ts := For(scheme)
	out := make([]string, len(ts))
	for i, t := range ts {
		out[i] = t.Name
	}
	return out
}

// ByID returns the theme with id.
func ByID(id string) (Theme, bool) {
	i := slices.IndexFunc(catalog.Themes, func(t Theme) bool { return t.ID == id })
	if i < 0 {
		return Theme{}, false
	}
	return catalog.Themes[i], true
}

// Default is the scheme's default theme id (github-dark, github-light), or ""
// for an unknown scheme.
func Default(scheme string) string { return catalog.Defaults[scheme] }

// Valid reports whether id is a theme of scheme.
func Valid(id, scheme string) bool { return Check(id, scheme) == nil }

// Check explains why id cannot fill scheme's slot: an unknown id, or a theme of the
// other scheme. Nil when it can.
func Check(id, scheme string) error {
	t, ok := ByID(id)
	switch {
	case scheme != SchemeDark && scheme != SchemeLight:
		return fmt.Errorf("unknown scheme %q", scheme)
	case !ok:
		return fmt.Errorf("unknown theme %q; %s themes are %s", id, scheme, quoted(IDs(scheme)))
	case t.Scheme != scheme:
		return fmt.Errorf("%s (%q) is a %s theme; the %s theme must be one of %s", t.Name, id, t.Scheme, scheme, quoted(IDs(scheme)))
	}
	return nil
}

// maxQuoted is how many ids a message lists; with hundreds of user themes the rest are
// counted (theme list prints them all).
const maxQuoted = 20

func quoted(ids []string) string {
	q := make([]string, 0, min(len(ids), maxQuoted))
	for _, id := range ids[:min(len(ids), maxQuoted)] {
		q = append(q, strconv.Quote(id))
	}
	s := strings.Join(q, ", ")
	if n := len(ids) - maxQuoted; n > 0 {
		s += fmt.Sprintf(" and %d more (theme list prints them all)", n)
	}
	return s
}
