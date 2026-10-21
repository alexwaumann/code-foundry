package main

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/client"
	"github.com/alexwaumann/code-foundry/internal/paths"
)

// testCLIRefusesEmptyIDs: an explicitly empty id never falls back to the thread the
// CLI runs in: `--id "$CHILD"` with CHILD unset archived, removed or interrupted the
// caller itself. TestCLIAgainstDaemon runs it on its daemon (one daemon start per test
// binary is slow enough under load).
func testCLIRefusesEmptyIDs(t *testing.T, c *client.Client) {
	tests := []struct {
		name       string
		args       []string
		wantErr    error
		wantStderr string
	}{
		{"empty --id", []string{"thread", "archive", "--id", ""}, errUsage,
			"code-foundry thread.archive: --id is empty; leave it out to mean the active thread"},
		{"blank --id", []string{"thread", "interrupt", "--id", "  "}, errUsage, "--id is empty"},
		{"empty --ids", []string{"thread", "remove", "--ids=", "--yes"}, errUsage, "--ids is empty; give an id"},
		{"an empty positional id", []string{"thread", "get", ""}, errUsage, "--id is empty"},
		{"ids of only commas", []string{"thread", "archive", "--ids", ",", "--yes"}, errUsage, "ids holds no thread ids"},
		{"--created-by= still opts out", []string{"thread", "new", "--created-by="}, errUsage, "a worktree, project, or workspace is required"},
		{"no --id at all is not the caller's own thread", []string{"thread", "archive", "--yes"}, errUsage,
			"not archiving the thread this runs in (s-000000000001) without --id"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			cl := &cli{
				stdout: &stdout, stderr: &stderr,
				connect: func(context.Context) (*client.Client, error) { return c, nil },
				getwd:   func() (string, error) { return "/work", nil },
				getenv:  func(k string) string { return map[string]string{paths.EnvThread: "s-000000000001"}[k] },
			}
			err := cl.dispatch(context.Background(), tt.args)
			if !errors.Is(err, tt.wantErr) || !strings.Contains(stderr.String(), tt.wantStderr) {
				t.Fatalf("err = %v, stderr %q; want %v and %q", err, stderr.String(), tt.wantErr, tt.wantStderr)
			}
		})
	}
}
