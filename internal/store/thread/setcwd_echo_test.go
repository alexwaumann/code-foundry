package thread

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/claudestream"
)

// echoLines reads the captured set_cwd echo (Claude Code 2.1.316) without its
// control_response, which the conn takes and the runner never sees as an event.
func echoLines(t *testing.T) []string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "claudestream", "testdata", "set-cwd.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, l := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		if !strings.Contains(l, `"type":"control_response"`) {
			out = append(out, l)
		}
	}
	return out
}

// A message's own lines: its command's lifecycle and its turn's result.
func msgLines(uuid string) []string {
	return []string{
		`{"type":"command_lifecycle","command_uuid":"` + uuid + `","state":"started"}`,
		`{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"ok"}`,
		`{"type":"command_lifecycle","command_uuid":"` + uuid + `","state":"completed"}`,
	}
}

func TestCdEchoDrop(t *testing.T) {
	echo := echoLines(t)
	// The capture: ui_invalidate, started, init, result, completed.
	echoDrops := []bool{false, true, false, true, true}
	msg := msgLines("m-1")
	msgDrops := []bool{false, false, false}
	tests := []struct {
		name   string
		expect bool          // an ok set_cwd came
		send   string        // a message sent right after it (before its echo is read)
		late   time.Duration // the echo is read this long after the answer
		lines  []string
		want   []bool
	}{
		{"the echo", true, "", 0, echo, echoDrops},
		{"the echo, then a message's turn", true, "", 0, append(append([]string{}, echo...), msg...), append(append([]bool{}, echoDrops...), msgDrops...)},
		{"a message sent before the echo is read", true, "m-1", 0, append(append([]string{}, echo...), msg...), append(append([]bool{}, echoDrops...), msgDrops...)},
		{"no echo: a message's turn", true, "m-1", 0, msg, msgDrops},
		{"no echo: a bare turn's result", true, "", 0, msg[1:], []bool{false, false}},
		{"no set_cwd: a command of Claude's own", false, "", 0, echo, []bool{false, false, false, false, false}},
		{"an echo that starts too late", true, "", cdEchoWait + time.Second, echo, []bool{false, false, false, false, false}},
		{"a command starting inside the echo", true, "", 0,
			[]string{echo[1], msg[0], msg[1], echo[4]},
			[]bool{true, false, false, true}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var c cdEcho
			at := time.Unix(1000, 0)
			if tt.expect {
				c.expect(at)
			}
			if tt.send != "" {
				c.sent(tt.send)
			}
			for i, l := range tt.lines {
				if got := c.drop(claudestream.Parse([]byte(l)), at.Add(tt.late)); got != tt.want[i] {
					t.Errorf("line %d (%.80s): drop = %v, want %v", i, l, got, tt.want[i])
				}
			}
			if c.cmd != "" || !c.owedAt.IsZero() {
				t.Errorf("echo state left behind: %+v", c)
			}
		})
	}
}
