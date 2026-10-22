package version

import (
	"os"
	"strings"
	"testing"
)

func TestModuleIsGoMod(t *testing.T) {
	b, err := os.ReadFile("../../go.mod")
	if err != nil {
		t.Fatal(err)
	}
	first, _, _ := strings.Cut(string(b), "\n")
	if want := "module " + Module; first != want {
		t.Errorf("go.mod starts %q, want %q", first, want)
	}
	if SourceRepo != "https://github.com/alexwaumann/code-foundry" {
		t.Errorf("SourceRepo = %q", SourceRepo)
	}
}

func TestSource(t *testing.T) {
	const sha = "844a109c0123456789abcdef0123456789abcdef"
	repo := SourceRepo
	for _, tt := range []struct {
		name      string
		info      Info
		ref, line string
	}{
		{
			name: "stable tag", info: Info{Version: "v0.21.3", Commit: sha}, ref: "v0.21.3",
			line: "Rendered by Code Foundry v0.21.3 (commit 844a109c0123) · source: " + repo + "/tree/v0.21.3",
		},
		{
			// Tip tags are pruned (release.yml keeps five): the commit outlives them.
			name: "tip tag", info: Info{Version: "v0.22.0-tip.4", Commit: sha}, ref: sha,
			line: "Rendered by Code Foundry v0.22.0-tip.4 (commit 844a109c0123) · source: " + repo + "/tree/" + sha,
		},
		{
			name: "tip tag without a commit", info: Info{Version: "v0.22.0-tip.4"}, ref: "v0.22.0-tip.4",
			line: "Rendered by Code Foundry v0.22.0-tip.4 (commit unknown) · source: " + repo + "/tree/v0.22.0-tip.4",
		},
		{
			name: "tip tag with a dirty commit", info: Info{Version: "v0.22.0-tip.4", Commit: sha + "-dirty"}, ref: sha,
			line: "Rendered by Code Foundry v0.22.0-tip.4 (commit 844a109c0123-dirty) · source: " + repo + "/tree/" + sha,
		},
		{
			name: "tag without a commit", info: Info{Version: "v1.0.0"}, ref: "v1.0.0",
			line: "Rendered by Code Foundry v1.0.0 (commit unknown) · source: " + repo + "/tree/v1.0.0",
		},
		{
			name: "dev with a commit", info: Info{Version: "dev", Commit: sha}, ref: sha,
			line: "Rendered by Code Foundry dev (commit 844a109c0123) · source: " + repo + "/tree/" + sha +
				" (dev build: the source there may not match this build)",
		},
		{
			name: "dev, dirty", info: Info{Version: "dev", Commit: sha + "-dirty"}, ref: sha,
			line: "Rendered by Code Foundry dev (commit 844a109c0123-dirty) · source: " + repo + "/tree/" + sha +
				" (dev build: the source there may not match this build)",
		},
		{
			name: "dev without a commit", info: Info{Version: "dev"}, ref: "",
			line: "Rendered by Code Foundry dev (commit unknown) · source: " + repo +
				" (dev build, commit unknown: the source there may not match this build)",
		},
		{
			name: "not a release tag", info: Info{Version: "v1.2", Commit: "abc1234"}, ref: "abc1234",
			line: "Rendered by Code Foundry v1.2 (commit abc1234) · source: " + repo + "/tree/abc1234" +
				" (dev build: the source there may not match this build)",
		},
		{
			name: "not a commit", info: Info{Version: "dev", Commit: "main"}, ref: "",
			line: "Rendered by Code Foundry dev (commit main) · source: " + repo +
				" (dev build, commit unknown: the source there may not match this build)",
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			s := tt.info.Source()
			if s.Repo != repo || s.Ref != tt.ref {
				t.Errorf("Source() = %+v, want ref %q", s, tt.ref)
			}
			wantURL := repo
			if tt.ref != "" {
				wantURL += "/tree/" + tt.ref
			}
			if s.URL != wantURL {
				t.Errorf("URL = %q, want %q", s.URL, wantURL)
			}
			if got := tt.info.Provenance(); got != tt.line {
				t.Errorf("Provenance() =\n %q\nwant\n %q", got, tt.line)
			}
		})
	}
}
