package daemon

import (
	"io"
	"log/slog"
	"testing"
	"time"
)

// The idle-stop development aids (CODE_FOUNDRY_IDLE_GRACE, CODE_FOUNDRY_IDLE_CHECK):
// a valid positive duration, else 0 (the session store's default).
func TestEnvDuration(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	tests := []struct {
		value string
		want  time.Duration
	}{
		{"", 0},
		{"20s", 20 * time.Second},
		{"1m30s", 90 * time.Second},
		{"soon", 0},
		{"-5s", 0},
		{"0s", 0},
	}
	for _, tt := range tests {
		t.Run(tt.value, func(t *testing.T) {
			t.Setenv("CF_TEST_DURATION", tt.value)
			if got := envDuration(log, "CF_TEST_DURATION"); got != tt.want {
				t.Errorf("envDuration(%q) = %s, want %s", tt.value, got, tt.want)
			}
		})
	}
}
