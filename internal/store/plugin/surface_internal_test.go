package plugin

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

// every is a view with every v1 node kind and value type (the hello demo's overview,
// form and log tabs in one, trimmed).
const every = `{
  "header": {"title": "T", "icon": "sparkles", "pill": {"label": "ok", "tone": "ok"}, "subline": "s",
    "actions": [{"key": "h1", "label": "Refresh", "icon": "refresh-cw", "iconOnly": true, "action": {"event": "refresh"}}]},
  "tabs": {"items": [{"key": "ta", "label": "A"}, {"key": "tb", "label": "B", "badge": {"label": "1"}}], "active": "ta"},
  "nodes": [
    {"key": "t", "text": {"content": {"spans": [{"text": "x", "strong": true}, {"time": {"at": "2026-10-18T00:00:00Z", "style": "elapsed"}}, {"duration": {"ms": 1000}}, {"text": "l", "url": "https://x.example"}]}}},
    {"key": "m", "markdown": {"source": "**b**"}},
    {"key": "p", "pairs": {"items": [{"key": "p1", "label": "L", "value": "v", "copyable": true}]}},
    {"key": "l", "list": {"rows": [{"key": "r1", "title": "R", "glyph": {"status": "running"}, "action": {"event": "open", "data": "1"},
      "actions": [{"key": "r1b", "label": "Cancel", "action": {"event": "cancel"}}]}]}},
    {"key": "c", "chips": {"chips": [{"key": "c1", "label": "Build", "status": "ok", "action": {"event": "stage", "data": "build"}}]}},
    {"key": "g", "log": {"text": "line\n", "rows": 8}},
    {"key": "g2", "log": {"lines": [{"text": "w", "tone": "attention"}]}},
    {"key": "a", "actions": {"buttons": [
      {"key": "b1", "label": "Go", "style": "attention", "action": {"event": "go"}},
      {"key": "b2", "label": "Greet", "action": {"command": {"name": "plugin.p.greet"}}},
      {"key": "b3", "label": "Send", "action": {"command": {"name": "thread.send", "args": {"text": "x"}}}},
      {"key": "b4", "label": "Docs", "style": "link", "action": {"openUrl": "https://x.example"}},
      {"key": "b5", "label": "Copy", "action": {"copy": "x"}}]}},
    {"key": "pr", "progress": {"value": 0.5, "label": "half"}},
    {"key": "n", "notice": {"tone": "error", "title": "N", "detail": "d"}},
    {"key": "e", "empty": {"title": "E", "glyph": {"icon": "package"}}},
    {"key": "s", "section": {"title": "S", "card": true, "children": [{"key": "s1", "section": {"title": "S1", "stale": true, "children": [{"key": "s2", "text": {"content": "deep"}}]}}]}},
    {"key": "f", "form": {"fields": [
      {"key": "f1", "name": "name", "label": "Name", "input": {"placeholder": "Ada"}},
      {"key": "f2", "name": "token", "label": "Token", "input": {"kind": "secret", "store": "token"}},
      {"key": "f3", "name": "project", "select": {"optionsSource": "projects"}, "change": {"event": "picked"}},
      {"key": "f4", "name": "tags", "select": {"multiple": true, "options": [{"key": "o1", "value": "a", "label": "A"}]}},
      {"key": "f5", "label": "Notify", "fieldset": {"fields": [{"key": "f6", "name": "fail", "toggle": {"value": true}}]}}],
      "submit": {"key": "fs", "label": "Save", "action": {"event": "save"}},
      "secondary": [{"key": "fr", "label": "Reset", "action": {"event": "reset"}}]}},
    {"key": "th", "thread": {"threadId": "s-000000000000", "readOnly": true}},
    {"key": "te", "terminal": {"terminalId": "t-000000000000", "rows": 8}}
  ]
}`

var everyPerms = pluginsdk.Permissions{Commands: []string{"thread.send"}, Secrets: true}

func TestValidateViewAcceptsEveryKind(t *testing.T) {
	v, canon, errs := validateView(json.RawMessage(every), "p", everyPerms)
	if len(errs) > 0 {
		t.Fatalf("errors: %v", errs)
	}
	if len(v.Nodes) != 15 || !json.Valid(canon) {
		t.Fatalf("nodes %d, canon %s", len(v.Nodes), canon)
	}
	idx := buildIndex(v)
	kinds := map[string]string{}
	for _, k := range idx.order {
		kinds[k] = idx.elements[k].kind
	}
	want := map[string]string{"h1": "click", "ta": "tab", "tb": "tab", "r1": "click", "r1b": "click", "c1": "click", "b1": "click",
		"b2": "command", "b3": "command", "b4": "open_url", "b5": "copy", "f3": "change", "fs": "submit", "fr": "click"}
	if fmt.Sprint(kinds) != fmt.Sprint(want) {
		t.Errorf("elements\n got %v\nwant %v", kinds, want)
	}
	if el := idx.elements["fs"]; el.form != "f" || el.actionName() != "save" {
		t.Errorf("submit %+v", el)
	}
}

func TestValidateViewRefuses(t *testing.T) {
	mod := func(old, new string) string {
		if !strings.Contains(every, old) {
			t.Fatalf("fixture lacks %q", old)
		}
		return strings.Replace(every, old, new, 1)
	}
	tests := []struct {
		name, view string
		perms      *pluginsdk.Permissions
		want       string
	}{
		{"not an object", `[1]`, nil, "must be a JSON object"},
		{"not json", `{"nodes": [`, nil, "view:"},
		{"too big", `{"nodes": [], "x": "` + strings.Repeat("a", maxRawView) + `"}`, nil, "at most"},
		{"unknown node kind", `{"nodes": [{"key": "x", "table": {}}]}`, nil, "exactly one kind"},
		{"two kinds", `{"nodes": [{"key": "x", "text": {"content": "a"}, "markdown": {"source": "b"}}]}`, nil, "exactly one kind"},
		{"missing key", `{"nodes": [{"text": {"content": "a"}}]}`, nil, "must match"},
		{"duplicate key", mod(`"key": "m"`, `"key": "t"`), nil, "already used"},
		{"filled button", mod(`"style": "attention"`, `"style": "primary"`), nil, "no filled buttons"},
		{"javascript url", mod(`"openUrl": "https://x.example"`, `"openUrl": "javascript:alert(1)"`), nil, "not an http or https URL"},
		{"secret with a value", mod(`"kind": "secret", "store": "token"`, `"kind": "secret", "value": "hunter2"`), nil, "never carries its value"},
		{"foreign command", mod(`"name": "thread.send"`, `"name": "project.remove"`), nil, `command "project.remove" is neither`},
		{"management verb", mod(`"name": "thread.send"`, `"name": "plugin.enable"`), &pluginsdk.Permissions{Commands: []string{"**"}, Secrets: true}, "is neither"},
		{"store without secrets", every, &pluginsdk.Permissions{Commands: []string{"thread.send"}}, "store needs"},
		{"deep", mod(`"children": [{"key": "s2", "text": {"content": "deep"}}]`,
			`"children": [{"key": "s2", "section": {"children": [{"key": "s3", "text": {"content": "x"}}]}}]`), nil, "nested deeper"},
		{"options with a source", mod(`"select": {"optionsSource": "projects"}`, `"select": {"optionsSource": "projects", "options": [{"key": "o9", "value": "v", "label": "L"}]}`), nil, "fills the options"},
		{"bad terminal rows", mod(`"terminalId": "t-000000000000", "rows": 8`, `"terminalId": "t-000000000000", "rows": 99`), nil, "outside 4..60"},
		{"thread without id", mod(`"threadId": "s-000000000000"`, `"threadId": ""`), nil, "threadId: required"},
		{"tab not active", mod(`"active": "ta"`, `"active": "z"`), nil, "not one of the tabs"},
		{"five logs", `{"nodes": [{"key":"1","log":{}},{"key":"2","log":{}},{"key":"3","log":{}},{"key":"4","log":{}},{"key":"5","log":{}}]}`, nil, "5 log nodes"},
		{"too many elements", `{"nodes": [{"key": "l", "list": {"rows": [` + rows(401) + `]}}]}`, nil, "elements, at most 400"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			perms := everyPerms
			if tt.perms != nil {
				perms = *tt.perms
			}
			_, _, errs := validateView(json.RawMessage(tt.view), "p", perms)
			if !strings.Contains(strings.Join(errs, "\n"), tt.want) {
				t.Errorf("errors %v, want one with %q", errs, tt.want)
			}
		})
	}
}

func rows(n int) string {
	out := make([]string, n)
	for i := range out {
		out[i] = fmt.Sprintf(`{"key": "r%d", "title": "x"}`, i)
	}
	return strings.Join(out, ",")
}

// The captured hello demo views (PR 5's renderer and mock daemon fixtures) stay valid.
func TestHelloDemoFixtures(t *testing.T) {
	files, _ := filepath.Glob("testdata/hello-demo/*.json")
	if len(files) < 3 {
		t.Fatalf("fixtures: %v", files)
	}
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		if _, _, errs := validateView(b, "hello", pluginsdk.Permissions{Commands: []string{"thread.send", "pr.checks"}, Secrets: true}); len(errs) > 0 {
			t.Errorf("%s: %v", f, errs)
		}
	}
}

func TestActionValues(t *testing.T) {
	v, _, errs := validateView(json.RawMessage(every), "p", everyPerms)
	if len(errs) > 0 {
		t.Fatal(errs)
	}
	idx := buildIndex(v)
	tests := []struct {
		name, key string
		in        map[string]any
		want      string
		stores    string
	}{
		{"submit", "fs", map[string]any{"name": "Ada", "token": "s3", "tags": []any{"a"}, "fail": "false"}, "map[fail:false name:Ada tags:[a] token:s3]", "map[token:token]"},
		{"submit unknown field", "fs", map[string]any{"nope": "x"}, "not a field", ""},
		{"toggle type", "fs", map[string]any{"fail": 3.0}, "want a boolean", ""},
		{"multi type", "fs", map[string]any{"tags": "a,b"}, "map[tags:[a b]]", "map[]"},
		{"change drops secrets", "f3", map[string]any{"token": "s3"}, "not a field", ""},
		{"change", "f3", map[string]any{"project": "p1"}, "map[project:p1]", "map[]"},
		{"click outside a form sees every field", "b1", map[string]any{"name": "x"}, "map[name:x]", "map[]"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			out, stores, err := idx.values(idx.elements[tt.key], tt.in)
			got := fmt.Sprint(out)
			if err != nil {
				got = err.Error()
			}
			if !strings.Contains(got, tt.want) || (err == nil && fmt.Sprint(stores) != tt.stores) {
				t.Errorf("values = %s, stores %v; want %s, %s", got, stores, tt.want, tt.stores)
			}
		})
	}
}

func TestFindElement(t *testing.T) {
	v, _, _ := validateView(json.RawMessage(every), "p", everyPerms)
	idx := buildIndex(v)
	tests := []struct{ key, action, want string }{
		{"b1", "", "b1"},
		{"b1", "go", "b1"},
		{"b1", "stop", "not \"stop\""},
		{"", "save", "fs"},
		{"", "nope", "no element acts"},
		{"zz", "", "no acting element"},
		{"", "", "name the element"},
	}
	for _, tt := range tests {
		el, err := idx.find(tt.key, tt.action)
		got := el.key
		if err != nil {
			got = err.Error()
		}
		if !strings.Contains(got, tt.want) {
			t.Errorf("find(%q, %q) = %s, want %s", tt.key, tt.action, got, tt.want)
		}
	}
	dup, _, _ := validateView(json.RawMessage(`{"nodes": [{"key": "a", "actions": {"buttons": [
		{"key": "x", "label": "X", "action": {"event": "go"}}, {"key": "y", "label": "Y", "action": {"event": "go"}}]}}]}`), "p", everyPerms)
	if _, err := buildIndex(dup).find("", "go"); err == nil || !strings.Contains(err.Error(), "pass a key") {
		t.Errorf("ambiguous: %v", err)
	}
}

func TestLogBuf(t *testing.T) {
	b := &logBuf{}
	b.append("a\nb", nil)
	b.append("c\n", nil)
	if b.text != "a\nbc\n" {
		t.Errorf("text %q", b.text)
	}
	b.append("", []pluginsdk.AppendLine{{Text: "d"}})
	if b.text != "a\nbc\nd\n" {
		t.Errorf("lines into text %q", b.text)
	}
	l := &logBuf{linesMode: true}
	l.append("x\ny\n", nil)
	l.append("", []pluginsdk.AppendLine{{Text: "z", Tone: "error"}})
	if len(l.lines) != 3 || l.lines[2].Tone != ui.ToneError || l.lines[1].Text != "y" {
		t.Errorf("lines %+v", l.lines)
	}
	big := &logBuf{}
	for range logKeepLines + 10 {
		big.append("0123456789\n", nil)
	}
	if n := strings.Count(big.text, "\n"); n != logKeepLines || !big.trimmed {
		t.Errorf("kept %d lines, trimmed %v", n, big.trimmed)
	}
	huge := &logBuf{}
	for range 6 {
		huge.append(strings.Repeat("é", 30<<10)+"\n", nil)
	}
	if len(huge.text) > logKeepBytes || !strings.HasPrefix(huge.text, "é") {
		t.Errorf("kept %d bytes", len(huge.text))
	}
	ls := &logBuf{linesMode: true}
	for range logKeepLines + 5 {
		ls.append("", []pluginsdk.AppendLine{{Text: "x"}})
	}
	if len(ls.lines) != logKeepLines || !ls.trimmed {
		t.Errorf("kept %d lines", len(ls.lines))
	}
}
