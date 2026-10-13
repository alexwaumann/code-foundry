package session

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
)

// Two api_retry frames (the shape of Claude Code 2.1.296's SDKAPIRetryMessage; a 429 is
// hard to capture) spliced into the text-table capture after "status requesting".
const (
	retryLine1 = `{"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,"retry_delay_ms":500,"error_status":429,"error":"rate_limit","uuid":"r1","session_id":"1a2bcb16-f24e-4fbb-936a-3444cd9e2c85"}`
	retryLine2 = `{"type":"system","subtype":"api_retry","attempt":2,"max_retries":10,"retry_delay_ms":20000,"error_status":429,"error":"rate_limit","uuid":"r2","session_id":"1a2bcb16-f24e-4fbb-936a-3444cd9e2c85"}`
)

// retryFixture writes a capture whose first turn is text-table with the two retries
// before its response, and whose second turn is a turn start followed by one retry and
// nothing else (the fake replays it and waits).
func retryFixture(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile(fixturePath("text-table"))
	if err != nil {
		t.Fatal(err)
	}
	var turn1, preamble []string
	requesting := false
	for _, l := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		turn1 = append(turn1, l)
		if !requesting {
			preamble = append(preamble, l) // up to and including "status requesting"
		}
		if strings.Contains(l, `"subtype":"status","status":"requesting"`) {
			turn1 = append(turn1, retryLine1, retryLine2)
			requesting = true
		}
	}
	turn2 := append(append([]string{}, preamble...), retryLine1)
	p := filepath.Join(t.TempDir(), "api-retry.jsonl")
	if err := os.WriteFile(p, []byte(strings.Join(append(turn1, turn2...), "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

// A thread's Retry follows the stream: set by an api_retry frame (published, the due
// time from the frame's clock), replaced by the next one, cleared by the next frame of
// any other kind, and cleared when the process ends.
func TestAPIRetryFollowsStream(t *testing.T) {
	now := time.Date(2026, 10, 13, 9, 0, 0, 0, time.UTC)
	re := newFixtureEnvAt(t, retryFixture(t), nil, func(o *Options) { o.Now = func() time.Time { return now } })
	sub := bus.Subscribe[Event](re.bus, 256)
	defer sub.Close()
	s := re.create(CreateOptions{InitialPrompt: "a table please"})
	done := re.waitFor(s.ID, "the first turn's result", func(s Session) bool { return s.ContextTokens > 0 })
	if done.Retry != nil {
		t.Fatalf("after the turn: Retry = %+v, want nil", done.Retry)
	}
	// The published row carried both retries in order, then none.
	var seen []int
	deadline := time.After(2 * time.Second)
	for cleared := false; !cleared; {
		select {
		case ev := <-sub.C():
			u, ok := ev.(Updated)
			if !ok || u.Session.ID != s.ID {
				continue
			}
			if r := u.Session.Retry; r != nil {
				if len(seen) == 0 || seen[len(seen)-1] != r.Attempt {
					seen = append(seen, r.Attempt)
				}
				if r.Attempt == 2 && (r.MaxRetries != 10 || r.Status != 429 || r.Error != "rate_limit" || !r.RetryAt.Equal(now.Add(20*time.Second))) {
					t.Errorf("retry 2 = %+v", r)
				}
			} else if len(seen) > 0 {
				cleared = true
			}
		case <-deadline:
			t.Fatalf("published retries %v, never cleared", seen)
		}
	}
	if len(seen) != 2 || seen[0] != 1 || seen[1] != 2 {
		t.Errorf("published attempts %v, want [1 2]", seen)
	}

	// The second turn stalls on a retry; the process ending clears it.
	if _, err := re.m.Send(re.ctx(), s.ID, Message{Text: "again"}); err != nil {
		t.Fatal(err)
	}
	re.waitFor(s.ID, "the second turn's retry", func(s Session) bool { return s.Retry != nil && s.Retry.Attempt == 1 })
	re.exit(s.ID, 0)
	re.waitFor(s.ID, "the exit clearing the retry", func(s Session) bool { return s.State == StateDisconnected && s.Retry == nil })
}
