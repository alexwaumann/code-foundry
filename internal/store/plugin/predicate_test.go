package plugin

import (
	"strings"
	"testing"
)

func TestCompilePredicateErrors(t *testing.T) {
	tests := []struct{ src, want string }{
		{"", "expected a fact or a value"},
		{"thread &&", "expected a fact or a value"},
		{"(thread", `expected ")"`},
		{"thread.nope", `unknown fact "thread.nope"`},
		{"pr.foo", `unknown fact "pr.foo"`},
		{"jenkins", `a plugin's fact is <plugin>.<key>`},
		{`view == "thread" == true`, "comparisons do not chain"},
		{`project.slug =~ "x"`, "needs a /regular expression/"},
		{`project.slug =~ /(/`, "regular expression"},
		{`/x/`, "unexpected"},
		{`"a" in [thread]`, "a list holds literals"},
		{`"unterminated`, "unterminated string"},
		{`thread & project`, `unexpected "&"`},
		{`thread.id == 1.2.3`, "bad number"},
		{strings.Repeat("!", 40) + "thread", "nested too deeply"},
		{strings.Repeat("a", MaxPredicate+1), "longer than"},
	}
	for _, tt := range tests {
		t.Run(tt.src, func(t *testing.T) {
			_, err := CompilePredicate(tt.src)
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Errorf("CompilePredicate(%q) = %v, want an error with %q", tt.src, err, tt.want)
			}
		})
	}
}

func TestPredicateEval(t *testing.T) {
	facts := map[string]value{
		"thread":             boolValue(true),
		"thread.hasPr":       boolValue(true),
		"thread.status":      stringValue("busy"),
		"thread.pr.number":   numberValue(42),
		"thread.pr.url":      stringsValue([]string{"https://github.com/o/r/pull/42", "https://github.com/o/r/pull/7"}),
		"project":            boolValue(false),
		"project.slug":       stringValue("acme/payments"),
		"view":               nullValue,
		"pr.checks.provider": stringsValue([]string{"github-actions", "status"}),
		"pr.checks.url":      stringsValue([]string{"https://jenkins.corp.example/job/1"}),
		"pr.checks.name":     unknownValue,
		"jenkins.running":    boolValue(true),
		"jenkins.count":      numberValue(0),
		"jenkins.tags":       stringsValue(nil),
	}
	lookup := func(n string) value {
		if v, ok := facts[n]; ok {
			return v
		}
		return nullValue
	}
	tests := []struct {
		src  string
		want tri
	}{
		{"thread", triTrue},
		{"!thread", triFalse},
		{"project", triFalse},
		{"view", triFalse},
		{"jenkins.missing", triFalse},
		{"jenkins.count", triFalse},
		{"jenkins.tags", triFalse},
		{"thread && thread.hasPr", triTrue},
		{"thread && project", triFalse},
		{"project || thread", triTrue},
		{`thread.status == "busy"`, triTrue},
		{`thread.status != "busy"`, triFalse},
		{`thread.status == 'idle'`, triFalse},
		{`thread.pr.number == 42`, triTrue},
		{`thread.pr.number == "42"`, triFalse},
		{`thread.pr.url == "https://github.com/o/r/pull/7"`, triTrue},
		{`thread.pr.url != "https://github.com/o/r/pull/7"`, triFalse},
		{`thread.pr.url =~ /\/pull\/4\d$/`, triTrue},
		{`pr.checks.url =~ /^https:\/\/jenkins\.corp\.example\//`, triTrue},
		{`project.slug in ["acme/payments", "acme/web"]`, triTrue},
		{`project.slug in ["acme/web"]`, triFalse},
		{`"github-actions" in pr.checks.provider`, triTrue},
		{`"buildkite" in pr.checks.provider`, triFalse},
		{`pr.checks.provider == "status"`, triTrue},
		{`view == null`, triTrue},
		{`view != null`, triFalse},
		{`view == "thread"`, triFalse},
		{`view != "thread"`, triTrue},
		{`jenkins.running == true`, triTrue},
		{`!(thread && !jenkins.running)`, triTrue},
		{`thread && (project || jenkins.running)`, triTrue},
		// Unknown (async) facts: three-valued.
		{`pr.checks.name`, triUnknown},
		{`"x" in pr.checks.name`, triUnknown},
		{`!pr.checks.name`, triUnknown},
		{`pr.checks.name && project`, triFalse},
		{`pr.checks.name || thread`, triTrue},
		{`pr.checks.name && thread`, triUnknown},
		{`pr.checks.name =~ /x/`, triUnknown},
	}
	for _, tt := range tests {
		t.Run(tt.src, func(t *testing.T) {
			p, err := CompilePredicate(tt.src)
			if err != nil {
				t.Fatal(err)
			}
			if got := p.eval(lookup); got != tt.want {
				t.Errorf("%s = %s, want %s", tt.src, got, tt.want)
			}
		})
	}
}

func TestPredicateFacts(t *testing.T) {
	p, err := CompilePredicate(`thread && ("github-actions" in pr.checks.provider || jenkins.hasPipeline) && thread`)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(p.Facts(), ","); got != "jenkins.hasPipeline,pr.checks.provider,thread" {
		t.Errorf("facts = %s", got)
	}
	var nilP *Predicate
	if nilP.eval(func(string) value { return nullValue }) != triTrue {
		t.Error("a nil predicate is not true")
	}
}

func TestValueFromJSON(t *testing.T) {
	tests := []struct {
		in      any
		want    value
		wantErr bool
	}{
		{nil, nullValue, false},
		{true, boolValue(true), false},
		{"x", stringValue("x"), false},
		{3.0, numberValue(3), false},
		{[]any{"a", 1.0}, value{k: vList, list: []value{stringValue("a"), numberValue(1)}}, false},
		{[]any{[]any{}}, value{}, true},
		{map[string]any{}, value{}, true},
	}
	for _, tt := range tests {
		got, err := valueFromJSON(tt.in, 0)
		if (err != nil) != tt.wantErr || (!tt.wantErr && !valuesEqual(got, tt.want)) {
			t.Errorf("valueFromJSON(%v) = %+v, %v", tt.in, got, err)
		}
	}
}
