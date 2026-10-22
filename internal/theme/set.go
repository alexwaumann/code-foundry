package theme

import (
	"cmp"
	"fmt"
	"maps"
	"slices"
	"strings"
)

// Set is the themes a slot can name: the user's themes (the themes directory, read by
// store/usertheme) and the curated catalog. The zero Set is the catalog alone. A Set
// also remembers the user themes that went away (deleted, or a file that no longer
// reads) with the theme each was copied from, so a setting that names one can fall back
// to that theme rather than the default (docs/notes/user-themes.md).
type Set struct {
	user []Theme
	// gone maps a user theme id that is no longer valid to its From ("" for none).
	gone map[string]string
}

// NewSet returns the catalog plus user (a user theme with a curated id is dropped: the
// store never lets one in). gone is the user themes that went away, id -> from; an id
// that is in user is not gone. User themes come first in each scheme, by name.
func NewSet(user []Theme, gone map[string]string) Set {
	u := make([]Theme, 0, len(user))
	for _, t := range user {
		if IsCurated(t.ID) {
			continue
		}
		t.User = true
		u = append(u, t)
	}
	slices.SortFunc(u, func(a, b Theme) int {
		return cmp.Or(cmp.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name)), cmp.Compare(a.ID, b.ID))
	})
	g := maps.Clone(gone)
	for _, t := range u {
		delete(g, t.ID)
	}
	return Set{user: u, gone: g}
}

// User returns the user themes, by name.
func (s Set) User() []Theme { return slices.Clone(s.user) }

// Gone returns the ids of user themes that went away, with each one's From.
func (s Set) Gone() map[string]string { return maps.Clone(s.gone) }

// Themes returns every theme: the user's first, then the catalog.
func (s Set) Themes() []Theme { return append(slices.Clone(s.user), Themes()...) }

// For returns the themes of one scheme: the user's (by name), then the catalog's.
func (s Set) For(scheme string) []Theme {
	var out []Theme
	for _, t := range s.user {
		if t.Scheme == scheme {
			out = append(out, t)
		}
	}
	return append(out, For(scheme)...)
}

// IDs returns the ids of one scheme's themes, in For's order.
func (s Set) IDs(scheme string) []string {
	ts := s.For(scheme)
	out := make([]string, len(ts))
	for i, t := range ts {
		out[i] = t.ID
	}
	return out
}

// Names returns the names of one scheme's themes, parallel to IDs.
func (s Set) Names(scheme string) []string {
	ts := s.For(scheme)
	out := make([]string, len(ts))
	for i, t := range ts {
		out[i] = t.Name
	}
	return out
}

// ByID returns the theme with id, the user's or the catalog's.
func (s Set) ByID(id string) (Theme, bool) {
	if i := slices.IndexFunc(s.user, func(t Theme) bool { return t.ID == id }); i >= 0 {
		return s.user[i], true
	}
	return ByID(id)
}

// Valid reports whether id is a theme of scheme in the set.
func (s Set) Valid(id, scheme string) bool { return s.Check(id, scheme) == nil }

// Check explains why id cannot fill scheme's slot: an unknown id, a user theme that is
// gone, or a theme of the other scheme. Nil when it can.
func (s Set) Check(id, scheme string) error {
	if scheme != SchemeDark && scheme != SchemeLight {
		return fmt.Errorf("unknown scheme %q", scheme)
	}
	t, ok := s.ByID(id)
	switch {
	case !ok:
		if _, gone := s.gone[id]; gone {
			return fmt.Errorf("theme %q is gone: its file in the themes directory was deleted or no longer reads", id)
		}
		return fmt.Errorf("unknown theme %q; %s themes are %s", id, scheme, quoted(s.IDs(scheme)))
	case t.Scheme != scheme:
		return fmt.Errorf("%s (%q) is a %s theme; the %s theme must be one of %s", t.Name, id, t.Scheme, scheme, quoted(s.IDs(scheme)))
	}
	return nil
}

// Without is the set once the user theme id is gone (as its delete leaves it): what a
// slot naming it would fall back to before the file is removed.
func (s Set) Without(id string) Set {
	t, ok := s.ByID(id)
	if !ok || !t.User {
		return s
	}
	user := slices.DeleteFunc(slices.Clone(s.user), func(u Theme) bool { return u.ID == id })
	gone := maps.Clone(s.gone)
	if gone == nil {
		gone = map[string]string{}
	}
	gone[id] = t.From
	return NewSet(user, gone)
}

// Fallback is the theme a slot naming the gone user theme id shows instead: the theme
// it was copied from, or that one's, and so on, the first that is a theme of scheme in
// the set. "" when id is not gone or no theme it came from is left (the slot takes the
// default).
func (s Set) Fallback(id, scheme string) string {
	seen := map[string]bool{}
	for cur := id; !seen[cur]; {
		seen[cur] = true
		from, gone := s.gone[cur]
		if !gone || from == "" {
			return ""
		}
		if s.Valid(from, scheme) {
			return from
		}
		cur = from
	}
	return ""
}
