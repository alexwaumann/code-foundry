// Package claudestream drives Claude Code headlessly over its stream-json stdio
// protocol (`claude -p --input-format stream-json --output-format stream-json ...`).
// It is pure: it knows the wire format and the control protocol, nothing about
// threads, stores or the GUI. The thread store's runner builds on it.
//
// Wire facts are recorded in docs/notes/rendered-threads-handoff.md §2; the Agent SDK's
// TypeScript types (sdk.d.ts: SDKMessage, SDKControlRequest, PermissionResult, ...) are
// the reference for field names. Every inbound line is parsed into an Event; types and
// subtypes this package does not model come through as *Unknown with the raw JSON, so a
// newer CLI never breaks the reader.
package claudestream

import (
	"encoding/json"
	"errors"
)

// ---- outbound -------------------------------------------------------------------

// UserMessage is one user turn sent on stdin ({"type":"user",...}).
type UserMessage struct {
	// UUID, when set, is echoed back by the CLI (command_lifecycle, result
	// user_message_uuid) so a reply can be bound to its send.
	UUID string
	// Blocks are the content blocks: TextBlock and ImageBlock values.
	Blocks []ContentBlock
}

// ContentBlock is one block of a user message's content.
type ContentBlock struct {
	Type   string       `json:"type"`
	Text   string       `json:"text,omitempty"`
	Source *ImageSource `json:"source,omitempty"`
}

// ImageSource is a base64 image block's source.
type ImageSource struct {
	Type      string `json:"type"` // "base64"
	MediaType string `json:"media_type"`
	Data      string `json:"data"`
}

// TextBlock returns a text content block.
func TextBlock(text string) ContentBlock { return ContentBlock{Type: "text", Text: text} }

// ImageBlock returns a base64 image block; mediaType is image/png, image/jpeg,
// image/gif or image/webp, data the base64 (standard encoding) of the image bytes.
func ImageBlock(mediaType, data string) ContentBlock {
	return ContentBlock{Type: "image", Source: &ImageSource{Type: "base64", MediaType: mediaType, Data: data}}
}

func (m UserMessage) wire() any {
	type msg struct {
		Role    string         `json:"role"`
		Content []ContentBlock `json:"content"`
	}
	type line struct {
		Type            string  `json:"type"`
		UUID            string  `json:"uuid,omitempty"`
		Message         msg     `json:"message"`
		ParentToolUseID *string `json:"parent_tool_use_id"`
	}
	return line{Type: "user", UUID: m.UUID, Message: msg{Role: "user", Content: m.Blocks}}
}

// PermissionResult answers a can_use_tool request (sdk.d.ts PermissionResult).
type PermissionResult struct {
	// Allow selects behavior "allow"; false is "deny".
	Allow bool
	// UpdatedInput replaces the tool's input when allowing (the original input when
	// nil: the CLI requires one). AskUserQuestion is answered with
	// {"questions": ..., "answers": {question: label}}.
	UpdatedInput json.RawMessage
	// UpdatedPermissions are PermissionUpdate values to apply when allowing ("allow for
	// the session": the request's permission_suggestions).
	UpdatedPermissions json.RawMessage
	// Message is the deny reason the model sees.
	Message string
	// Interrupt, with a deny, also ends the turn.
	Interrupt bool
}

func (r PermissionResult) wire(input json.RawMessage) map[string]any {
	if !r.Allow {
		out := map[string]any{"behavior": "deny", "message": r.Message}
		if r.Message == "" {
			out["message"] = "The user denied this tool use."
		}
		if r.Interrupt {
			out["interrupt"] = true
		}
		return out
	}
	in := r.UpdatedInput
	if len(in) == 0 {
		in = input
	}
	if len(in) == 0 {
		in = json.RawMessage(`{}`)
	}
	out := map[string]any{"behavior": "allow", "updatedInput": in}
	if len(r.UpdatedPermissions) > 0 && string(r.UpdatedPermissions) != "null" {
		out["updatedPermissions"] = r.UpdatedPermissions
	}
	return out
}

// ---- inbound --------------------------------------------------------------------

// Event is one parsed stdout line other than a control_response to our own request
// (the Conn resolves those). Concrete types: *Init, *Status, *PermissionDenied,
// *CompactBoundary, *ThinkingTokens, *CommandsChanged, *ConversationReset, *Assistant,
// *User, *StreamEvent, *Result, *RateLimit, *APIRetry, *CommandLifecycle, *Task,
// *BackgroundTasks, *PermissionRequest (an inbound can_use_tool, from a Conn only), *ControlCancel,
// *Unknown.
type Event interface{ RawJSON() json.RawMessage }

// base carries the raw line and the fields every frame may have.
type base struct {
	Raw       json.RawMessage `json:"-"`
	Type      string          `json:"type"`
	Subtype   string          `json:"subtype,omitempty"`
	UUID      string          `json:"uuid,omitempty"`
	SessionID string          `json:"session_id,omitempty"`
}

// RawJSON returns the line as received.
func (b *base) RawJSON() json.RawMessage { return b.Raw }

// Init is system/init: emitted at the start of each turn (the first one only after the
// first user message, not after initialize).
type Init struct {
	base
	Cwd               string   `json:"cwd"`
	Model             string   `json:"model"`
	PermissionMode    string   `json:"permissionMode"`
	Tools             []string `json:"tools"`
	ClaudeCodeVersion string   `json:"claude_code_version"`
	Capabilities      []string `json:"capabilities"`
	// McpServers are the MCP servers with their status at the turn's start (mcp.go).
	McpServers []McpServerInit `json:"mcp_servers"`
}

// Status is system/status: status "requesting", "compacting" or null; a mode change
// carries permissionMode; the end of a compaction carries compact_result.
type Status struct {
	base
	Status         *string `json:"status"`
	PermissionMode string  `json:"permissionMode,omitempty"`
	CompactResult  string  `json:"compact_result,omitempty"`
	CompactError   string  `json:"compact_error,omitempty"`
}

// APIRetry is system/api_retry: an API request failed with a retryable error (a 429,
// a 529, a 5xx, a connection error) and Claude retries it after retry_delay_ms. One
// frame per attempt; nothing announces the retry's success. The next frame of any other
// kind means it went through (Claude's own REPL clears its banner the same way). Shape
// from Claude Code 2.1.296's SDKAPIRetryMessage.
type APIRetry struct {
	base
	Attempt      int `json:"attempt"`
	MaxRetries   int `json:"max_retries"`
	RetryDelayMs int `json:"retry_delay_ms"`
	// ErrorStatus is the HTTP status; nil for connection errors with no response.
	ErrorStatus *int `json:"error_status"`
	// Error is Claude's category: "rate_limit", "overloaded", "server_error", ...
	Error string `json:"error"`
	// NoResponse is set when no response headers arrived within the first-byte window.
	NoResponse *struct {
		WaitedMs    int `json:"waited_ms"`
		RetryWaitMs int `json:"retry_wait_ms"`
	} `json:"no_response,omitempty"`
}

// PermissionDenied is system/permission_denied: a tool call was denied without a
// prompt (a rule, the auto-mode classifier, ...).
type PermissionDenied struct {
	base
	ToolName           string `json:"tool_name"`
	ToolUseID          string `json:"tool_use_id"`
	AgentID            string `json:"agent_id,omitempty"`
	DecisionReasonType string `json:"decision_reason_type,omitempty"`
	DecisionReason     string `json:"decision_reason,omitempty"`
	Message            string `json:"message"`
}

// CompactBoundary is system/compact_boundary. The summary follows as a synthetic user
// message (User.IsSynthetic, string content).
type CompactBoundary struct {
	base
	Metadata struct {
		Trigger    string `json:"trigger"` // manual | auto
		PreTokens  int64  `json:"pre_tokens"`
		PostTokens int64  `json:"post_tokens"`
		DurationMS int64  `json:"duration_ms"`
	} `json:"compact_metadata"`
}

// ThinkingTokens is system/thinking_tokens: progress of a thinking block whose text is
// not shown (thinking_display "updates": the thinking deltas carry no text).
type ThinkingTokens struct {
	base
	EstimatedTokens int64 `json:"estimated_tokens"`
}

// ConversationReset is {"type":"conversation_reset"}: /clear moved the process to a new
// conversation (new_conversation_id); a new system/init follows.
type ConversationReset struct {
	base
	NewConversationID string `json:"new_conversation_id"`
	Trigger           string `json:"trigger"`
}

// Assistant is a complete assistant message frame. When streamed, Message.Content
// holds the single content block that just completed (it arrives before that block's
// content_block_stop). ParentToolUseID is set on subagent frames.
type Assistant struct {
	base
	Message         APIMessage `json:"message"`
	ParentToolUseID string     `json:"parent_tool_use_id"`
	// Aborted: truncated by an interrupt; the text may end mid-word.
	Aborted bool `json:"aborted,omitempty"`
	// Error is set on synthetic API-error messages (rate_limit, overloaded, ...).
	Error        string `json:"error,omitempty"`
	SubagentType string `json:"subagent_type,omitempty"`
}

// APIMessage is an Anthropic Messages API message.
type APIMessage struct {
	ID         string    `json:"id"`
	Model      string    `json:"model"`
	Role       string    `json:"role"`
	Content    []Block   `json:"content"`
	StopReason string    `json:"stop_reason"`
	Usage      *APIUsage `json:"usage,omitempty"`
}

// APIUsage is a message's token usage.
type APIUsage struct {
	InputTokens              int64 `json:"input_tokens"`
	OutputTokens             int64 `json:"output_tokens"`
	CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
	CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
}

// Block is one content block of an assistant or user message. Fields are filled per
// type: text (Text), thinking (Thinking), tool_use (ID, Name, Input), tool_result
// (ToolUseID, Content, IsError), image (Source).
type Block struct {
	Type      string          `json:"type"`
	Text      string          `json:"text,omitempty"`
	Thinking  string          `json:"thinking,omitempty"`
	ID        string          `json:"id,omitempty"`
	Name      string          `json:"name,omitempty"`
	Input     json.RawMessage `json:"input,omitempty"`
	ToolUseID string          `json:"tool_use_id,omitempty"`
	Content   json.RawMessage `json:"content,omitempty"`
	IsError   bool            `json:"is_error,omitempty"`
}

// ResultText is a tool_result block's content as text: the string itself, or the
// text blocks of a block list joined by newlines (images are skipped).
func (b Block) ResultText() string {
	return contentText(b.Content)
}

func contentText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var blocks []Block
	if json.Unmarshal(raw, &blocks) != nil {
		return ""
	}
	out := ""
	for _, b := range blocks {
		if b.Type != "text" {
			continue
		}
		if out != "" {
			out += "\n"
		}
		out += b.Text
	}
	return out
}

// User is a user frame from the CLI: tool results (Blocks of type tool_result), a
// subagent's prompt (ParentToolUseID set, text), "[Request interrupted by user]", a
// compaction summary (IsSynthetic, string content) or a local command's output
// (IsReplay, "<local-command-stdout>...").
type User struct {
	base
	Message struct {
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
	} `json:"message"`
	ParentToolUseID string `json:"parent_tool_use_id"`
	IsSynthetic     bool   `json:"isSynthetic,omitempty"`
	IsReplay        bool   `json:"isReplay,omitempty"`
	// ToolUseResult is the tool's structured output (Write/Edit: filePath, content,
	// structuredPatch, originalFile; AskUserQuestion: questions, answers; ...).
	ToolUseResult json.RawMessage `json:"tool_use_result,omitempty"`
}

// Blocks returns the content as blocks; string content is one text block.
func (u *User) Blocks() []Block {
	var s string
	if json.Unmarshal(u.Message.Content, &s) == nil {
		return []Block{{Type: "text", Text: s}}
	}
	var blocks []Block
	_ = json.Unmarshal(u.Message.Content, &blocks)
	return blocks
}

// Text is the content's text blocks joined by newlines.
func (u *User) Text() string { return contentText(u.Message.Content) }

// StreamEvent is a stream_event frame: one Messages API streaming event. Only
// top-level (ParentToolUseID empty) output is streamed; subagent output arrives as
// whole Assistant frames.
type StreamEvent struct {
	base
	Event           APIStreamEvent `json:"event"`
	ParentToolUseID string         `json:"parent_tool_use_id"`
	APIMessageID    string         `json:"api_message_id,omitempty"`
}

// APIStreamEvent is a Messages API streaming event: message_start (Message),
// content_block_start (Index, ContentBlock), content_block_delta (Index, Delta),
// content_block_stop (Index), message_delta (Delta.StopReason, Usage), message_stop.
type APIStreamEvent struct {
	Type         string      `json:"type"`
	Index        int         `json:"index"`
	Message      *APIMessage `json:"message,omitempty"`
	ContentBlock *Block      `json:"content_block,omitempty"`
	Delta        *Delta      `json:"delta,omitempty"`
	Usage        *APIUsage   `json:"usage,omitempty"`
}

// Delta is a content_block_delta's or message_delta's delta: text_delta (Text),
// thinking_delta (Thinking), input_json_delta (PartialJSON), signature_delta;
// message_delta carries StopReason.
type Delta struct {
	Type        string `json:"type"`
	Text        string `json:"text,omitempty"`
	Thinking    string `json:"thinking,omitempty"`
	PartialJSON string `json:"partial_json,omitempty"`
	StopReason  string `json:"stop_reason,omitempty"`
}

// Result ends a turn (one per turn). TotalCostUSD and ModelUsage are cumulative over
// the process; Usage is the main loop's for this turn.
type Result struct {
	base
	IsError        bool      `json:"is_error"`
	DurationMS     int64     `json:"duration_ms"`
	DurationAPIMS  int64     `json:"duration_api_ms"`
	NumTurns       int       `json:"num_turns"`
	Result         string    `json:"result,omitempty"`
	StopReason     string    `json:"stop_reason"`
	TerminalReason string    `json:"terminal_reason,omitempty"`
	TotalCostUSD   float64   `json:"total_cost_usd"`
	Usage          *APIUsage `json:"usage,omitempty"`
	// ModelUsage is cumulative over the process like TotalCostUSD (subagents included),
	// by the model's canonical id; a --resume that Claude restores the totals for
	// carries the previous process's over.
	ModelUsage     map[string]ModelUsage `json:"modelUsage,omitempty"`
	Errors         []string              `json:"errors,omitempty"`
	APIErrorStatus *int                  `json:"api_error_status,omitempty"`
	// QueuedTurnCount > 0 means more queued user turns follow without input.
	QueuedTurnCount int    `json:"queued_turn_count,omitempty"`
	LocalCommand    string `json:"local_command,omitempty"`
	UserMessageUUID string `json:"user_message_uuid,omitempty"`
}

// ModelUsage is one model's running totals in a result's modelUsage.
type ModelUsage struct {
	InputTokens              int64   `json:"inputTokens"`
	OutputTokens             int64   `json:"outputTokens"`
	CacheReadInputTokens     int64   `json:"cacheReadInputTokens"`
	CacheCreationInputTokens int64   `json:"cacheCreationInputTokens"`
	CostUSD                  float64 `json:"costUSD"`
}

// OutputTokens is the process's output tokens so far over every model (modelUsage).
func (r *Result) OutputTokens() int64 {
	var n int64
	for _, u := range r.ModelUsage {
		n += u.OutputTokens
	}
	return n
}

// Interrupted reports whether the turn was cut short by an interrupt
// (terminal_reason "aborted_streaming", "aborted_tools", ...).
func (r *Result) Interrupted() bool {
	return len(r.TerminalReason) >= 7 && r.TerminalReason[:7] == "aborted"
}

// RateLimit is a rate_limit_event.
type RateLimit struct {
	base
	Info struct {
		Status        string  `json:"status"`
		ResetsAt      int64   `json:"resetsAt,omitempty"`
		RateLimitType string  `json:"rateLimitType,omitempty"`
		Utilization   float64 `json:"utilization,omitempty"`
	} `json:"rate_limit_info"`
}

// CommandLifecycle tracks a sent user message by its uuid: queued, started,
// completed, cancelled.
type CommandLifecycle struct {
	base
	CommandUUID string `json:"command_uuid"`
	State       string `json:"state"`
}

// Task is a system task_* frame (task_started, task_progress, task_updated,
// task_notification): a subagent or background task's lifecycle. Claude Code 2.1.299
// (testdata/agents.jsonl, agents-stop.jsonl, agents-resume.jsonl):
//
//   - task_started opens a run: task_type local_agent for an Agent call (task_id is the
//     agent id), local_bash for a shell a subagent started (owned_by_subagent). A
//     SendMessage that wakes a finished agent starts it again under the same task_id,
//     with a new run_id and the SendMessage's tool_use_id.
//   - task_progress comes per tool call: description is the agent's current activity,
//     usage its tokens (the last request's), tool uses and duration so far this run.
//   - task_updated patches the status (completed, killed, ...) with end_time.
//   - task_notification ends it: status (completed, failed, stopped), summary, final
//     usage, and with handback "send" the report in handback_report (summary is then a
//     pointer to it). A resumed process reports a background run the previous process
//     left running as stopped ("didn't finish before the previous session ended").
//
// The thread's own background shells (Claude Code 2.1.300, testdata/shells*.jsonl): a
// Bash call with run_in_background or a Monitor call is task_type local_bash with
// is_backgrounded and no owned_by_subagent; task_id is the "b…" id the call's result
// names, tool_use_id the call, description the call's description. The frames do not
// tell Bash from Monitor and carry no command (the call's input has both). No
// task_progress comes. The end is task_updated (completed, failed, killed) and
// task_notification (completed, failed, stopped) with summary "Background command "X"
// completed (exit code 0)", "… failed with exit code 3", "Monitor "X" stream ended", or
// a stopped shell's description; on SIGTERM the notification comes first.
type Task struct {
	base
	TaskID          string `json:"task_id"`
	RunID           string `json:"run_id,omitempty"`
	ToolUseID       string `json:"tool_use_id,omitempty"`
	Description     string `json:"description,omitempty"`
	SubagentType    string `json:"subagent_type,omitempty"`
	TaskType        string `json:"task_type,omitempty"`
	IsBackgrounded  bool   `json:"is_backgrounded,omitempty"`
	SpawnDepth      int    `json:"spawn_depth,omitempty"`
	ParentTaskID    string `json:"parent_task_id,omitempty"`
	OwnedBySubagent bool   `json:"owned_by_subagent,omitempty"`
	Prompt          string `json:"prompt,omitempty"`
	// LastToolName: task_progress's latest tool.
	LastToolName string `json:"last_tool_name,omitempty"`
	// Status: task_notification's (completed, failed, stopped).
	Status     string     `json:"status,omitempty"`
	Summary    string     `json:"summary,omitempty"`
	OutputFile string     `json:"output_file,omitempty"`
	Usage      *TaskUsage `json:"usage,omitempty"`
	// Patch: task_updated's.
	Patch          *TaskPatch      `json:"patch,omitempty"`
	Handback       string          `json:"handback,omitempty"`
	HandbackReport *HandbackReport `json:"handback_report,omitempty"`
}

// Task subtypes and the task types of a subagent and a shell.
const (
	TaskStarted      = "task_started"
	TaskProgress     = "task_progress"
	TaskUpdated      = "task_updated"
	TaskNotification = "task_notification"
	TaskTypeAgent    = "local_agent"
	TaskTypeShell    = "local_bash"
)

// BackgroundTasks is system/background_tasks_changed (new in Claude Code 2.1.300): the
// background tasks running now, the whole list after each change (a shell started, an
// empty list once the last one ended). The task frames say the same per task; the
// daemon follows those.
type BackgroundTasks struct {
	base
	Tasks []BackgroundTask `json:"tasks"`
}

// BackgroundTask is one entry of BackgroundTasks.
type BackgroundTask struct {
	TaskID      string `json:"task_id"`
	RunID       string `json:"run_id,omitempty"`
	TaskType    string `json:"task_type,omitempty"`
	Description string `json:"description,omitempty"`
}

// TaskUsage is a task's counters so far (task_progress) or final (task_notification).
type TaskUsage struct {
	TotalTokens int64 `json:"total_tokens"`
	ToolUses    int64 `json:"tool_uses"`
	DurationMS  int64 `json:"duration_ms"`
}

// TaskPatch is task_updated's change: a status and, once it ended, end_time (unix ms).
type TaskPatch struct {
	Status  string `json:"status,omitempty"`
	EndTime int64  `json:"end_time,omitempty"`
}

// HandbackReport is the report a subagent handed back (SubagentHandback).
type HandbackReport struct {
	Text string `json:"text"`
}

// Report is what a finished task said: its handed-back report, else its summary.
func (t *Task) Report() string {
	if t.HandbackReport != nil && t.HandbackReport.Text != "" {
		return t.HandbackReport.Text
	}
	return t.Summary
}

// ControlCancel is a control_cancel_request: the CLI withdrew one of its own requests
// (a pending can_use_tool after an interrupt). The Conn forgets the request before
// delivering this, so answering it afterwards sends nothing (ErrCancelled).
type ControlCancel struct {
	base
	RequestID string `json:"request_id"`
}

// Unknown is any other line: a type or subtype this package does not model, or a line
// that is not JSON (Err set).
type Unknown struct {
	base
	Err error `json:"-"`
}

// ---- control ----------------------------------------------------------------------

// ControlRequest is a host -> CLI control request body: {"subtype": ..., fields}.
type ControlRequest map[string]any

// Control request subtypes the host sends.
const (
	SubtypeInitialize        = "initialize"
	SubtypeInterrupt         = "interrupt"
	SubtypeSetModel          = "set_model"
	SubtypeSetPermissionMode = "set_permission_mode"
	SubtypeSetCwd            = "set_cwd"
	SubtypeCanUseTool        = "can_use_tool"
	SubtypeMcpStatus         = "mcp_status"
	SubtypeMcpReconnect      = "mcp_reconnect"
)

// InitializeResponse is the part of initialize's success payload we read.
type InitializeResponse struct {
	PID                   int    `json:"pid"`
	ClaudeCodeVersion     string `json:"claude_code_version"`
	CurrentPermissionMode string `json:"current_permission_mode"`
	SessionState          string `json:"session_state"`
	// Commands are the slash commands Claude offers, in its order (commands.go).
	Commands []SlashCommand `json:"commands"`
}

// SetCwdResponse is set_cwd's success payload. Status is "ok", "needs_trust" (the
// folder is not trusted in Claude's config) or "rejected" (Reason, Message).
type SetCwdResponse struct {
	Status              string `json:"status"`
	Cwd                 string `json:"cwd"`
	Changed             bool   `json:"changed"`
	TranscriptRelocated bool   `json:"transcript_relocated"`
	Reason              string `json:"reason"`
	Message             string `json:"message"`
}

// PermissionRequest is an inbound can_use_tool control request, delivered on
// Conn.Events in stdout order. It stays pending until Answer is called (a person may
// take as long as they like), the CLI withdraws it (a *ControlCancel with its
// RequestID follows on Events) or stdout ends. AskUserQuestion arrives the same way
// (ToolName "AskUserQuestion"); answer it with Allow and UpdatedInput
// {"questions": Input.questions, "answers": {question: label}}.
type PermissionRequest struct {
	RequestID      string          `json:"-"`
	ToolName       string          `json:"tool_name"`
	DisplayName    string          `json:"display_name,omitempty"`
	Title          string          `json:"title,omitempty"`
	Description    string          `json:"description,omitempty"`
	Input          json.RawMessage `json:"input"`
	Suggestions    json.RawMessage `json:"permission_suggestions,omitempty"`
	ToolUseID      string          `json:"tool_use_id"`
	AgentID        string          `json:"agent_id,omitempty"`
	BlockedPath    string          `json:"blocked_path,omitempty"`
	DecisionReason string          `json:"decision_reason,omitempty"`
	// RequiresUserInteraction: the tool's card is the interaction surface (true for
	// AskUserQuestion): offer no one-tap approve.
	RequiresUserInteraction bool `json:"requires_user_interaction,omitempty"`
	// Raw is the whole control_request line.
	Raw json.RawMessage `json:"-"`

	conn     *Conn
	answered bool // guarded by conn.mu
}

// RawJSON returns the control_request line as received.
func (r *PermissionRequest) RawJSON() json.RawMessage { return r.Raw }

// Answer sends res to the CLI. It does not wait for the write. It fails, sending
// nothing, with ErrCancelled once the CLI withdrew the request, ErrClosed once
// stdout ended, and ErrAnswered on a second call.
func (r *PermissionRequest) Answer(res PermissionResult) error {
	if r.conn == nil {
		return errors.New("claudestream: request did not come from a Conn")
	}
	return r.conn.answer(r, res)
}

// IsQuestion reports whether this is an AskUserQuestion request.
func (r *PermissionRequest) IsQuestion() bool { return r.ToolName == "AskUserQuestion" }

// Permission modes accepted by set_permission_mode (the CLI's names). "default" is
// what `--permission-mode manual` reports itself as. plan, dontAsk and
// bypassPermissions exist but are never sent by code-foundry.
const (
	ModeDefault     = "default"
	ModeAcceptEdits = "acceptEdits"
	ModeAuto        = "auto"
)
