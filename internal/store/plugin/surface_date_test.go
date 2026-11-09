package plugin

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

// A date field's submit and change carry "" or an ISO date within its bounds; anything
// else is refused before it reaches the plugin.
func TestDateFieldValues(t *testing.T) {
	v, _, errs := validateView(json.RawMessage(`{"nodes": [{"key": "f", "form": {"fields": [
		{"key": "d", "name": "due", "input": {"kind": "date", "min": "2026-11-01", "max": "2026-11-30"}, "change": {"event": "due"}},
		{"key": "o", "name": "open", "input": {"kind": "date"}}],
		"submit": {"key": "s", "label": "Save", "action": {"event": "save"}}}}]}`), "p", everyPerms)
	if len(errs) > 0 {
		t.Fatal(errs)
	}
	idx := buildIndex(v)
	tests := []struct {
		name, key string
		value     string // a change's value; "" sends values only
		in        map[string]any
		want      string
	}{
		{"submit a day", "s", "", map[string]any{"due": "2026-11-14", "open": "1999-12-31"}, "map[due:2026-11-14 open:1999-12-31]"},
		{"submit none", "s", "", map[string]any{"due": ""}, "map[due:]"},
		{"on the bounds", "s", "", map[string]any{"due": "2026-11-01", "open": "2026-11-30"}, "map[due:2026-11-01 open:2026-11-30]"},
		{"not a date", "s", "", map[string]any{"due": "tomorrow"}, `"tomorrow" is not an ISO date`},
		{"not a day", "s", "", map[string]any{"open": "2026-02-30"}, "is not an ISO date"},
		{"a time", "s", "", map[string]any{"open": "2026-11-14T00:00:00Z"}, "is not an ISO date"},
		{"not a string", "s", "", map[string]any{"due": 20261114.0}, "want a string"},
		{"before min", "s", "", map[string]any{"due": "2026-10-31"}, "2026-10-31 is before 2026-11-01"},
		{"after max", "s", "", map[string]any{"due": "2026-12-01"}, "2026-12-01 is after 2026-11-30"},
		{"change", "d", "2026-11-20", nil, "map[due:2026-11-20]"},
		{"change out of range", "d", "2027-01-01", nil, "is after 2026-11-30"},
		{"change cleared", "d", "", map[string]any{"due": ""}, "map[due:]"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			el := idx.elements[tt.key]
			out, _, err := idx.values(el, tt.in)
			if err == nil && tt.value != "" {
				out, err = idx.withChange(el, tt.value, out)
			}
			got := fmt.Sprint(out)
			if err != nil {
				got = err.Error()
			}
			if !strings.Contains(got, tt.want) {
				t.Errorf("values = %s, want %s", got, tt.want)
			}
		})
	}
}
