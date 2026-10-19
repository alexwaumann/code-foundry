package plugin

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

// The host walks the toolbar and footer like the body (ui.View.NodeLists) and containers
// like sections: the strips' buttons act and are held to the plugin's permissions, their
// lists and a container's are [] in the canonical form, and the invalid-view notice keeps
// them.
func TestStripsAndContainerWalked(t *testing.T) {
	raw := `{
	  "toolbar": [{"key": "q", "form": {"fields": [{"key": "qf", "name": "q", "input": {}}],
	    "submit": {"key": "qs", "label": "Filter", "action": {"event": "filter"}}}}, {"key": "st", "chips": {}}],
	  "nodes": [{"key": "page", "container": {"width": "wide", "children": [
	    {"key": "inner", "actions": {"buttons": [{"key": "in-b", "label": "In", "action": {"event": "in"}}]}}]}},
	    {"key": "empty-ct", "container": {}}],
	  "footer": [{"key": "bar", "actions": {"align": "end", "buttons": [
	    {"key": "send", "label": "Send", "action": {"command": {"name": "thread.send", "args": {"text": "hi"}}}}]}}]}`
	v, canon, errs := validateView(json.RawMessage(raw), "p", everyPerms)
	if len(errs) > 0 {
		t.Fatal(errs)
	}
	if path := nullList(canon); path != "" || !strings.Contains(string(canon), `{"key":"st","chips":{"chips":[]}}`) || !strings.Contains(string(canon), `{"key":"empty-ct","container":{"children":[]}}`) {
		t.Fatalf("canonical form (null list %q): %s", path, canon)
	}
	idx := buildIndex(v)
	for key, want := range map[string]string{"qs": pluginsdk.ActSubmit, "send": "command", "in-b": pluginsdk.ActClick} {
		if el, ok := idx.elements[key]; !ok || el.kind != want {
			t.Errorf("%s: %+v, want kind %s", key, el, want)
		}
	}
	if el := idx.elements["qs"]; el.form != "q" {
		t.Errorf("the toolbar's submit belongs to form %q", el.form)
	}
	if fs := idx.fields; len(fs) != 1 || fs[0].form != "q" || fs[0].name != "q" {
		t.Errorf("fields %+v", fs)
	}

	// A footer command the plugin may not run, and a toolbar secret without the secrets
	// permission, are refused like the body's.
	for _, tt := range []struct{ name, view, want string }{
		{"foreign command in the footer", strings.Replace(raw, `"thread.send"`, `"project.remove"`, 1), `send: command "project.remove" is neither plugin.p.* nor`},
		{"store without secrets in the toolbar", strings.Replace(raw, `"name": "q", "input": {}`, `"name": "q", "input": {"kind": "secret", "store": "tok"}`, 1), "qf: a secret input's store needs"},
		{"a list in the toolbar", strings.Replace(raw, `{"key": "st", "chips": {}}`, `{"key": "st", "list": {"rows": []}}`, 1), "toolbar[1]: a list node cannot be in the toolbar"},
		{"seven in the footer", strings.Replace(raw, `"footer": [`, `"footer": [`+sevenTexts()+",", 1), "footer: 8 nodes, at most 6"},
	} {
		perms := everyPerms
		if strings.Contains(tt.name, "secrets") {
			perms = pluginsdk.Permissions{Commands: []string{"thread.send"}}
		}
		if _, _, errs := validateView(json.RawMessage(tt.view), "p", perms); !strings.Contains(strings.Join(errs, "\n"), tt.want) {
			t.Errorf("%s: %v, want %q", tt.name, errs, tt.want)
		}
	}

	// An invalid view after this one: the notice goes above the body and the strips stay.
	in := newFuzzInstance()
	if ver, _ := in.accept(v, canon, time.Unix(0, 0)); ver != 1 {
		t.Fatalf("version %d", ver)
	}
	in.reject("P", []string{"nodes[0]: bad"}, true)
	var shown ui.View
	if err := json.Unmarshal(in.renderLocked(), &shown); err != nil {
		t.Fatal(err)
	}
	if len(shown.Toolbar) != 2 || len(shown.Footer) != 1 || shown.Nodes[0].Notice == nil || shown.Nodes[0].Key != "cf-invalid-view" {
		t.Errorf("after reject: toolbar %d, footer %d, first %+v", len(shown.Toolbar), len(shown.Footer), shown.Nodes[0])
	}
	if _, ok := in.index[in.version].elements["send"]; !ok {
		t.Error("the footer's button does not act under the notice")
	}
}

func sevenTexts() string {
	out := make([]string, 7)
	for i := range out {
		out[i] = `{"key": "t` + string(rune('a'+i)) + `", "text": {"content": "x"}}`
	}
	return strings.Join(out, ",")
}
