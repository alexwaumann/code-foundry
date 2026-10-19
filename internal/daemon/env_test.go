package daemon

import (
	"bytes"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/paths"
)

func TestInheritedClaudeVars(t *testing.T) {
	tests := []struct {
		name    string
		environ []string
		want    []string
	}{
		{"none", []string{"PATH=/bin", "HOME=/h", "CLAUDE_CONFIG_DIR=/c", "ANTHROPIC_API_KEY=k"}, nil},
		{"Claude session vars", []string{
			"CLAUDECODE=1", "CLAUDE_CODE_CHILD_THREAD=1", "CLAUDE_CODE_ENTRYPOINT=sdk-ts", "CLAUDE_CODE_THREAD_ID=x",
			"CLAUDE_PID=1", "CLAUDE_EFFORT=high", "CLAUDE_AGENT_SDK_VERSION=0.3", "PATH=/bin", "CLAUDE_CODE_MESSAGING_TOKEN=",
		}, []string{
			"CLAUDECODE", "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_CODE_CHILD_THREAD", "CLAUDE_CODE_ENTRYPOINT",
			"CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_THREAD_ID", "CLAUDE_EFFORT", "CLAUDE_PID",
		}},
		// User configuration that merely starts with CLAUDE is kept.
		{"config kept", []string{"CLAUDE_CONFIG_DIR=/c", "CLAUDECODEX=1", "CLAUDE_CODEX=1"}, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := inheritedClaudeVars(tt.environ); !slices.Equal(got, tt.want) {
				t.Errorf("got %q, want %q", got, tt.want)
			}
		})
	}
}

func TestScrubClaudeEnv(t *testing.T) {
	t.Setenv("CLAUDECODE", "1")
	t.Setenv("CLAUDE_CODE_CHILD_THREAD", "1")
	t.Setenv("CLAUDE_CODE_MESSAGING_TOKEN", "secret-token")
	t.Setenv("CLAUDE_CONFIG_DIR", "/keep")
	var buf bytes.Buffer
	removed := scrubClaudeEnv(slog.New(slog.NewTextHandler(&buf, nil)))
	for _, k := range []string{"CLAUDECODE", "CLAUDE_CODE_CHILD_THREAD", "CLAUDE_CODE_MESSAGING_TOKEN"} {
		if _, ok := os.LookupEnv(k); ok {
			t.Errorf("%s still set", k)
		}
		if !slices.Contains(removed, k) {
			t.Errorf("%s not reported as removed: %q", k, removed)
		}
	}
	if os.Getenv("CLAUDE_CONFIG_DIR") != "/keep" {
		t.Error("CLAUDE_CONFIG_DIR was removed")
	}
	log := buf.String()
	if !strings.Contains(log, "CLAUDE_CODE_CHILD_THREAD") {
		t.Errorf("log does not name the removed vars: %s", log)
	}
	if strings.Contains(log, "secret-token") {
		t.Errorf("log leaks a value: %s", log)
	}
}

func TestThreadEnv(t *testing.T) {
	got := threadEnv(4321, "tok")
	want := []string{"CODE_FOUNDRY_ENDPOINT=http://127.0.0.1:4321", "CODE_FOUNDRY_TOKEN=tok"}
	if !slices.Equal(got, want) {
		t.Fatalf("threadEnv = %q, want %q", got, want)
	}
}

func TestScrubEndpointEnv(t *testing.T) {
	t.Setenv("CODE_FOUNDRY_ENDPOINT", "http://127.0.0.1:1")
	t.Setenv("CODE_FOUNDRY_TOKEN", "other-daemon")
	t.Setenv("CODE_FOUNDRY_THREAD", "s-other-daemon")
	t.Setenv(paths.EnvThreadLegacy, "s-older-daemon")
	var logs bytes.Buffer
	scrubEndpointEnv(slog.New(slog.NewTextHandler(&logs, nil)))
	for _, k := range []string{"CODE_FOUNDRY_ENDPOINT", "CODE_FOUNDRY_TOKEN", "CODE_FOUNDRY_THREAD", paths.EnvThreadLegacy} {
		if _, ok := os.LookupEnv(k); ok {
			t.Errorf("%s still set", k)
		}
	}
	if strings.Contains(logs.String(), "other-daemon") || !strings.Contains(logs.String(), "CODE_FOUNDRY_TOKEN") {
		t.Errorf("log = %q", logs.String())
	}
}

func TestPathWithCLIDir(t *testing.T) {
	tests := []struct {
		name, path, bin string
		want, wantDir   string
	}{
		{"no CLI", "/usr/bin:/bin", "", "/usr/bin:/bin", ""},
		{"prepended", "/usr/bin:/bin", "/opt/cf/code-foundry", "/opt/cf:/usr/bin:/bin", "/opt/cf"},
		{"already on PATH", "/usr/bin:/opt/cf:/bin", "/opt/cf/code-foundry", "/usr/bin:/opt/cf:/bin", ""},
		{"on PATH unclean", "/usr/bin:/opt/cf/:/bin", "/opt/cf/code-foundry", "/usr/bin:/opt/cf/:/bin", ""},
		{"empty PATH", "", "/opt/cf/code-foundry", "/opt/cf", "/opt/cf"},
		{"empty entries ignored", "::/bin", "/opt/cf/code-foundry", "/opt/cf:::/bin", "/opt/cf"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, dir := pathWithCLIDir(tt.path, tt.bin)
			if got != tt.want || dir != tt.wantDir {
				t.Errorf("pathWithCLIDir(%q, %q) = %q, %q; want %q, %q", tt.path, tt.bin, got, dir, tt.want, tt.wantDir)
			}
		})
	}
}

func TestPathWithCLIDirRelative(t *testing.T) {
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	got, dir := pathWithCLIDir("/bin", "bin/code-foundry")
	if want := filepath.Join(wd, "bin"); dir != want || got != want+":/bin" {
		t.Errorf("got %q, %q; want dir %q", got, dir, want)
	}
}

func TestAddCLIToPath(t *testing.T) {
	t.Setenv("PATH", "/usr/bin:/bin")
	t.Setenv(paths.EnvBin, "/opt/cf/code-foundry")
	var logs bytes.Buffer
	if dir := addCLIToPath(slog.New(slog.NewTextHandler(&logs, nil))); dir != "/opt/cf" {
		t.Errorf("added %q", dir)
	}
	if got := os.Getenv("PATH"); got != "/opt/cf:/usr/bin:/bin" {
		t.Errorf("PATH = %q", got)
	}
	// A second call (a daemon restart in-process) adds nothing.
	if dir := addCLIToPath(slog.New(slog.NewTextHandler(&logs, nil))); dir != "" {
		t.Errorf("second call added %q", dir)
	}
	if got := os.Getenv("PATH"); got != "/opt/cf:/usr/bin:/bin" {
		t.Errorf("PATH after second call = %q", got)
	}
}
