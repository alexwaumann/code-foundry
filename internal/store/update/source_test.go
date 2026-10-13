package update_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/store/update"
)

func TestParseChannel(t *testing.T) {
	tests := []struct {
		in   string
		want update.Channel
	}{
		{"stable", update.ChannelStable},
		{"tip", update.ChannelTip},
		{"", update.ChannelStable},
		{"nightly", update.ChannelStable},
	}
	for _, tt := range tests {
		if got := update.ParseChannel(tt.in); got != tt.want {
			t.Errorf("ParseChannel(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestHighestTag(t *testing.T) {
	tests := []struct {
		name   string
		tags   []string
		want   string
		wantOK bool
	}{
		{"none", nil, "", false},
		{"only junk", []string{"latest", "nightly"}, "", false},
		{"tip above its stable", []string{"v0.14.41", "v0.14.42-tip.1"}, "v0.14.42-tip.1", true},
		{"base moved: counter keeps climbing", []string{"v0.14.42-tip.1", "v0.15.0-tip.2", "v0.15.0-tip.3", "v0.14.41"}, "v0.15.0-tip.3", true},
		{"promoted stable wins over its tips", []string{"v0.15.0-tip.3", "v0.15.0", "v0.15.0-tip.2"}, "v0.15.0", true},
		{"numeric counter, not lexical", []string{"v0.15.0-tip.9", "v0.15.0-tip.10"}, "v0.15.0-tip.10", true},
		{"junk skipped", []string{"dev", "v0.2.0", "v0.10.0", "garbage"}, "v0.10.0", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := update.HighestTag(tt.tags)
			if got != tt.want || ok != tt.wantOK {
				t.Fatalf("HighestTag(%v) = %q, %v; want %q, %v", tt.tags, got, ok, tt.want, tt.wantOK)
			}
		})
	}
}

func TestDirSource(t *testing.T) {
	tests := []struct {
		name          string
		latest, tip   string // file contents; "" = no file
		ch            update.Channel
		want          string
		wantNoRelease bool
	}{
		{"stable: no files", "", "", update.ChannelStable, "", true},
		{"tip: no files", "", "", update.ChannelTip, "", true},
		{"stable reads latest", "v0.3.0\n", "v0.3.1-tip.2\n", update.ChannelStable, "v0.3.0", false},
		{"tip reads latest-tip", "v0.3.0\n", "v0.3.1-tip.2\n", update.ChannelTip, "v0.3.1-tip.2", false},
		{"tip without latest-tip has no release", "v0.3.0\n", "", update.ChannelTip, "", true},
		{"stable without latest has no release", "", "v0.3.1-tip.2\n", update.ChannelStable, "", true},
		{"tip without latest", "", "v0.3.1-tip.2\n", update.ChannelTip, "v0.3.1-tip.2", false},
		{"tip: a stable promoted after the last tip wins", "v0.3.1\n", "v0.3.1-tip.2\n", update.ChannelTip, "v0.3.1", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			for name, body := range map[string]string{"latest": tt.latest, "latest-tip": tt.tip} {
				if body == "" {
					continue
				}
				if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			got, err := update.DirSource{Dir: dir}.Latest(context.Background(), tt.ch)
			if tt.wantNoRelease {
				if !errors.Is(err, update.ErrNoRelease) {
					t.Fatalf("Latest = %q, %v; want ErrNoRelease", got, err)
				}
				return
			}
			if err != nil || got != tt.want {
				t.Fatalf("Latest = %q, %v; want %q", got, err, tt.want)
			}
		})
	}
}

// fakeGh writes an executable shell script standing in for gh. It records its
// arguments in <dir>/args.
func fakeGh(t *testing.T, script string) (bin, argsFile string) {
	t.Helper()
	dir := t.TempDir()
	bin = filepath.Join(dir, "gh")
	argsFile = filepath.Join(dir, "args")
	body := "#!/bin/sh\nprintf '%s\\n' \"$*\" > '" + argsFile + "'\n" + script
	if err := os.WriteFile(bin, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	return bin, argsFile
}

func TestGhSource(t *testing.T) {
	tests := []struct {
		name          string
		ch            update.Channel
		script        string
		wantArgs      string
		want          string
		wantNoRelease bool
		wantErr       string
	}{
		{
			name: "stable asks releases/latest", ch: update.ChannelStable,
			script:   "echo v0.14.41",
			wantArgs: "api repos/o/n/releases/latest --jq .tag_name",
			want:     "v0.14.41",
		},
		{
			name: "tip lists non-draft releases and takes the highest", ch: update.ChannelTip,
			script:   "printf 'v0.15.0-tip.3\\nv0.15.0-tip.2\\nv0.14.42-tip.1\\nv0.14.41\\n'",
			wantArgs: "api --paginate repos/o/n/releases?per_page=100 --jq .[] | select(.draft | not) | .tag_name",
			want:     "v0.15.0-tip.3",
		},
		{
			name: "tip: a promoted stable wins", ch: update.ChannelTip,
			script: "printf 'v0.15.0\\nv0.15.0-tip.3\\nv0.14.41\\n'",
			want:   "v0.15.0",
		},
		{
			name: "tip: no releases", ch: update.ChannelTip,
			script:        "true",
			wantNoRelease: true,
		},
		{
			name: "stable: 404 means no release", ch: update.ChannelStable,
			script:        "echo 'gh: Not Found (HTTP 404)' >&2; exit 1",
			wantNoRelease: true,
		},
		{
			name: "tip: other errors name the endpoint", ch: update.ChannelTip,
			script:  "echo 'gh: API rate limit exceeded (HTTP 403)' >&2; exit 1",
			wantErr: "gh api repos/o/n/releases: API rate limit exceeded (HTTP 403)",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			bin, argsFile := fakeGh(t, tt.script)
			got, err := update.GhSource{Repo: "o/n", Gh: bin}.Latest(context.Background(), tt.ch)
			switch {
			case tt.wantNoRelease:
				if !errors.Is(err, update.ErrNoRelease) {
					t.Fatalf("Latest = %q, %v; want ErrNoRelease", got, err)
				}
			case tt.wantErr != "":
				if err == nil || err.Error() != tt.wantErr {
					t.Fatalf("err = %v, want %q", err, tt.wantErr)
				}
			default:
				if err != nil || got != tt.want {
					t.Fatalf("Latest = %q, %v; want %q", got, err, tt.want)
				}
			}
			if tt.wantArgs != "" {
				b, err := os.ReadFile(argsFile)
				if err != nil {
					t.Fatal(err)
				}
				if args := strings.TrimSpace(string(b)); args != tt.wantArgs {
					t.Fatalf("gh args = %q, want %q", args, tt.wantArgs)
				}
			}
		})
	}
}
