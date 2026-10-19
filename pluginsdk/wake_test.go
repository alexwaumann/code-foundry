package pluginsdk

import (
	"strings"
	"testing"
)

func TestManifestWakes(t *testing.T) {
	tick := func() WakeSpec {
		return WakeSpec{Name: "tick", Title: "Tick", Scope: WakeScopeGlobal,
			Args: []WakeArgSpec{{Name: "every", Type: ArgDuration, Default: "10s"}}}
	}
	tests := []struct {
		name   string
		mutate func(*Manifest)
		want   string // substring of the error; "" means valid
	}{
		{name: "valid", mutate: func(*Manifest) {}},
		{name: "digit name", mutate: func(m *Manifest) { m.Wakes[0].Name = "1-tick" }},
		{name: "name uppercase", mutate: func(m *Manifest) { m.Wakes[0].Name = "Tick" }, want: "wakes[0].name"},
		{name: "name with a dot", mutate: func(m *Manifest) { m.Wakes[0].Name = "ci.done" }, want: "wakes[0].name"},
		{name: "name too long", mutate: func(m *Manifest) { m.Wakes[0].Name = strings.Repeat("a", 65) }, want: "wakes[0].name"},
		{name: "name twice", mutate: func(m *Manifest) { m.Wakes = append(m.Wakes, tick()) }, want: "declared twice"},
		{name: "title missing", mutate: func(m *Manifest) { m.Wakes[0].Title = "" }, want: "wakes[0].title"},
		{name: "scope pr", mutate: func(m *Manifest) { m.Wakes[0].Scope = WakeScopePR }},
		{name: "scope unknown", mutate: func(m *Manifest) { m.Wakes[0].Scope = "worktree" }, want: "unknown scope"},
		{name: "arg type unknown", mutate: func(m *Manifest) { m.Wakes[0].Args[0].Type = ArgPath }, want: "unknown type"},
		{name: "arg duration default bad", mutate: func(m *Manifest) { m.Wakes[0].Args[0].Default = "soon" }, want: "default"},
		{name: "arg duration default zero", mutate: func(m *Manifest) { m.Wakes[0].Args[0].Default = "0s" }, want: "over zero"},
		{name: "arg context pr", mutate: func(m *Manifest) {
			m.Wakes[0].Args = append(m.Wakes[0].Args, WakeArgSpec{Name: "pr", Context: WakeContextPR, Required: true})
		}},
		{name: "arg context worktree", mutate: func(m *Manifest) { m.Wakes[0].Args[0] = WakeArgSpec{Name: "w", Context: ArgContextWorktree} }, want: "unknown context"},
		{name: "arg context on int", mutate: func(m *Manifest) {
			m.Wakes[0].Args[0] = WakeArgSpec{Name: "n", Type: ArgInt, Context: WakeContextThread}
		}, want: "must be a string"},
		{name: "arg required with default", mutate: func(m *Manifest) { m.Wakes[0].Args[0].Required = true }, want: "required arg"},
		{name: "arg twice", mutate: func(m *Manifest) { m.Wakes[0].Args = append(m.Wakes[0].Args, m.Wakes[0].Args[0]) }, want: "declared twice"},
		{name: "arg enum default", mutate: func(m *Manifest) {
			m.Wakes[0].Args[0] = WakeArgSpec{Name: "on", Type: ArgEnum, Enum: []string{"pass", "fail"}, Default: "maybe"}
		}, want: "want one of"},
		{name: "too many", mutate: func(m *Manifest) {
			for range MaxWakes {
				m.Wakes = append(m.Wakes, tick())
			}
		}, want: "more than 50"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m := validManifest()
			m.Wakes = []WakeSpec{tick()}
			tt.mutate(&m)
			err := m.Validate()
			switch {
			case tt.want == "" && err != nil:
				t.Fatalf("unexpected error: %v", err)
			case tt.want != "" && err == nil:
				t.Fatalf("no error, want %q", tt.want)
			case tt.want != "" && !strings.Contains(err.Error(), tt.want):
				t.Fatalf("error %q does not contain %q", err, tt.want)
			}
		})
	}
}

func TestParseManifestWarnsUnknownWakeFields(t *testing.T) {
	data := `{"name":"hello","version":"0.1.0","protocol":1,"exec":["bin/hello"],
	  "wakes":[{"name":"tick","title":"Tick","every":"1s","args":[{"name":"every","pattern":"x"}]}]}`
	m, warnings, err := LoadManifest([]byte(data))
	if err != nil {
		t.Fatal(err)
	}
	if w, ok := m.Wake("tick"); !ok || w.ScopeOr() != WakeScopeGlobal {
		t.Fatalf("wake %+v %v", w, ok)
	}
	for _, want := range []string{"wakes[0].every: unknown field", "wakes[0].args[0].pattern: unknown field"} {
		if !strings.Contains(strings.Join(warnings, "\n"), want) {
			t.Errorf("missing warning %q in %q", want, warnings)
		}
	}
}

func TestWakeArgCheck(t *testing.T) {
	for _, tt := range []struct {
		arg  WakeArgSpec
		v    string
		want string // "" valid
	}{
		{WakeArgSpec{Name: "x"}, "anything at all", ""},
		{WakeArgSpec{Name: "x"}, "", "empty"},
		{WakeArgSpec{Name: "x"}, "two\nlines", "one line"},
		{WakeArgSpec{Name: "x"}, strings.Repeat("a", MaxWakeArgLen+1), "longer"},
		{WakeArgSpec{Name: "n", Type: ArgInt}, "12", ""},
		{WakeArgSpec{Name: "n", Type: ArgInt}, "1.5", "integer"},
		{WakeArgSpec{Name: "b", Type: ArgBool}, "true", ""},
		{WakeArgSpec{Name: "b", Type: ArgBool}, "yes", "true or false"},
		{WakeArgSpec{Name: "e", Type: ArgEnum, Enum: []string{"a"}}, "a", ""},
		{WakeArgSpec{Name: "e", Type: ArgEnum, Enum: []string{"a"}}, "b", "one of"},
		{WakeArgSpec{Name: "d", Type: ArgDuration}, "1m30s", ""},
		{WakeArgSpec{Name: "d", Type: ArgDuration}, "-1s", "over zero"},
		{WakeArgSpec{Name: "d", Type: ArgDuration}, "10", "duration"},
	} {
		err := tt.arg.Check(tt.v)
		switch {
		case tt.want == "" && err != nil:
			t.Errorf("%s %q: %v", tt.arg.TypeOr(), tt.v, err)
		case tt.want != "" && (err == nil || !strings.Contains(err.Error(), tt.want)):
			t.Errorf("%s %q: error %v, want %q", tt.arg.TypeOr(), tt.v, err, tt.want)
		}
	}
}

func TestWakeHint(t *testing.T) {
	for _, tt := range []struct {
		plugin, source string
		args           map[string]string
		want           string
	}{
		{"hello", "tick", nil, "code-foundry thread subscribe --plugin hello/tick"},
		{"hello", "tick", map[string]string{"every": "2s"}, "code-foundry thread subscribe --plugin hello/tick --arg every=2s"},
		{"gh-actions", "checks-done", map[string]string{"pr": "alex/cf#12", "conclusion": "failure"},
			"code-foundry thread subscribe --plugin gh-actions/checks-done --arg conclusion=failure --arg pr=alex/cf#12"},
		{"x", "y", map[string]string{"q": "a b's"}, `code-foundry thread subscribe --plugin x/y --arg 'q=a b'\''s'`},
		{"x", "y", map[string]string{"q": "$HOME"}, `code-foundry thread subscribe --plugin x/y --arg 'q=$HOME'`},
	} {
		if got := WakeHint(tt.plugin, tt.source, tt.args); got != tt.want {
			t.Errorf("WakeHint(%s, %s, %v) = %s, want %s", tt.plugin, tt.source, tt.args, got, tt.want)
		}
	}
}

func TestParseWakeTarget(t *testing.T) {
	for _, tt := range []struct {
		in, plugin, source string
		ok                 bool
	}{
		{"hello/tick", "hello", "tick", true},
		{"1password/item-changed", "1password", "item-changed", true},
		{"hello", "", "", false},
		{"hello/", "", "", false},
		{"/tick", "", "", false},
		{"Hello/tick", "", "", false},
		{"hello/ti.ck", "", "", false},
		{"hello/tick/x", "", "", false},
	} {
		p, s, err := ParseWakeTarget(tt.in)
		if (err == nil) != tt.ok || p != tt.plugin || s != tt.source {
			t.Errorf("ParseWakeTarget(%q) = %q, %q, %v", tt.in, p, s, err)
		}
	}
}

func TestMatchWake(t *testing.T) {
	for _, tt := range []struct {
		name        string
		args, match map[string]string
		want        bool
	}{
		{"no args match anything", nil, map[string]string{"pr": "a/b#1"}, true},
		{"no args, no match", nil, nil, true},
		{"equal", map[string]string{"pr": "a/b#1"}, map[string]string{"pr": "a/b#1"}, true},
		{"fewer args match broadly", map[string]string{"pr": "a/b#1"}, map[string]string{"pr": "a/b#1", "conclusion": "failure"}, true},
		{"other value", map[string]string{"pr": "a/b#1"}, map[string]string{"pr": "a/b#2"}, false},
		{"arg missing from the match", map[string]string{"pr": "a/b#1", "conclusion": "failure"}, map[string]string{"pr": "a/b#1"}, false},
		{"args, empty match", map[string]string{"every": "2s"}, nil, false},
	} {
		if got := MatchWake(tt.args, tt.match); got != tt.want {
			t.Errorf("%s: MatchWake = %v", tt.name, got)
		}
	}
}

func TestFormatWakeArgs(t *testing.T) {
	if got := FormatWakeArgs(map[string]string{"pr": "a/b#1", "every": "2s"}); got != "every=2s pr=a/b#1" {
		t.Errorf("FormatWakeArgs = %q", got)
	}
	if got := FormatWakeArgs(nil); got != "" {
		t.Errorf("FormatWakeArgs(nil) = %q", got)
	}
}
