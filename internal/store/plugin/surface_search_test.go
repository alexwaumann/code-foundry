package plugin_test

import (
	"errors"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/store/plugin"
	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// A picker's search reaches the plugin as a search act: its key and event, the field's
// name, the query trimmed, and its form's values; a query out of bounds is refused.
func TestSurfaceSearchActs(t *testing.T) {
	e := newSurfEnv(t, nil)
	w := e.watch("panel", s1)
	w.view("first view", contains("count 0"))
	q := "  ale "
	if _, err := e.act(w.key, plugin.ActRequest{Key: "who-search", Value: &q, Values: map[string]any{"note": "n1", "who": []any{"me"}}}); err != nil {
		t.Fatal(err)
	}
	w.view("after the search", contains(`got search:people key=who-search value=ale node=\"\" values={\"note\":\"n1\",\"who\":[\"me\"]}`))
	// By the event alone, as the CLI may.
	q = "kim"
	if _, err := e.act(w.key, plugin.ActRequest{Action: "people", Value: &q}); err != nil {
		t.Fatal(err)
	}
	w.view("by its event", contains(`got search:people key=who-search value=kim`))
	short, long := " a ", strings.Repeat("x", 201)
	tests := []struct {
		name  string
		value *string
		msg   string
	}{
		{"no query", nil, "carries its query as the value"},
		{"one character", &short, "at least 2 characters"},
		{"too long", &long, "at most 200 characters"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := e.act(w.key, plugin.ActRequest{Key: "who-search", Value: tt.value}); !errors.Is(err, plugin.ErrInvalidArgument) || !strings.Contains(err.Error(), tt.msg) {
				t.Errorf("err = %v, want %q", err, tt.msg)
			}
		})
	}
	els := map[string]plugin.SurfaceElement{}
	for _, el := range e.m.SurfaceElements(w.key, 0) {
		els[el.Key] = el
	}
	if el := els["who-search"]; el.Kind != pluginsdk.ActSearch || el.Action != "people" || el.Form != "pick" || el.Label != "Who" {
		t.Errorf("who-search element %+v", el)
	}
}
