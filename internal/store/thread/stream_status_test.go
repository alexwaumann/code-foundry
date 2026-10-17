package thread

import (
	"testing"

	"github.com/alexwaumann/code-foundry/internal/claudestream"
)

func TestStreamStatus(t *testing.T) {
	str := func(s string) *string { return &s }
	perm := Item{Kind: KindPermission, Request: &Request{ToolName: "Write", Description: "hello.txt"}}
	quest := Item{Kind: KindQuestion, Request: &Request{ToolName: "AskUserQuestion", InputJSON: `{"questions":[{"question":"Red or blue?"}]}`}}
	type step func(d *streamStatus)
	ev := func(e claudestream.Event) step { return func(d *streamStatus) { d.event(e) } }
	result := func(js string) step { return ev(claudestream.Parse([]byte(`{"type":"result",` + js + `}`))) }
	init := func(d *streamStatus) { d.initialized() }
	sent := func(d *streamStatus) { d.sent(true) }
	ack := func(d *streamStatus) { d.Acknowledge() }
	ask := func(id string, it Item) step { return func(d *streamStatus) { d.ask(id, it) } }
	resolved := func(id string) step { return func(d *streamStatus) { d.resolved(id) } }
	tests := []struct {
		name       string
		steps      []step
		want       Status
		reason     string
		atPrompt   bool
		wantUnseen bool
	}{
		{"before initialize", nil, StatusUnknown, "starting", false, false},
		{"initialized", []step{init}, StatusIdle, "at prompt", true, false},
		{"sent", []step{init, sent}, StatusBusy, "working", false, false},
		{"turn Claude started itself", []step{init, ev(&claudestream.Status{Status: str("requesting")})}, StatusBusy, "working", false, false},
		{"finished unseen", []step{init, sent, result(`"subtype":"success"`)}, StatusNeedsAttention, "finished", true, true},
		{"finished seen", []step{init, sent, result(`"subtype":"success"`), ack}, StatusIdle, "at prompt", true, false},
		{"queued turn keeps busy", []step{init, sent, sent, result(`"subtype":"success","queued_turn_count":1`)}, StatusBusy, "working", false, false},
		{"api error", []step{init, sent, result(`"subtype":"success","is_error":true,"api_error_status":529`)}, StatusNeedsAttention, "error: 529", true, true},
		{"execution error", []step{init, sent, result(`"subtype":"error_max_turns","is_error":true`)}, StatusNeedsAttention, "error: error_max_turns", true, true},
		{"interrupted is seen", []step{init, sent, result(`"subtype":"error_during_execution","is_error":true,"terminal_reason":"aborted_streaming"`)}, StatusIdle, "at prompt", true, false},
		{"permission", []step{init, sent, ask("p1", perm)}, StatusNeedsAttention, "permission: Write hello.txt", false, false},
		{"oldest request first", []step{init, sent, ask("q1", quest), ask("p1", perm)}, StatusNeedsAttention, "question: Red or blue?", false, false},
		{"answered", []step{init, sent, ask("q1", quest), ask("p1", perm), resolved("q1")}, StatusNeedsAttention, "permission: Write hello.txt", false, false},
		{"all answered", []step{init, sent, ask("p1", perm), resolved("p1")}, StatusBusy, "working", false, false},
		{"compacting", []step{init, ev(&claudestream.Status{Status: str("compacting")})}, StatusBusy, "compacting", false, false},
		{"compacted", []step{init, ev(&claudestream.Status{Status: str("compacting")}), ev(&claudestream.Status{CompactResult: "success"})}, StatusIdle, "at prompt", true, false},
		{"compaction failed", []step{init, ev(&claudestream.Status{Status: str("compacting")}), ev(&claudestream.Status{CompactResult: "failed", CompactError: "x"})}, StatusIdle, "at prompt", true, false},
		{"status null ends compacting, not busy", []step{init, sent, ev(&claudestream.Status{Status: str("compacting")}), ev(&claudestream.Status{})}, StatusBusy, "working", false, false},
		{"lifecycle started", []step{init, ev(&claudestream.CommandLifecycle{State: "started"})}, StatusBusy, "working", false, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			d := &streamStatus{}
			for _, s := range tt.steps {
				s(d)
			}
			st, reason := d.Status()
			if st != tt.want || reason != tt.reason || d.AtPrompt() != tt.atPrompt || d.unseen != tt.wantUnseen {
				t.Errorf("got %v %q atPrompt=%v unseen=%v", st, reason, d.AtPrompt(), d.unseen)
			}
		})
	}
}
