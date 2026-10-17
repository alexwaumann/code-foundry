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
