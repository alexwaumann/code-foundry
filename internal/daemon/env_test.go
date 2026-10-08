package daemon

import (
	"bytes"
	"log/slog"
	"os"
	"slices"
	"strings"
	"testing"
)

func TestInheritedClaudeVars(t *testing.T) {
	tests := []struct {
		name    string
		environ []string
		want    []string
	}{
		{"none", []string{"PATH=/bin", "HOME=/h", "CLAUDE_CONFIG_DIR=/c", "ANTHROPIC_API_KEY=k"}, nil},
		{"session vars", []string{
			"CLAUDECODE=1", "CLAUDE_CODE_CHILD_SESSION=1", "CLAUDE_CODE_ENTRYPOINT=sdk-ts", "CLAUDE_CODE_SESSION_ID=x",
			"CLAUDE_PID=1", "CLAUDE_EFFORT=high", "CLAUDE_AGENT_SDK_VERSION=0.3", "PATH=/bin", "CLAUDE_CODE_MESSAGING_TOKEN=",
		}, []string{
			"CLAUDECODE", "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_ENTRYPOINT",
			"CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_SESSION_ID", "CLAUDE_EFFORT", "CLAUDE_PID",
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
	t.Setenv("CLAUDE_CODE_CHILD_SESSION", "1")
	t.Setenv("CLAUDE_CODE_MESSAGING_TOKEN", "secret-token")
	t.Setenv("CLAUDE_CONFIG_DIR", "/keep")
	var buf bytes.Buffer
	removed := scrubClaudeEnv(slog.New(slog.NewTextHandler(&buf, nil)))
	for _, k := range []string{"CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_MESSAGING_TOKEN"} {
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
	if !strings.Contains(log, "CLAUDE_CODE_CHILD_SESSION") {
		t.Errorf("log does not name the removed vars: %s", log)
	}
	if strings.Contains(log, "secret-token") {
		t.Errorf("log leaks a value: %s", log)
	}
}
