package main

import (
	"bytes"
	"slices"
	"testing"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// Negative numbers are words (`thread budget -1`), unless a flag takes them as its value.
func TestParseWithPositionalsNegativeNumbers(t *testing.T) {
	tests := []struct {
		name      string
		args      []string
		wantWords []string
		wantUSD   string
		wantJSON  bool
		wantErr   bool
	}{
		{name: "bare negative", args: []string{"-1"}, wantWords: []string{"-1"}},
		{name: "negative decimal after a flag", args: []string{"--json", "-0.5"}, wantWords: []string{"-0.5"}, wantJSON: true},
		{name: "a value flag takes it", args: []string{"--usd", "-1"}, wantUSD: "-1"},
		{name: "= form", args: []string{"--usd=-2"}, wantUSD: "-2"},
		{name: "between words and flags", args: []string{"a", "-3", "--json", "b"}, wantWords: []string{"a", "-3", "b"}, wantJSON: true},
		{name: "after --", args: []string{"--", "-5", "--json"}, wantWords: []string{"-5", "--json"}},
		{name: "not a number is still a flag", args: []string{"-x"}, wantErr: true},
		{name: "dash alone is a word", args: []string{"-"}, wantWords: []string{"-"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var stderr bytes.Buffer
			cl := &cli{stderr: &stderr}
			fs := cl.newFlagSet("thread.budget")
			usd := &argFlag{spec: &v1.ArgSpec{Name: "usd", Type: v1.ArgType_ARG_TYPE_STRING}}
			fs.Var(usd, "usd", "")
			asJSON := fs.Bool("json", false, "")
			words, err := cl.parseWithPositionals(fs, tt.args)
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v (stderr %q)", err, stderr.String())
			}
			if tt.wantErr {
				return
			}
			if !slices.Equal(words, tt.wantWords) || usd.value != tt.wantUSD || *asJSON != tt.wantJSON {
				t.Errorf("words %q usd %q json %v; want %q %q %v", words, usd.value, *asJSON, tt.wantWords, tt.wantUSD, tt.wantJSON)
			}
		})
	}
}

// A rest positional takes every word left, joined by spaces, after the positionals
// before it took theirs.
func TestAssignPositionalsRest(t *testing.T) {
	str := v1.ArgType_ARG_TYPE_STRING
	key := &v1.ArgSpec{Name: "key", Type: str, Positional: true}
	text := &v1.ArgSpec{Name: "text", Type: str, Positional: true, Rest: true}
	for _, tt := range []struct {
		name  string
		specs []*v1.ArgSpec
		words []string
		want  []string // each flag's value
	}{
		{name: "one word", specs: []*v1.ArgSpec{text}, words: []string{"tabs"}, want: []string{"tabs"}},
		{name: "several words", specs: []*v1.ArgSpec{text}, words: []string{"always", "open", "PRs", "as", "drafts"},
			want: []string{"always open PRs as drafts"}},
		{name: "after an earlier positional", specs: []*v1.ArgSpec{key, text}, words: []string{"k", "a", "b"}, want: []string{"k", "a b"}},
		{name: "no words", specs: []*v1.ArgSpec{text}, words: nil, want: []string{""}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			var stderr bytes.Buffer
			cl := &cli{stderr: &stderr}
			fs := cl.newFlagSet("x")
			flags := make([]*argFlag, len(tt.specs))
			var got []string
			for i, s := range tt.specs {
				flags[i] = &argFlag{spec: s}
			}
			if err := cl.assignPositionals(fs, flags, tt.words); err != nil {
				t.Fatalf("err %v, stderr %q", err, stderr.String())
			}
			for _, f := range flags {
				got = append(got, f.value)
			}
			if !slices.Equal(got, tt.want) {
				t.Errorf("values %q, want %q", got, tt.want)
			}
		})
	}
}

// Stray words name the id flag they were probably meant for.
func TestAssignPositionalsHint(t *testing.T) {
	str := v1.ArgType_ARG_TYPE_STRING
	id := &v1.ArgSpec{Name: "id", Type: str, Id: true, ContextBound: true}
	by := &v1.ArgSpec{Name: "by", Type: str, Id: true, DefaultToThreadEnv: true}
	text := &v1.ArgSpec{Name: "text", Type: str, Positional: true}
	run := &v1.ArgSpec{Name: "run", Type: str, Id: true}
	group := &v1.ArgSpec{Name: "group", Type: v1.ArgType_ARG_TYPE_ENUM, EnumValues: []string{"build", "pages"}}
	kind := &v1.ArgSpec{Name: "kind", Type: v1.ArgType_ARG_TYPE_ENUM, EnumValues: []string{"pages", "panel"}}
	tests := []struct {
		name       string
		specs      []*v1.ArgSpec
		words      []string
		wantStderr string
	}{
		{name: "one id flag", specs: []*v1.ArgSpec{id, by}, words: []string{"8f3a"},
			wantStderr: "code-foundry x: unexpected arguments [8f3a] (did you mean --id 8f3a?)\n"},
		{name: "a positional took the id", specs: []*v1.ArgSpec{id, text}, words: []string{"8f3a", "hello"},
			wantStderr: "code-foundry x: unexpected arguments [hello] (the first word is the text; did you mean --id 8f3a?)\n"},
		{name: "two id flags: no guess", specs: []*v1.ArgSpec{id, run}, words: []string{"8f3a"},
			wantStderr: "code-foundry x: unexpected arguments [8f3a]\n"},
		{name: "no id flag", specs: []*v1.ArgSpec{text}, words: []string{"a", "b"},
			wantStderr: "code-foundry x: unexpected arguments [b]\n"},
		{name: "a value of one enum flag", specs: []*v1.ArgSpec{group, id}, words: []string{"pages"},
			wantStderr: "code-foundry x: unexpected arguments [pages] (did you mean --group pages?)\n"},
		{name: "a value of two enum flags: no guess", specs: []*v1.ArgSpec{group, kind}, words: []string{"pages"},
			wantStderr: "code-foundry x: unexpected arguments [pages]\n"},
		{name: "no enum value: the id hint", specs: []*v1.ArgSpec{group, id}, words: []string{"8f3a"},
			wantStderr: "code-foundry x: unexpected arguments [8f3a] (did you mean --id 8f3a?)\n"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var stderr bytes.Buffer
			cl := &cli{stderr: &stderr}
			fs := cl.newFlagSet("x")
			flags := make([]*argFlag, len(tt.specs))
			for i, s := range tt.specs {
				flags[i] = &argFlag{spec: s}
			}
			if err := cl.assignPositionals(fs, flags, tt.words); err == nil || stderr.String() != tt.wantStderr {
				t.Errorf("err %v, stderr %q; want %q", err, stderr.String(), tt.wantStderr)
			}
		})
	}
}
