package plugin

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// The host walks a master-detail's detail and a tabs node's children like a container's
// (docs/notes/plugins-layout-4-master-detail.md): their lists are [] in the canonical
// form, a row without an action is a select element and a node's tab a tab element (both
// naming their node), a row with an action and an empty detail's button act as clicks,
// and a log in a tab in a detail takes appends.
func TestMasterDetailAndTabsWalked(t *testing.T) {
	raw := `{"tabs": {"items": [{"key": "vt", "label": "View"}], "active": "vt"}, "nodes": [
	  {"key": "md", "masterDetail": {"selected": "r1",
	    "list": {"rows": [{"key": "r1", "title": "Run 1", "actions": [{"key": "r1-x", "label": "Cancel", "action": {"event": "cancel"}}]},
	      {"key": "r2", "title": "Run 2", "action": {"event": "open", "data": "2"}},
	      {"key": "r3", "title": "Run 3", "action": {"openUrl": "https://x.example"}}]},
	    "emptyDetail": {"title": "None", "actions": [{"key": "ed", "label": "New", "action": {"event": "new"}}]},
	    "detail": [{"key": "tb", "tabs": {"active": "t1", "items": [{"key": "t1", "label": "Log"}, {"key": "t2", "label": "Info"}], "children": [
	      {"key": "p", "pane": {"height": 200, "children": [{"key": "lg", "log": {"text": "one\n"}}]}}]}}]}},
	  {"key": "bare-md", "masterDetail": {"list": {}}},
	  {"key": "bare-tabs", "tabs": {"active": "b1", "items": [{"key": "b1", "label": "A"}, {"key": "b2", "label": "B"}]}}]}`
	v, canon, errs := validateView(json.RawMessage(raw), "p", everyPerms)
	if len(errs) > 0 {
		t.Fatal(errs)
	}
	for _, want := range []string{`{"key":"bare-md","masterDetail":{"list":{"rows":[]},"detail":[]}}`, `"active":"b1","children":[]}`} {
		if path := nullList(canon); path != "" || !strings.Contains(string(canon), want) {
			t.Fatalf("canonical form (null list %q) lacks %s: %s", path, want, canon)
		}
	}
	idx := buildIndex(v)
	for key, want := range map[string][3]string{
		"vt": {pluginsdk.ActTab, "tab", ""}, "r1": {pluginsdk.ActSelect, "select", "md"}, "r1-x": {pluginsdk.ActClick, "cancel", ""},
		"r2": {pluginsdk.ActClick, "open", ""}, "r3": {"open_url", "https://x.example", ""}, "ed": {pluginsdk.ActClick, "new", ""},
		"t1": {pluginsdk.ActTab, "tab", "tb"}, "t2": {pluginsdk.ActTab, "tab", "tb"}, "b2": {pluginsdk.ActTab, "tab", "bare-tabs"},
	} {
		el, ok := idx.elements[key]
		if !ok || el.kind != want[0] || el.actionName() != want[1] || el.node != want[2] {
			t.Errorf("%s: %+v, want %v", key, el, want)
		}
	}
	if _, err := idx.find("", "tab"); err == nil {
		t.Error("a tab found by its action alone")
	}
	in := newFuzzInstance()
	if ver, _ := in.accept(v, canon, time.Unix(0, 0)); ver != 1 {
		t.Fatalf("version %d", ver)
	}
	if _, err := in.appendLog(pluginsdk.ViewAppendParams{Instance: in.key, Key: "lg", Text: "two\n"}); err != nil {
		t.Fatalf("append to a log in a tab in a detail: %v", err)
	}
	if out := string(in.renderLocked()); !strings.Contains(out, `"text":"one\ntwo\n"`) {
		t.Errorf("render after the append: %s", out)
	}
	for _, tt := range []struct{ name, view, want string }{
		{"selected not a row", strings.Replace(raw, `"selected": "r1"`, `"selected": "r9"`, 1), `nodes[0].masterDetail.selected: "r9" is not a row of the list`},
		{"one node tab", strings.Replace(raw, `, {"key": "b2", "label": "B"}`, ``, 1), "nodes[2].tabs.items: 1 tabs, want 2 to 8"},
		{"a node tab keyed like a view tab", strings.Replace(raw, `{"key": "b2", "label": "B"}`, `{"key": "vt", "label": "B"}`, 1), `"vt" is already used by tabs.items[0]`},
		{"a foreign command in the empty detail", strings.Replace(raw, `{"event": "new"}`, `{"command": {"name": "project.remove"}}`, 1), `ed: command "project.remove" is neither`},
	} {
		if _, _, errs := validateView(json.RawMessage(tt.view), "p", everyPerms); !strings.Contains(strings.Join(errs, "\n"), tt.want) {
			t.Errorf("%s: %v, want %q", tt.name, errs, tt.want)
		}
	}
}
