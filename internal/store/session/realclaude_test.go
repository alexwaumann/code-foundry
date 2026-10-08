package session

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/awaumann/code-foundry/internal/db"
	"github.com/awaumann/code-foundry/internal/store/terminal"
)

// TestRealClaudeTrustDialogFallback runs the real claude in a never-trusted scratch
// directory with pre-trust disabled, so the on-screen dialog must be answered. Skipped
// unless CF_REAL_CLAUDE=1 (it starts Claude Code and records the folder as trusted in
// ~/.claude.json, which is the point). No prompt is sent, so it uses no tokens.
func TestRealClaudeTrustDialogFallback(t *testing.T) {
	if os.Getenv("CF_REAL_CLAUDE") != "1" {
		t.Skip("CF_REAL_CLAUDE != 1")
	}
	// Like the daemon's scrub: no inherited Claude session variables.
	for _, kv := range os.Environ() {
		k, _, _ := strings.Cut(kv, "=")
		if k == "CLAUDECODE" || strings.HasPrefix(k, "CLAUDE_CODE_") || k == "CLAUDE_PID" || k == "CLAUDE_EFFORT" {
			t.Setenv(k, "")
			_ = os.Unsetenv(k)
		}
	}
	dir, err := os.MkdirTemp("/tmp", "cf2a-dialog-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	d, err := db.Open(context.Background(), filepath.Join(t.TempDir(), "cf.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = d.Close() }()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	terms := terminal.New(terminal.Options{Logger: log})
	defer func() { _ = terms.Close(context.Background()) }()
	m, err := New(context.Background(), Options{DB: d, Terminals: terms, Log: log, DisablePreTrust: true})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = m.Shutdown(context.Background()) }()

	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	start := time.Now()
	s, err := m.Create(ctx, CreateOptions{WorktreePath: dir, Model: "haiku", Effort: "low"})
	if err != nil {
		t.Fatal(err)
	}
	var connectedAfter time.Duration
	for {
		got, _ := m.Get(ctx, s.ID)
		if got.State == StateConnected {
			connectedAfter = time.Since(start)
			break
		}
		if time.Since(start) > 20*time.Second {
			screen, _ := terms.ScreenText(ctx, got.TerminalID)
			t.Fatalf("not connected after 20s: %+v\n%s", got, screen)
		}
		time.Sleep(20 * time.Millisecond)
	}
	got, _ := m.Get(ctx, s.ID)
	// CONNECTED fires on the title/alt-screen switch, before Claude draws its prompt.
	var screen string
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
		if screen, err = terms.ScreenText(ctx, got.TerminalID); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(screen, "❯") {
			break
		}
	}
	if parseTrustDialog(screen).Visible || !strings.Contains(screen, "❯") {
		t.Fatalf("screen after connect:\n%s", screen)
	}
	t.Logf("trust dialog answered; CONNECTED after %v", connectedAfter.Round(time.Millisecond))

	closeStart := time.Now()
	if err := m.Close(ctx, s.ID); err != nil {
		t.Fatal(err)
	}
	got, _ = m.Get(ctx, s.ID)
	if got.DisconnectReason != ReasonClosed || got.ExitCode != 0 {
		t.Errorf("after close: %+v", got)
	}
	t.Logf("graceful close took %v (exit %d)", time.Since(closeStart).Round(time.Millisecond), got.ExitCode)
}
