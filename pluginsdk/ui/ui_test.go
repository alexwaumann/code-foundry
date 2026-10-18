package ui

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// jenkinsFailed is the walkthrough's failed Jenkins view (PRIMITIVES.md §D), as plugins
// write it: short enums, bare strings for inline content.
const jenkinsFailed = `{
  "header": {
    "icon": "workflow", "title": "#4821 Retry token refresh on 401",
    "pill": { "label": "Failed", "tone": "error" },
    "subline": { "spans": [ { "text": "payments-api #482", "mono": true, "url": "https://jenkins.acme/job/payments-api/482/" },
      { "text": " · failed after " }, { "duration": { "ms": 362000 } } ] },
    "actions": [ { "key": "refresh", "label": "Refresh", "icon": "refresh-cw", "iconOnly": true, "action": { "event": "refresh" } } ],
    "tabTitle": "Jenkins #482"
  },
  "tabs": { "items": [ { "key": "tab-runs", "label": "Runs" }, { "key": "tab-log", "label": "Log", "badge": { "label": "1", "tone": "error" } } ], "active": "tab-runs" },
  "nodes": [
    { "key": "stages", "chips": { "chips": [
      { "key": "chip-build", "label": "Build", "status": "ok", "meta": "1m 40s", "action": { "event": "stage", "data": "build" } },
      { "key": "chip-deploy", "label": "Deploy", "status": "failed", "meta": "48s", "selected": true } ] } },
    { "key": "why", "notice": { "tone": "error", "title": "Deploy failed",
      "detail": "Error: UPGRADE FAILED: timed out waiting for the condition (helm, 5m0s)",
      "actions": [ { "key": "send", "label": "Send failure to Claude", "icon": "send", "style": "attention",
        "action": { "command": { "name": "plugin.jenkins.send-failure", "args": { "build": "482", "stage": "deploy" } } } } ] } },
    { "key": "log", "log": { "title": "Deploy · last 200 lines", "truncated": true, "noFollow": true,
      "lines": [ { "text": "helm upgrade" }, { "text": "Error: UPGRADE FAILED", "tone": "error" } ] } },
    { "key": "old", "section": { "title": "Last known", "stale": true, "collapsible": true, "children": [
      { "key": "who", "pairs": { "items": [ { "key": "p-env", "label": "Environment", "value": "Production" } ] } } ] } },
    { "key": "token-form", "form": {
      "fields": [
        { "key": "f-user", "name": "user", "label": "Username", "required": true, "input": { "value": "awaumann", "mono": true } },
        { "key": "f-token", "name": "token", "label": "API token", "input": { "kind": "secret", "store": "jenkins-token", "hasValue": true } },
        { "key": "f-group", "fieldset": { "label": "Notify", "hint": "Pick any", "fields": [
          { "key": "f-mail", "name": "mail", "label": "Mail", "toggle": { "value": true } },
          { "key": "f-proj", "name": "project", "label": "Project", "select": { "optionsSource": "projects" } } ] } } ],
      "submit": { "key": "save", "label": "Save token", "style": "attention", "action": { "event": "save-token" } } } },
    { "key": "run", "terminal": { "terminalId": "t-1", "rows": 12 } },
    { "key": "chat", "thread": { "threadId": "th-1" } }
  ]
}`

func TestWalkthroughRoundTrip(t *testing.T) {
	var v View
	if err := json.Unmarshal([]byte(jenkinsFailed), &v); err != nil {
		t.Fatal(err)
	}
	if err := v.Validate(); err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if got := v.Nodes[0].Chips.Chips[0].Meta.Text; got != "1m 40s" {
		t.Errorf("bare-string inline: %q", got)
	}
	if v.Header.Subline.Spans[2].Duration.Ms != 362000 {
		t.Error("duration span lost")
	}
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var again View
	if err := json.Unmarshal(b, &again); err != nil {
		t.Fatal(err)
	}
	b2, _ := json.Marshal(again)
	if string(b) != string(b2) {
		t.Errorf("not stable:\n%s\n%s", b, b2)
	}
	if !strings.Contains(string(b), `"meta":"1m 40s"`) {
		t.Errorf("plain inline should encode as a string: %s", b)
	}
}

func TestBuilders(t *testing.T) {
	started := time.Date(2026, 10, 18, 9, 0, 0, 0, time.UTC)
	row := NewRow("r1", "Build")
	row.Glyph = StatusGlyph(StatusRunning)
	row.Line2 = Spans(T("since "), At(started, TimeElapsed).WithTone(ToneMuted))
	v := NewView(&Header{Title: "Hello", Pill: NewPill("Running", ToneNeutral),
		Actions: []Button{EventButton("refresh", "Refresh", "refresh").WithIcon("refresh-cw").AsIconOnly()}},
		NewText("intro", Plain("Hi")),
		NewMarkdown("md", "**bold**"),
		NewPairs("facts", NewPair("p1", "Build", Spans(T("#482").AsMono().Link("https://ci.example/482")))),
		NewList("rows", row),
		NewChips("chips", NewChip("c1", "Test", StatusOK)),
		NewLog("log", "line\n"),
		NewActions("acts", CommandButton("send", "Send to Claude", "plugin.hello.send", nil).WithStyle(ButtonAttention),
			URLButton("open", "Open", "https://example.com"), CopyButton("copy", "Copy", "x")),
		NewProgress("prog", "Working", Fraction(0.5)),
		NewNotice("n", ToneAttention, "Heads up", Plain("Body")),
		NewEmpty("e", "Nothing yet", nil),
		NewSection("s", "More", NewText("inner", Plain("x"))),
		NewForm("f", &Button{Key: "go", Label: "Go", Action: EventAction("go", "")},
			TextField("f1", "name", "Name"), SecretField("f2", "token", "Token", "token"),
			SelectField("f3", "env", "Env", Opt("o1", "prod", "Production")), ToggleField("f4", "on", "On", true),
			NewFieldset("f5", "Group", ToggleField("f6", "a", "A", false))),
		NewThread("th", "t-1"),
		NewTerminal("term", "term-1"),
	)
	v.Tabs = NewTabs("a", NewTab("a", "A"), NewTab("b", "B"))
	if err := v.Validate(); err != nil {
		t.Fatalf("Validate: %v", err)
	}
}

func TestValidateRejects(t *testing.T) {
	ok := func() View { return NewView(nil, NewText("t", Plain("x"))) }
	tests := []struct {
		name   string
		mutate func(*View)
		want   string
	}{
		{"duplicate key", func(v *View) { v.Nodes = append(v.Nodes, NewText("t", Plain("y"))) }, "already used"},
		{"bad key", func(v *View) { v.Nodes[0].Key = "has space" }, "must match"},
		{"two kinds", func(v *View) { v.Nodes[0].Markdown = &Markdown{Source: "x"} }, "exactly one kind"},
		{"no kind", func(v *View) { v.Nodes[0].Text = nil }, "exactly one kind"},
		{"primary button", func(v *View) {
			b := EventButton("b", "B", "e")
			b.Style = "primary"
			v.Nodes = append(v.Nodes, NewActions("a", b))
		}, "no filled buttons"},
		{"button without action", func(v *View) { v.Nodes = append(v.Nodes, NewActions("a", Button{Key: "b", Label: "B"})) }, "action: required"},
		{"two actions", func(v *View) {
			v.Nodes = append(v.Nodes, NewActions("a", Button{Key: "b", Label: "B", Action: &Action{Event: "e", Copy: "c"}}))
		}, "exactly one of"},
		{"data without event", func(v *View) {
			v.Nodes = append(v.Nodes, NewActions("a", Button{Key: "b", Label: "B", Action: &Action{Copy: "c", Data: "d"}}))
		}, "only an event"},
		{"event data too big", func(v *View) {
			v.Nodes = append(v.Nodes, NewActions("a", Button{Key: "b", Label: "B", Action: EventAction("e", strings.Repeat("x", MaxEventData+1))}))
		}, "bytes, at most"},
		{"javascript url", func(v *View) { v.Nodes = append(v.Nodes, NewActions("a", URLButton("b", "B", "javascript:alert(1)"))) }, "not an http"},
		{"too many header buttons", func(v *View) {
			v.Header = &Header{Actions: []Button{EventButton("a", "A", "a"), EventButton("b", "B", "b"), EventButton("c", "C", "c")}}
		}, "at most 2"},
		{"too deep", func(v *View) {
			v.Nodes = []Node{NewSection("s1", "", NewSection("s2", "", NewSection("s3", "", NewText("t", Plain("x")))))}
		}, "nested deeper"},
		{"too many logs", func(v *View) {
			for i := range 5 {
				v.Nodes = append(v.Nodes, NewLog("log"+string(rune('a'+i)), "x"))
			}
		}, "log nodes"},
		{"log text and lines", func(v *View) {
			n := NewLog("l", "x")
			n.Log.Lines = []LogLine{{Text: "y"}}
			v.Nodes = append(v.Nodes, n)
		}, "not both"},
		{"secret value", func(v *View) {
			f := SecretField("f", "token", "Token", "")
			f.Input.Value = "leak"
			v.Nodes = append(v.Nodes, NewForm("form", nil, f))
		}, "never carries its value"},
		{"secret through command", func(v *View) {
			b := CommandButton("go", "Go", "plugin.x.save", nil)
			v.Nodes = append(v.Nodes, NewForm("form", &b, SecretField("f", "token", "Token", "")))
		}, "submits through an event"},
		{"secret in fieldset through command", func(v *View) {
			b := CommandButton("go", "Go", "plugin.x.save", nil)
			v.Nodes = append(v.Nodes, NewForm("form", &b, NewFieldset("g", "G", SecretField("f", "token", "Token", ""))))
		}, "submits through an event"},
		{"nested fieldset", func(v *View) {
			v.Nodes = append(v.Nodes, NewForm("form", nil, NewFieldset("g", "G", NewFieldset("h", "H", ToggleField("x", "x", "X", false)))))
		}, "do not nest"},
		{"field without control", func(v *View) {
			v.Nodes = append(v.Nodes, NewForm("form", nil, Field{Key: "f", Name: "f"}))
		}, "exactly one of input"},
		{"field without name", func(v *View) {
			v.Nodes = append(v.Nodes, NewForm("form", nil, TextField("f", "", "F")))
		}, "name: required"},
		{"options with source", func(v *View) {
			f := SelectField("f", "p", "P", Opt("o", "x", "X"))
			f.Select.OptionsSource = OptionsProjects
			v.Nodes = append(v.Nodes, NewForm("form", nil, f))
		}, "host fills"},
		{"two values without multiple", func(v *View) {
			f := SelectField("f", "p", "P")
			f.Select.Value = []string{"a", "b"}
			v.Nodes = append(v.Nodes, NewForm("form", nil, f))
		}, "one value"},
		{"tab active missing", func(v *View) { v.Tabs = NewTabs("z", NewTab("a", "A")) }, "not one of the tabs"},
		{"progress out of range", func(v *View) { v.Nodes = append(v.Nodes, NewProgress("p", "", Fraction(1.5))) }, "outside 0..1"},
		{"unknown tone", func(v *View) { v.Nodes = append(v.Nodes, NewNotice("n", "blue", "", nil)) }, "unknown tone"},
		{"glyph both", func(v *View) {
			r := NewRow("r", "R")
			r.Glyph = &Glyph{Status: StatusOK, Icon: "x"}
			v.Nodes = append(v.Nodes, NewList("l", r))
		}, "not both"},
		{"span two kinds", func(v *View) {
			v.Nodes[0].Text.Content = Spans(Span{Text: "x", Duration: &Duration{Ms: 1}})
		}, "not several"},
		{"thread without id", func(v *View) { v.Nodes = append(v.Nodes, NewThread("th", "")) }, "threadId: required"},
		{"too many elements", func(v *View) {
			for i := range MaxElements {
				v.Nodes = append(v.Nodes, NewChips("c"+itoa(i)))
			}
		}, "elements"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			v := ok()
			tt.mutate(&v)
			err := v.Validate()
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("err = %v, want %q", err, tt.want)
			}
		})
	}
}

func itoa(i int) string {
	b, _ := json.Marshal(i)
	return string(b)
}

func TestInlineJSON(t *testing.T) {
	tests := []struct {
		in   Inline
		want string
	}{
		{Inline{Text: "plain"}, `"plain"`},
		{Inline{Spans: []Span{{Text: "a", Mono: true}}}, `{"spans":[{"text":"a","mono":true}]}`},
	}
	for _, tt := range tests {
		b, err := json.Marshal(tt.in)
		if err != nil || string(b) != tt.want {
			t.Errorf("Marshal = %s, %v; want %s", b, err, tt.want)
		}
	}
	var in Inline
	if err := json.Unmarshal([]byte(`42`), &in); err == nil {
		t.Error("number accepted as inline")
	}
}

func TestButtonWithData(t *testing.T) {
	b := EventButton("del-1", "Delete", "delete")
	d := b.WithData("note-1")
	if d.Action.Event != "delete" || d.Action.Data != "note-1" || b.Action.Data != "" {
		t.Errorf("WithData: %+v, original %+v", d.Action, b.Action)
	}
	if err := (View{Nodes: []Node{NewActions("bar", d)}}).Validate(); err != nil {
		t.Error(err)
	}
	// A button without an action stays without one (Validate refuses it).
	if e := (Button{Key: "x", Label: "X"}).WithData("y"); e.Action != nil {
		t.Errorf("WithData invented an action: %+v", e.Action)
	}
}

func TestIconsSorted(t *testing.T) {
	for i, n := range Icons {
		if !iconPattern.MatchString(n) || (i > 0 && Icons[i-1] >= n) {
			t.Errorf("Icons[%d] = %q: kebab case, sorted, once", i, n)
		}
	}
	if !KnownIcon("workflow") || KnownIcon("no-such-icon") {
		t.Error("KnownIcon")
	}
}
