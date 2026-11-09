package plugin_test

import (
	"errors"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/store/plugin"
	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// A sortable column's header acts as a sort (docs/notes/plugin-table.md): the host shapes
// it like a tab, naming the table as the node and asking for the direction the client
// sends, or without one the sorted column's other direction, else the column's first; it
// drops any form values. A table row with an action clicks; an unsortable column and the
// table itself do not act. The surf panel's table ptable has pt-num (descending first),
// pt-name (ascending first) and pt-age (not sortable).
func TestTableSortActs(t *testing.T) {
	e := newSurfEnv(t, nil)
	w := e.watch("panel", s1)
	w.view("first view", contains("count 0"))
	waitOpen(t, e, w.key)

	if _, err := e.act(w.key, plugin.ActRequest{Key: "pt-num"}); err != nil {
		t.Fatal(err)
	}
	w.view("the first sort, its first direction", contains(`got sort:sort key=pt-num value=desc node=\"ptable\" values=null`))
	// The view now sorts by pt-num descending: the next click asks for ascending, and a
	// value from the client wins; values are dropped.
	if _, err := e.act(w.key, plugin.ActRequest{Key: "pt-num", Values: map[string]any{"name": "Ada"}}); err != nil {
		t.Fatal(err)
	}
	w.view("the other direction", contains(`got sort:sort key=pt-num value=asc node=\"ptable\" values=null`))
	if _, err := e.act(w.key, plugin.ActRequest{Key: "pt-name", Action: "sort", Value: new("desc")}); err != nil {
		t.Fatal(err)
	}
	w.view("the client's direction", contains(`got sort:sort key=pt-name value=desc`))
	if _, err := e.act(w.key, plugin.ActRequest{Key: "pt-num", Value: new("")}); err != nil {
		t.Fatal(err)
	}
	w.view("another column, its first direction", contains(`got sort:sort key=pt-num value=desc`))

	for _, c := range []struct {
		name string
		req  plugin.ActRequest
		want string
	}{
		{"a direction that is not one", plugin.ActRequest{Key: "pt-num", Value: new("up")}, `a sort's value is asc or desc, not "up"`},
		{"an unsortable column", plugin.ActRequest{Key: "pt-age"}, `no acting element "pt-age"`},
		{"the table itself", plugin.ActRequest{Key: "ptable"}, `no acting element "ptable"`},
		{"a row without an action", plugin.ActRequest{Key: "ptr2"}, `no acting element "ptr2"`},
		{"a sort as a click", plugin.ActRequest{Key: "pt-num", Action: "click"}, `element "pt-num"'s action is "sort", not "click"`},
		{"a sort by its action alone", plugin.ActRequest{Action: "sort"}, `no element acts "sort"`},
	} {
		if _, err := e.act(w.key, c.req); !errors.Is(err, plugin.ErrInvalidArgument) || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: %v, want %q", c.name, err, c.want)
		}
	}

	els := map[string]plugin.SurfaceElement{}
	for _, el := range e.m.SurfaceElements(w.key, 0) {
		els[el.Key] = el
	}
	if el := els["pt-name"]; el.Kind != pluginsdk.ActSort || el.Action != "sort" || el.Node != "ptable" || el.Label != "Name" {
		t.Errorf("pt-name: %+v", el)
	}
	if el := els["ptr1"]; el.Kind != pluginsdk.ActClick || el.Action != "open-row" || el.Label != "#1" {
		t.Errorf("ptr1: %+v", el)
	}
}
