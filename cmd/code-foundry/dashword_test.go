package main

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/client"
)

// A dash word with a space in it is text, not a flag (a report's summary, e6 §4.4); one
// without is still a flag.
func TestParseWithPositionalsSpacedDash(t *testing.T) {
	tests := []struct {
		name      string
		args      []string
		wantWords []string
		wantUSD   string
		wantErr   bool
	}{
		{name: "a summary starting with --", args: []string{"done", "--json now emits"}, wantWords: []string{"done", "--json now emits"}},
		{name: "a single dash and a tab", args: []string{"-x\ty"}, wantWords: []string{"-x\ty"}},
		{name: "a value flag takes it", args: []string{"--usd", "--a b"}, wantUSD: "--a b"},
		{name: "spaces only after =", args: []string{"--usd=a b"}, wantUSD: "a b"},
		{name: "one word is a flag", args: []string{"done", "--json-now"}, wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var stderr bytes.Buffer
			cl := &cli{stderr: &stderr}
			fs := cl.newFlagSet("thread.report")
			usd := &argFlag{spec: &v1.ArgSpec{Name: "usd", Type: v1.ArgType_ARG_TYPE_STRING}}
			fs.Var(usd, "usd", "")
			words, err := cl.parseWithPositionals(fs, tt.args)
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v (stderr %q)", err, stderr.String())
			}
			if !tt.wantErr && (!slices.Equal(words, tt.wantWords) || usd.value != tt.wantUSD) {
				t.Errorf("words %q usd %q; want %q %q", words, usd.value, tt.wantWords, tt.wantUSD)
			}
		})
	}
}

// A bad flag prints the flag package's line and one pointer, not the whole help; -h
// prints the help.
func TestRegistryBadFlagIsOneLine(t *testing.T) {
	tests := []struct {
		name       string
		args       []string
		wantErr    bool
		wantStderr string
	}{
		{name: "unknown flag", args: []string{"thread", "report", "done", "--jsonl"}, wantErr: true,
			wantStderr: "flag provided but not defined: -jsonl\n" +
				"Run `code-foundry help thread.report` for usage; a value that starts with - goes after --.\n"},
		{name: "help", args: []string{"thread", "report", "-h"}, wantStderr: "thread.report"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := &fakeArgCommands{}
			cl, _, stderr := fakeCommandCLI(t, f)
			err := cl.dispatch(context.Background(), tt.args)
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v", err)
			}
			if tt.wantErr && stderr.String() != tt.wantStderr {
				t.Errorf("stderr = %q, want %q", stderr.String(), tt.wantStderr)
			}
			if !tt.wantErr && !strings.Contains(stderr.String(), tt.wantStderr) {
				t.Errorf("stderr = %q, want it to contain %q", stderr.String(), tt.wantStderr)
			}
			if len(f.args) != 0 {
				t.Errorf("invoked with %v", f.args)
			}
		})
	}
}

// fakeCommandCLI is a cli whose daemon serves f's CommandService.
func fakeCommandCLI(t *testing.T, f codefoundryv1connect.CommandServiceHandler) (*cli, *bytes.Buffer, *bytes.Buffer) {
	t.Helper()
	path, h := codefoundryv1connect.NewCommandServiceHandler(f)
	mux := http.NewServeMux()
	mux.Handle(path, h)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	c := &client.Client{Command: codefoundryv1connect.NewCommandServiceClient(srv.Client(), srv.URL)}
	var stdout, stderr bytes.Buffer
	dir := t.TempDir()
	return &cli{
		stdout: &stdout, stderr: &stderr, stdin: strings.NewReader(""),
		connect: func(context.Context) (*client.Client, error) { return c, nil },
		getwd:   func() (string, error) { return dir, nil },
	}, &stdout, &stderr
}
