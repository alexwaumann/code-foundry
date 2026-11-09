package plugin

import (
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

// searchElement is a picker's search (ui.Select.Search) as an acting element: its own key,
// its event, and the field (and form) it searches for. A search carries its form's values
// like a change does.
func searchElement(f *ui.Field, form string) element {
	s := f.Select.Search
	return element{key: s.Key, kind: pluginsdk.ActSearch, label: f.Label, form: form, action: &ui.Action{Event: s.Event}, field: f.Name}
}

// searchQuery is a search act's query, trimmed: at least ui.SearchMinChars characters
// (the GUI sends none shorter) and at most ui.MaxSearchQuery.
func searchQuery(v *string) (string, error) {
	if v == nil {
		return "", fmt.Errorf("%w: a search carries its query as the value", ErrInvalidArgument)
	}
	q := strings.TrimSpace(*v)
	switch n := utf8.RuneCountInString(q); {
	case n < ui.SearchMinChars:
		return "", fmt.Errorf("%w: a search's query is at least %d characters", ErrInvalidArgument, ui.SearchMinChars)
	case n > ui.MaxSearchQuery:
		return "", fmt.Errorf("%w: a search's query is at most %d characters", ErrInvalidArgument, ui.MaxSearchQuery)
	}
	return q, nil
}
