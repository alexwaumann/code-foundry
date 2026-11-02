package thread

import (
	"slices"
	"time"

	"github.com/alexwaumann/code-foundry/internal/claudestream"
)

// cdEchoWait is how long after an ok set_cwd its echo may start. The echo's first line
// comes before the answer (below), so it is read at once; the bound only keeps a Claude
// that writes no echo from taking a later command of its own (a background task's
// turn) for it.
const cdEchoWait = 5 * time.Second

// cdEcho follows the echo Claude writes for a set_cwd it accepted (a move or a Run in,
// streamCd). Claude Code 2.1.316 runs the change as a command of its own and writes
// (testdata/set-cwd.jsonl):
//
//	system/ui_invalidate
//	command_lifecycle started   (its own command_uuid, before the control_response)
//	control_response            ok, transcript_relocated
//	system/init                 the new cwd
//	result                      success, num_turns 0, result ""
//	command_lifecycle completed
//
// No turn ran. Read as one, the started makes the thread busy, so the empty result ends
// a "turn": a 0.0 s turn end in the timeline, "finished" needs attention, wakes and
// thread wait settled. onStreamEvent drops the echo's lifecycle lines and its result
// instead; the init goes through (Claude's MCP servers for the new cwd, mcp.go), as the
// ui_invalidate does (no frame the store reads).
//
// A message sent meanwhile is not swallowed: Claude runs commands in order, so the
// echo's lines come before that message's turn, and a started with a message's own uuid
// (sent) ends the wait for an echo. All of it runs on the runner goroutine.
type cdEcho struct {
	// owedAt: an ok set_cwd's answer came then, and its echo has not started yet.
	owedAt time.Time
	// cmd is the echo's command_uuid once its started came; result: its result came.
	cmd    string
	result bool
	// msgs are the uuids of the messages sent since the set_cwd.
	msgs []string
}

// expect: Claude accepted a set_cwd at now and writes its echo next.
func (c *cdEcho) expect(now time.Time) { *c = cdEcho{owedAt: now} }

// sent records a message that went to Claude while an echo is owed.
func (c *cdEcho) sent(uuid string) {
	if !c.owedAt.IsZero() {
		c.msgs = append(c.msgs, uuid)
	}
}

// drop reports whether ev is part of the echo, which the thread does not see.
func (c *cdEcho) drop(ev claudestream.Event, now time.Time) bool {
	switch e := ev.(type) {
	case *claudestream.CommandLifecycle:
		if c.cmd != "" && e.CommandUUID == c.cmd {
			if e.State != "started" && e.State != "queued" {
				*c = cdEcho{} // completed (or cancelled, failed): the echo is over
			}
			return true
		}
		if e.State != "started" {
			return false
		}
		if c.cmd != "" {
			c.result = true // another command runs: a result from now on is its own
			return false
		}
		if c.owedAt.IsZero() {
			return false
		}
		if slices.Contains(c.msgs, e.CommandUUID) || now.Sub(c.owedAt) > cdEchoWait {
			*c = cdEcho{} // a turn of ours, or no echo came: nothing to drop
			return false
		}
		c.owedAt, c.cmd, c.msgs = time.Time{}, e.CommandUUID, nil
		return true
	case *claudestream.Result:
		if c.cmd != "" && !c.result {
			c.result = true
			return true
		}
		if !c.owedAt.IsZero() {
			*c = cdEcho{} // a result with no echo started is a turn's own
		}
	}
	return false
}
