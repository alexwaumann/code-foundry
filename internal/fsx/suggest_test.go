package fsx

import (
	"context"
	"slices"
	"strings"
	"testing"
)

func TestSuggestIgnored(t *testing.T) {
	dir := ignoredRepo(t)
	defaults := []string{".env*", "CLAUDE.local.md", ".claude/settings.local.json"}
	type row struct {
		path                  string
		dir                   bool
		files                 int
		included, matchesText bool
	}
	tests := []struct {
		name      string
		text      string
		include   []string
		limit     int
		want      []row
		textFiles int
		textError string
		truncated bool
	}{
		{name: "what the text includes comes first", text: ".env", include: defaults, want: []row{
			{path: ".env", included: true, matchesText: true}, {path: "src/.env", included: true, matchesText: true},
			{path: ".env.local", included: true},
		}, textFiles: 2},
		{name: "a glob is counted, its stars dropped for ranking", text: ".env*", include: nil, want: []row{
			{path: ".env", matchesText: true}, {path: ".env.local", matchesText: true}, {path: "src/.env", matchesText: true},
		}, textFiles: 3},
		{name: "a name pattern does not count inside collapsed folders", text: "*.html", want: nil, textFiles: 0},
		{name: "a collapsed folder with its count", text: "node_modules/", want: []row{
			{path: "node_modules", dir: true, files: 2, matchesText: true},
		}, textFiles: 2},
		{name: "a path into a folder counts inside it", text: "build/**/*.html", want: []row{
			{path: "build", dir: true, files: 5},
		}, textFiles: 2},
		{name: "an invalid pattern still suggests", text: "!scratch", want: []row{
			{path: "docs/scratch", dir: true, files: 2},
		}, textError: `pattern "!scratch" starts with !`},
		{name: "the shallowest first, limited", text: "", limit: 5, want: []row{
			{path: ".env"}, {path: ".env.local"}, {path: "CLAUDE.local.md"}, {path: "build", dir: true, files: 5}, {path: "dist", dir: true, files: 1},
		}, truncated: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := SuggestIgnored(context.Background(), dir, tt.include, tt.text, tt.limit)
			if err != nil {
				t.Fatal(err)
			}
			rows := make([]row, len(got.Entries))
			for i, e := range got.Entries {
				rows[i] = row{path: e.Path, dir: e.Dir, files: e.Files, included: e.Included, matchesText: e.MatchesText}
				if e.FilesCapped {
					t.Errorf("%s: count capped", e.Path)
				}
			}
			if !slices.Equal(rows, tt.want) {
				t.Errorf("entries = %+v\nwant %+v", rows, tt.want)
			}
			if got.TextFiles != tt.textFiles || got.TextFilesCapped || got.Truncated != tt.truncated {
				t.Errorf("text files %d (capped %t), truncated %t; want %d, %t", got.TextFiles, got.TextFilesCapped, got.Truncated, tt.textFiles, tt.truncated)
			}
			if (got.TextError == "") != (tt.textError == "") || !strings.Contains(got.TextError, tt.textError) {
				t.Errorf("text error %q, want %q", got.TextError, tt.textError)
			}
		})
	}
}

func TestSuggestIgnoredCountBudget(t *testing.T) {
	dir := ignoredRepo(t)
	got, err := SuggestIgnored(context.Background(), dir, nil, "build", 1)
	if err != nil || len(got.Entries) != 1 || got.Entries[0].Files != 5 {
		t.Fatalf("= %+v, %v", got, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := SuggestIgnored(ctx, dir, nil, "", 0); err == nil {
		t.Error("cancelled: want an error")
	}
}

func TestSuggestQuery(t *testing.T) {
	for in, want := range map[string]string{
		".env*":                  ".env",
		"build/**/*.html":        "build//.html",
		"a[bc]?":                 "abc",
		strings.Repeat("a ", 10): strings.TrimSpace(strings.Repeat("a ", 8)),
	} {
		if got := suggestQuery(in); got != want {
			t.Errorf("suggestQuery(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestMergeIncludes(t *testing.T) {
	got := MergeIncludes([]string{".env*", "CLAUDE.local.md"}, nil, []string{"dist/", ".env*"})
	if want := []string{".env*", "CLAUDE.local.md", "dist/"}; !slices.Equal(got, want) {
		t.Errorf("= %q, want %q", got, want)
	}
}
