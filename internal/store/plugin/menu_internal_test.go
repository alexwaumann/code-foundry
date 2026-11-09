package plugin

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// The host indexes a menu's items as it does buttons (docs/notes/plugin-menu.md): a row's,
// a master-detail row's, the header's and a menu button's items (a submenu's too) act as
// clicks with their own event and data, or as the host's commands, URLs and copies; a
// submenu, a separator and a menu button are not acting elements. A command in a menu
// item is held to the plugin's permissions like a button's.
func TestMenusIndexed(t *testing.T) {
	raw := `{"header": {"title": "Jira", "menu": {"items": [{"key": "h-refresh", "label": "Refresh", "action": {"event": "refresh"}}]}},
	  "toolbar": [{"key": "tb", "actions": {"buttons": [{"key": "tb-rebuild", "label": "Rebuild", "menu": {"items": [
	    {"key": "tb-r1", "label": "Rebuild", "action": {"event": "rebuild", "data": "1287"}}]}}]}}],
	  "nodes": [{"key": "l", "list": {"rows": [{"key": "CF-407", "title": "Plugin menus",
	    "actions": [{"key": "CF-407-start", "label": "Start", "action": {"event": "start", "data": "CF-407"}}],
	    "menu": {"items": [{"key": "CF-407-send", "label": "Send", "action": {"command": {"name": "thread.send", "args": {"text": "x"}}}},
	      {"separator": true},
	      {"key": "CF-407-move", "label": "Move to", "submenu": [
	        {"key": "CF-407-todo", "label": "To do", "group": "status", "action": {"event": "move", "data": "todo"}},
	        {"key": "CF-407-done", "label": "Done", "group": "status", "checked": true, "action": {"event": "move", "data": "done"}}]},
	      {"key": "CF-407-open", "label": "Open in Jira", "action": {"openUrl": "https://jira.example.com/CF-407"}},
	      {"key": "CF-407-copy", "label": "Copy key", "action": {"copy": "CF-407"}, "disabled": true}]}}]}},
	    {"key": "md", "masterDetail": {"list": {"rows": [{"key": "r1", "title": "Run 1", "menu": {"items": [{"key": "r1-log", "label": "Open log", "action": {"event": "log", "data": "1"}}]}}]}, "detail": []}}]}`
	v, canon, errs := validateView(json.RawMessage(raw), "p", everyPerms)
	if len(errs) > 0 {
		t.Fatal(errs)
	}
	if !strings.Contains(string(canon), `"checked":true`) || !strings.Contains(string(canon), `{"separator":true}`) {
		t.Fatalf("canonical form: %s", canon)
	}
	idx := buildIndex(v)
	for key, want := range map[string][3]string{ // kind, action name, data
		"h-refresh":    {pluginsdk.ActClick, "refresh", ""},
		"tb-r1":        {pluginsdk.ActClick, "rebuild", "1287"},
		"CF-407-start": {pluginsdk.ActClick, "start", "CF-407"},
		"CF-407-send":  {"command", "thread.send", ""},
		"CF-407-todo":  {pluginsdk.ActClick, "move", "todo"},
		"CF-407-done":  {pluginsdk.ActClick, "move", "done"},
		"CF-407-open":  {"open_url", "https://jira.example.com/CF-407", ""},
		"CF-407-copy":  {"copy", "copy", ""},
		"r1-log":       {pluginsdk.ActClick, "log", "1"},
		"r1":           {pluginsdk.ActSelect, "select", ""},
	} {
		el, ok := idx.elements[key]
		if !ok || el.kind != want[0] || el.actionName() != want[1] || (el.action != nil && el.action.Data != want[2]) {
			t.Errorf("%s: %+v (found %v), want %v", key, el, ok, want)
		}
	}
	for _, key := range []string{"tb-rebuild", "CF-407-move", "CF-407", "l", "md"} {
		if _, ok := idx.elements[key]; ok {
			t.Errorf("%s is indexed as an acting element", key)
		}
	}
	// Two items with one event are told apart by key.
	if _, err := idx.find("", "move"); err == nil || !strings.Contains(err.Error(), "CF-407-todo, CF-407-done") {
		t.Errorf("find by action: %v", err)
	}
	for _, tt := range []struct{ name, view, want string }{
		{"a foreign command in a row's menu", strings.Replace(raw, `"thread.send"`, `"project.remove"`, 1), `CF-407-send: command "project.remove" is neither`},
		{"a foreign command in a submenu", strings.Replace(raw, `"action": {"event": "move", "data": "todo"}`, `"action": {"command": {"name": "project.remove"}}`, 1), `CF-407-todo: command "project.remove" is neither`},
		{"a menu button in the header", strings.Replace(raw, `"title": "Jira",`, `"title": "Jira", "actions": [{"key": "hb", "label": "More", "icon": "ellipsis", "iconOnly": true, "menu": {"items": [{"key": "hb1", "label": "A", "action": {"event": "a"}}]}}],`, 1), "header.actions[0].menu: these buttons do not open menus"},
		{"two checked", strings.Replace(raw, `"group": "status", "action"`, `"group": "status", "checked": true, "action"`, 1), `group "status" already has a checked item`},
	} {
		if _, _, errs := validateView(json.RawMessage(tt.view), "p", everyPerms); !strings.Contains(strings.Join(errs, "\n"), tt.want) {
			t.Errorf("%s: %v, want %q", tt.name, errs, tt.want)
		}
	}
}
