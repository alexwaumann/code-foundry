package claudestatus

import (
	"reflect"
	"testing"
)

func TestParseTranscriptLine(t *testing.T) {
	tests := []struct {
		name string
		line string
		want transcriptEvent
	}{
		// Lines below are from testdata (sanitized: long fields dropped, text truncated).
		{"prompt", `{"type":"user","isSidechain":false,"origin":{"kind":"human"},"promptSource":"typed","message":{"role":"user","content":"Say hi."}}`,
			transcriptEvent{kind: trPrompt}},
		{"api error", `{"type":"assistant","isSidechain":false,"isApiErrorMessage":true,"error":"model_not_found","apiErrorStatus":404,"message":{"role":"assistant","stop_reason":"stop_sequence","content":[{"type":"text","text":"There's an issue with the selected model"}]}}`,
			transcriptEvent{kind: trAssistant, stopReason: "stop_sequence", apiError: "model_not_found"}},
		{"turn end", `{"type":"system","subtype":"turn_duration","isSidechain":false,"isMeta":false,"durationMs":324}`,
			transcriptEvent{kind: trTurnEnd}},
		{"interrupted partial", `{"type":"assistant","isSidechain":false,"message":{"role":"assistant","stop_reason":null,"content":[{"type":"text","text":"**The Blinking Cursor**"}]}}`,
			transcriptEvent{kind: trAssistant}},
		{"interrupt marker", `{"type":"user","isSidechain":false,"interruptedMessageId":"msg_011","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]}}`,
			transcriptEvent{kind: trInterrupted}},
		{"denied tool", `{"type":"user","isSidechain":false,"message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]}}`,
			transcriptEvent{kind: trInterrupted}},
		{"tool use", `{"type":"assistant","isSidechain":false,"message":{"role":"assistant","stop_reason":"tool_use","content":[{"type":"tool_use","id":"toolu_01J","name":"Bash"}]}}`,
			transcriptEvent{kind: trAssistant, stopReason: "tool_use", toolUses: []toolUse{{"toolu_01J", "Bash"}}}},
		{"tool result", `{"type":"user","isSidechain":false,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01J"}]}}`,
			transcriptEvent{kind: trToolResult, toolResults: []string{"toolu_01J"}}},
		{"end turn", `{"type":"assistant","isSidechain":false,"message":{"role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"done"}]}}`,
			transcriptEvent{kind: trAssistant, stopReason: "end_turn"}},
		// Real records have more fields and spaces are irrelevant.
		{"spaced json", `{"parentUuid": null, "type": "user", "message": {"role": "user", "content": "hi"}, "uuid": "c5"}`,
			transcriptEvent{kind: trPrompt}},
		{"sidechain ignored", `{"type":"assistant","isSidechain":true,"message":{"role":"assistant","stop_reason":"end_turn","content":[]}}`,
			transcriptEvent{}},
		{"meta user ignored", `{"type":"user","isMeta":true,"message":{"role":"user","content":"Caveat: ..."}}`,
			transcriptEvent{}},
		{"slash command ignored", `{"type":"user","message":{"role":"user","content":"<command-name>/model</command-name>"}}`,
			transcriptEvent{}},
		{"attachment ignored", `{"type":"attachment","attachment":{"type":"skill_listing"}}`, transcriptEvent{}},
		{"other system ignored", `{"type":"system","subtype":"api_error","level":"error"}`, transcriptEvent{}},
		{"snapshot ignored", `{"type":"file-history-snapshot","snapshot":{}}`, transcriptEvent{}},
		{"invalid json", `{"type":"user",`, transcriptEvent{}},
		{"empty", ``, transcriptEvent{}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := parseTranscriptLine([]byte(tt.line)); !reflect.DeepEqual(got, tt.want) {
				t.Errorf("got %+v, want %+v", got, tt.want)
			}
		})
	}
}
