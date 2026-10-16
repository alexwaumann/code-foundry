// Package theme is the daemon's view of the GUI's colour themes: ids, names, schemes and
// the default of each scheme, enough to validate and list the appearance.theme_dark and
// appearance.theme_light settings. catalog.json is generated with the GUI's own catalog by
// gui/frontend/themes/convert.ts (`pnpm run themes`) and committed; its drift test covers
// this copy too. Never edit it by hand. The colours live only in the GUI
// (docs/notes/theme-engine-2-engine.md).
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

// Theme is one catalog entry.
type Theme struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Scheme string `json:"scheme"`
	// Pair is the sibling of the other scheme (GitHub Dark and Light), or "".
	Pair string `json:"pair,omitempty"`
}

type catalogFile struct {
	Defaults map[string]string `json:"defaults"`
	Themes   []Theme           `json:"themes"`
}

//go:embed catalog.json
var catalogJSON []byte

var catalog = mustParse(catalogJSON)

// mustParse reads the embedded catalog. A malformed file is a build defect that
// TestCatalog catches, so it yields an empty catalog rather than a panic.
func mustParse(data []byte) catalogFile {
	var c catalogFile
	if err := json.Unmarshal(data, &c); err != nil {
		return catalogFile{}
	}
	return c
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

func quoted(ids []string) string {
	q := make([]string, len(ids))
	for i, id := range ids {
		q[i] = strconv.Quote(id)
	}
	return strings.Join(q, ", ")
}
