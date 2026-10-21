package thread

import (
	"strings"
	"testing"
	"time"
)

// A new thread whose claude never comes up keeps its first prompt: the timeline has
// the user's message, then the error, then the daemon's turn end, also after a restart
// (the items are persisted), so the user can copy or resend it.
func TestCreateStartFailureKeepsThePrompt(t *testing.T) {
	tests := []struct {
		name     string
		env      func(t *testing.T) *env
		wantText string
	}{
		{
			name:     "claude exits before its handshake",
			env:      func(t *testing.T) *env { return newFixtureEnv(t, "no-such-fixture") },
			wantText: "Claude did not start: exit code 2: fake claude",
		},
		{
			name: "claude never answers its handshake",
			env: func(t *testing.T) *env {
				gate := initGate(t) // never opened
				return newFixtureEnvAt(t, fixturePath("text-table"), []string{"CF_FAKE_CLAUDE_INIT_GATE=" + gate.path},
					func(o *Options) { o.StartTimeout = 500 * time.Millisecond })
			},
			wantText: "Claude did not start: no answer to the initialize handshake",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := tt.env(t)
			s := e.create(CreateOptions{InitialPrompt: "my long carefully written prompt"})
			e.waitFor(s.ID, "the failed start", func(s Thread) bool {
				return s.State == StateDisconnected && s.StatusReason == ReasonStartFailed
			})
			check := func(when string) {
				items := e.items(s.ID).Items
				if len(items) != 3 || items[0].Kind != KindUserMessage || items[0].Text != "my long carefully written prompt" ||
					items[1].Kind != KindError || !strings.HasPrefix(items[1].Text, tt.wantText) ||
					items[2].ID != synthTurnPrefix+items[0].ID || items[0].Queued {
					t.Errorf("%s: want the prompt, %q, then the turn end:\n%s", when, tt.wantText, describeItems(items))
				}
			}
			check("now")
			e.restart()
			check("after a restart")
		})
	}
}
