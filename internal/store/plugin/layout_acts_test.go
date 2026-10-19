package plugin_test

import (
	"errors"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/store/plugin"
)

// Select and node tab acts that do not name an acting element, or name one of another
// kind, are refused before they reach the plugin; stale versions are refused once gone
// and otherwise reach the plugin with the version (and node) acted on. The surf panel
// has a master-detail pmd (rows pr1, pr2) whose detail is a tabs node ptabs (pt1, pt2).
func TestLayoutActEdges(t *testing.T) {
	e := newSurfEnv(t, nil)
	w := e.watch("panel", s1)
	w.view("first view", contains("count 0"))
	for _, c := range []struct {
		name string
		req  plugin.ActRequest
		want string
	}{
		{"the master-detail itself", plugin.ActRequest{Key: "pmd"}, `no acting element "pmd"`},
		{"the tabs node itself", plugin.ActRequest{Key: "ptabs", Action: "tab"}, `no acting element "ptabs"`},
		{"a row as a tab", plugin.ActRequest{Key: "pr1", Action: "tab"}, `element "pr1"'s action is "select", not "tab"`},
		{"a node tab as a select", plugin.ActRequest{Key: "pt1", Action: "select"}, `element "pt1"'s action is "tab", not "select"`},
		{"a missing row", plugin.ActRequest{Key: "pr9", Action: "select"}, `no acting element "pr9"`},
		{"a version never sent", plugin.ActRequest{Key: "pr1", Version: 99}, "version 99 of"},
	} {
		if _, err := e.act(w.key, c.req); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: %v, want %q", c.name, err, c.want)
		}
	}
	// A select from an older (kept) version reaches the plugin with that version.
	if _, err := e.act(w.key, plugin.ActRequest{Key: "inc"}); err != nil {
		t.Fatal(err)
	}
	w.view("after inc", contains("count 1"))
	if _, err := e.act(w.key, plugin.ActRequest{Key: "pr1", Version: 1}); err != nil {
		t.Fatal(err)
	}
	w.view("the stale select", contains(`node=\"pmd\" values=null version=1`))
	// Values on a select: the docs list none for a select or a tab act (Action, Key,
	// Node), and the GUI sends none.
	_, err := e.act(w.key, plugin.ActRequest{Key: "pr2", Values: map[string]any{"name": "Ada"}})
	switch {
	case errors.Is(err, plugin.ErrInvalidArgument):
		// refused: fine
	case err != nil:
		t.Fatal(err)
	default:
		v := w.view("the select with values", contains("key=pr2"))
		if strings.Contains(string(v.JSON), `values={\"name\":\"Ada\"}`) {
			t.Log("KNOWN (sdk.md, values on select/tab acts): a select act carries a form's values to the plugin")
		}
	}
}
