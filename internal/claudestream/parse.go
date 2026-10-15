package claudestream

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// envelope is what Parse reads first to pick the concrete type.
type envelope struct {
	Type    string `json:"type"`
	Subtype string `json:"subtype"`
}

// Parse decodes one stdout line. It never fails: a line that is not JSON, or a type it
// does not model, is an *Unknown carrying the raw bytes (and Err for bad JSON). A known
// type whose fields fail to decode is an *Unknown with Err too. control_request and
// control_response lines are returned as *controlRequestLine / *controlResponseLine for
// the Conn; callers outside the package never see them.
func Parse(line []byte) Event {
	raw := json.RawMessage(bytes.Clone(bytes.TrimSpace(line)))
	var env envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return &Unknown{base: base{Raw: raw}, Err: fmt.Errorf("claudestream: not JSON: %w", err)}
	}
	var ev interface {
		Event
		setRaw(json.RawMessage)
	}
	switch env.Type {
	case "system":
		switch env.Subtype {
		case "init":
			ev = &Init{}
		case "status":
			ev = &Status{}
		case "permission_denied":
			ev = &PermissionDenied{}
		case "api_retry":
			ev = &APIRetry{}
		case "compact_boundary":
			ev = &CompactBoundary{}
		case "thinking_tokens":
			ev = &ThinkingTokens{}
		case "commands_changed":
			ev = &CommandsChanged{}
		case TaskStarted, TaskProgress, TaskUpdated, TaskNotification:
			ev = &Task{}
		}
	case "assistant":
		ev = &Assistant{}
	case "user":
		ev = &User{}
	case "stream_event":
		ev = &StreamEvent{}
	case "result":
		ev = &Result{}
	case "rate_limit_event":
		ev = &RateLimit{}
	case "command_lifecycle":
		ev = &CommandLifecycle{}
	case "conversation_reset":
		ev = &ConversationReset{}
	case "control_cancel_request":
		ev = &ControlCancel{}
	case "control_request":
		ev = &controlRequestLine{}
	case "control_response":
		ev = &controlResponseLine{}
	}
	if ev == nil {
		return &Unknown{base: base{Raw: raw, Type: env.Type, Subtype: env.Subtype}}
	}
	if err := json.Unmarshal(raw, ev); err != nil {
		return &Unknown{base: base{Raw: raw, Type: env.Type, Subtype: env.Subtype}, Err: fmt.Errorf("claudestream: decode %s/%s: %w", env.Type, env.Subtype, err)}
	}
	ev.setRaw(raw)
	return ev
}

func (b *base) setRaw(raw json.RawMessage) { b.Raw = raw }

// controlRequestLine is an inbound control_request (can_use_tool, or one we do not
// support).
type controlRequestLine struct {
	base
	RequestID string          `json:"request_id"`
	Request   json.RawMessage `json:"request"`
}

// controlResponseLine answers one of our requests.
type controlResponseLine struct {
	base
	Response struct {
		Subtype   string          `json:"subtype"` // success | error
		RequestID string          `json:"request_id"`
		Response  json.RawMessage `json:"response,omitempty"`
		Error     string          `json:"error,omitempty"`
	} `json:"response"`
}
