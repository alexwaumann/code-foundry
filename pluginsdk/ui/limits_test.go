package ui

import (
	"encoding/json"
	"strings"
	"testing"
)

// Holes the fuzzers found (docs/notes/plugins-9-fuzz.md): each view validated, then the
// host refused it or used it wrongly.
func TestValidateFuzzFindings(t *testing.T) {
	form := func(fields string) string {
		return `{"nodes":[{"key":"f","form":{"fields":[` + fields + `],"submit":{"key":"s","label":"Save","action":{"event":"save"}}}}]}`
	}
	tests := []struct {
		name, view string
		mutate     func(v *View)
		want       string
	}{
		{name: "invalid UTF-8 in event data", view: `{"nodes":[{"key":"a","actions":{"buttons":[{"key":"b","label":"B","action":{"event":"e","data":"x"}}]}}]}`,
			mutate: func(v *View) { v.Nodes[0].Actions.Buttons[0].Action.Data = strings.Repeat("\xff", 600) },
			want:   "nodes[0].actions.buttons[0].action.data: not valid UTF-8"},
		{name: "invalid UTF-8 in a log", view: `{"nodes":[{"key":"l","log":{"text":"x"}}]}`,
			mutate: func(v *View) { v.Nodes[0].Log.Text = "ok \xc3\x28" },
			want:   "nodes[0].log.text: not valid UTF-8"},
		{name: "invalid UTF-8 in a command arg", view: `{"nodes":[{"key":"a","actions":{"buttons":[{"key":"b","label":"B","action":{"command":{"name":"x.y","args":{"k":"v"}}}}]}}]}`,
			mutate: func(v *View) { v.Nodes[0].Actions.Buttons[0].Action.Command.Args["k"] = "\xff" },
			want:   "nodes[0].actions.buttons[0].action.command.args.k: not valid UTF-8"},
		{name: "store the secret store refuses", view: form(`{"key":"t","name":"t","input":{"kind":"secret","store":"jenkins:token"}}`),
			want: `store: "jenkins:token" must match`},
		{name: "two fields of one name", view: form(`{"key":"a","name":"token","input":{}},{"key":"g","fieldset":{"fields":[{"key":"b","name":"token","input":{"kind":"secret","store":"t"}}]}}`),
			want: `"token" is already the name of nodes[0].form.fields[0] in this form`},
		{name: "one name in two forms", view: `{"nodes":[{"key":"f1","form":{"fields":[{"key":"a","name":"n","input":{}}]}},{"key":"f2","form":{"fields":[{"key":"b","name":"n","input":{}}]}}]}`},
		{name: "problems past the cap are counted", view: `{"nodes":[` + strings.TrimSuffix(strings.Repeat(`{"key":"k"},`, 60), ",") + `]}`,
			want: "view: 69 more problems"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var v View
			if err := json.Unmarshal([]byte(tt.view), &v); err != nil {
				t.Fatal(err)
			}
			if tt.mutate != nil {
				tt.mutate(&v)
			}
			err := v.Validate()
			if tt.want == "" {
				if err != nil {
					t.Fatalf("Validate: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("Validate = %v, want %q", err, tt.want)
			}
			if j, ok := err.(interface{ Unwrap() []error }); ok && len(j.Unwrap()) > MaxProblems+1 {
				t.Errorf("%d problems named", len(j.Unwrap()))
			}
		})
	}
}

// Patterns the GUI's backtracking regular expressions could spend exponential time on
// are refused; ordinary ones pass.
func TestNestedQuantifier(t *testing.T) {
	tests := []struct {
		pattern string
		at      int // -1: allowed
	}{
		{`^https://`, -1},
		{`^[a-z0-9-]+$`, -1},
		{`^(ab|cd)+$`, -1},
		{`^(a)+$`, -1},
		{`^(a+)?$`, -1},
		{`^(a{2,})+$`, -1},
		{`^[(a+)+]$`, -1},
		{`^\(a+\)+$`, -1},
		{`^[]a+(]+$`, -1},
		{`(a+)+`, 0},
		{`^(a*)*$`, 1},
		{`^(a+)*$`, 1},
		{`^(a*)+$`, 1},
		{`^[a-z]+(-[a-z]+)*$`, 7},
		{`^(?:\w+\s?)+$`, 1},
		{`x((ab)+c)*`, 1},
		{`(a|b+)+`, 0},
		{`([)]+)+`, 0},
	}
	for _, tt := range tests {
		if got := nestedQuantifier(tt.pattern); got != tt.at {
			t.Errorf("nestedQuantifier(%q) = %d, want %d", tt.pattern, got, tt.at)
		}
	}
	long := View{Nodes: []Node{{Key: "f", Form: &Form{Fields: []Field{{Key: "a", Name: "a", Input: &Input{Pattern: strings.Repeat("a", MaxPattern+1)}}}}}}}
	if err := long.Validate(); err == nil || !strings.Contains(err.Error(), "257 characters, at most 256") {
		t.Errorf("long pattern: %v", err)
	}
	nested := View{Nodes: []Node{{Key: "f", Form: &Form{Fields: []Field{{Key: "a", Name: "a", Input: &Input{Pattern: `^(a+)+$`}}}}}}}
	if err := nested.Validate(); err == nil || !strings.Contains(err.Error(), "nodes[0].form.fields[0].input.pattern: a quantified group holds a quantifier (at 1") {
		t.Errorf("nested: %v", err)
	}
}
