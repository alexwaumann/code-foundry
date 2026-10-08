package claudestatus

import (
	"bytes"
	"encoding/json"
	"strings"
)

// transcriptEvent is the status-relevant content of one JSONL transcript record.
type transcriptEvent struct {
	kind transcriptKind

	toolUses    []toolUse // assistant tool_use blocks (id, name)
	toolResults []string  // user tool_result tool_use_ids
	stopReason  string    // assistant stop_reason ("" while streaming/interrupted)
	apiError    string    // assistant isApiErrorMessage: the error code or text
}

type toolUse struct{ id, name string }

type transcriptKind uint8

const (
	trIgnored     transcriptKind = iota
	trPrompt                     // a user prompt: a turn starts
	trToolResult                 // user record carrying tool_result blocks
	trAssistant                  // assistant message (text, thinking, tool_use)
	trInterrupted                // "[Request interrupted by user...]"
	trTurnEnd                    // system turn_duration
)

// transcriptRecord is the subset of a ~/.claude/projects/<slug>/<id>.jsonl record that
// status detection reads. Observed record types (2.1.294): user, assistant, system
// (subtype turn_duration), attachment, mode, permission-mode, atis-latch,
// file-history-snapshot, file-history-delta, last-prompt, ai-title, agent-name,
// cost-state. Only the first three matter.
type transcriptRecord struct {
	Type                 string             `json:"type"`
	Subtype              string             `json:"subtype"`
	IsSidechain          bool               `json:"isSidechain"`
	IsMeta               bool               `json:"isMeta"`
	IsAPIErrorMessage    bool               `json:"isApiErrorMessage"`
	Error                string             `json:"error"`
	InterruptedMessageID string             `json:"interruptedMessageId"`
	Message              *transcriptMessage `json:"message"`
}

type transcriptMessage struct {
	Role       string          `json:"role"`
	StopReason *string         `json:"stop_reason"`
	Content    json.RawMessage `json:"content"`
}

type contentBlock struct {
	Type      string `json:"type"`
	ID        string `json:"id"`
	Name      string `json:"name"`
	ToolUseID string `json:"tool_use_id"`
	Text      string `json:"text"`
}

var (
	quotedUser      = []byte(`"user"`)
	quotedAssistant = []byte(`"assistant"`)
	quotedSystem    = []byte(`"system"`)
)

// parseTranscriptLine classifies one JSONL line. Records other than user, assistant,
// and system are skipped cheaply when the line cannot be one of them.
func parseTranscriptLine(line []byte) transcriptEvent {
	if !bytes.Contains(line, quotedUser) && !bytes.Contains(line, quotedAssistant) &&
		!bytes.Contains(line, quotedSystem) {
		return transcriptEvent{}
	}
	var rec transcriptRecord
	if err := json.Unmarshal(line, &rec); err != nil {
		return transcriptEvent{}
	}
	if rec.IsSidechain {
		return transcriptEvent{}
	}
	switch rec.Type {
	case "system":
		if rec.Subtype == "turn_duration" {
			return transcriptEvent{kind: trTurnEnd}
		}
	case "assistant":
		ev := transcriptEvent{kind: trAssistant}
		if rec.Message == nil {
			return ev
		}
		if rec.Message.StopReason != nil {
			ev.stopReason = *rec.Message.StopReason
		}
		if rec.IsAPIErrorMessage {
			ev.apiError = rec.Error
			if ev.apiError == "" {
				ev.apiError = "api error"
			}
		}
		blocks, _ := decodeBlocks(rec.Message.Content)
		for _, b := range blocks {
			if b.Type == "tool_use" {
				ev.toolUses = append(ev.toolUses, toolUse{id: b.ID, name: b.Name})
			}
		}
		return ev
	case "user":
		if rec.InterruptedMessageID != "" {
			return transcriptEvent{kind: trInterrupted}
		}
		if rec.Message == nil {
			return transcriptEvent{}
		}
		blocks, text := decodeBlocks(rec.Message.Content)
		var results []string
		for _, b := range blocks {
			if b.Type == "tool_result" {
				results = append(results, b.ToolUseID)
			}
		}
		if strings.HasPrefix(text, "[Request interrupted by user") {
			return transcriptEvent{kind: trInterrupted, toolResults: results}
		}
		if len(results) > 0 {
			return transcriptEvent{kind: trToolResult, toolResults: results}
		}
		if rec.IsMeta || isLocalCommand(text) {
			return transcriptEvent{}
		}
		return transcriptEvent{kind: trPrompt}
	}
	return transcriptEvent{}
}

// decodeBlocks decodes message content, which is either a string or an array of
// blocks. text is the string content, or the first text block.
func decodeBlocks(raw json.RawMessage) (blocks []contentBlock, text string) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return nil, ""
	}
	if raw[0] == '"' {
		_ = json.Unmarshal(raw, &text)
		return nil, text
	}
	if err := json.Unmarshal(raw, &blocks); err != nil {
		return nil, ""
	}
	for _, b := range blocks {
		if b.Type == "text" {
			return blocks, b.Text
		}
	}
	return blocks, ""
}

// isLocalCommand matches user records Claude writes for slash commands and their
// output; they do not start a model turn.
func isLocalCommand(text string) bool {
	t := strings.TrimSpace(text)
	return strings.HasPrefix(t, "<command-name>") || strings.HasPrefix(t, "<command-message>") ||
		strings.HasPrefix(t, "<local-command-") || strings.HasPrefix(t, "<bash-input>") ||
		strings.HasPrefix(t, "<bash-stdout>")
}
