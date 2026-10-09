package gh

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParseTokenOutput(t *testing.T) {
	exit1 := &exec.ExitError{}
	tests := []struct {
		name           string
		stdout, stderr string
		runErr         error
		want           string
		wantMsg        string
	}{
		{"ok", "gho_abc123\n", "", nil, "gho_abc123", ""},
		// gh 2.83.2 when logged out.
		{"logged out", "", "no oauth token found for github.com\n", exit1, "", "no oauth token found for github.com"},
		{"gh prefix stripped", "", "gh: something broke\nmore", exit1, "", "something broke"},
		{"empty output", "", "", nil, "", "printed no token"},
		{"garbage", "two words\n", "", nil, "", "printed no token"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseTokenOutput([]byte(tt.stdout), []byte(tt.stderr), tt.runErr)
			if tt.want != "" {
				if err != nil || got != tt.want {
					t.Errorf("got %q, %v", got, err)
				}
				return
			}
			if got != "" || !errors.Is(err, ErrNoToken) || !contains(err.Error(), tt.wantMsg) || contains(err.Error(), "more") {
				t.Errorf("got %q, err %v; want ErrNoToken with %q", got, err, tt.wantMsg)
			}
		})
	}
}

func contains(s, sub string) bool { return strings.Contains(s, sub) }

// fakeGh writes an executable shell script standing in for gh.
func fakeGh(t *testing.T, script string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "gh")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+script), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestGhToken(t *testing.T) {
	ctx := context.Background()
	tests := []struct {
		name    string
		path    func(t *testing.T) string
		timeout time.Duration
		want    string
		wantErr error
	}{
		{"argv and env", func(t *testing.T) string {
			return fakeGh(t, `[ "$*" = "auth token --hostname github.com" ] || exit 9
[ "$GH_PROMPT_DISABLED" = 1 ] || exit 9
echo tok123`)
		}, 0, "tok123", nil},
		{"logged out", func(t *testing.T) string {
			return fakeGh(t, "echo 'no oauth token found for github.com' >&2; exit 1")
		}, 0, "", ErrNoToken},
		{"missing binary", func(t *testing.T) string { return filepath.Join(t.TempDir(), "nope") }, 0, "", ErrNoToken},
		{"hangs", func(t *testing.T) string { return fakeGh(t, "exec sleep 5") }, 100 * time.Millisecond, "", ErrNoToken},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			start := time.Now()
			got, err := GhToken{Path: tt.path(t), Timeout: tt.timeout}.Token(ctx)
			if got != tt.want || (tt.wantErr == nil) != (err == nil) || (tt.wantErr != nil && !errors.Is(err, tt.wantErr)) {
				t.Errorf("got %q, %v; want %q, %v", got, err, tt.want, tt.wantErr)
			}
			if time.Since(start) > 3*time.Second {
				t.Errorf("took %v", time.Since(start))
			}
		})
	}

	t.Run("caller cancels", func(t *testing.T) {
		cctx, cancel := context.WithCancel(ctx)
		cancel()
		_, err := GhToken{Path: fakeGh(t, "exec sleep 5")}.Token(cctx)
		if !errors.Is(err, context.Canceled) || errors.Is(err, ErrNoToken) {
			t.Errorf("err = %v, want context.Canceled", err)
		}
	})
}
