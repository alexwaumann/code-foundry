package thread

import (
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/claudestream"
)

// The projection from the stream-json stream to thread items. Facts it relies on
// (Claude Code 2.1.296; docs/notes/rendered-threads-handoff.md §2):
//
//   - Only top-level output is streamed (stream_event with parent_tool_use_id null):
//     content_block_start opens a text, thinking or tool_use block, deltas extend it.
//   - The complete block arrives as an assistant frame holding just that block,
//     before its content_block_stop. That frame is authoritative (final text, the
//     tool's parsed input); an interrupted one has aborted set.
//   - Subagent frames (parent_tool_use_id = the Agent tool_use) arrive whole.
//   - Tool results come as user frames of tool_result blocks with tool_use_result
//     (structured output). Other user frames: "[Request interrupted by user]", a
//     subagent's prompt, a compaction summary (isSynthetic, after compact_boundary),
//     a local command's output (isReplay, <local-command-stdout>).
//   - result ends every turn.

// itemWriter applies projected changes to a thread log and persists every item that
// is not streaming.
type itemWriter struct {
	log  *threadLog
	save func(Item)
}

func (w itemWriter) add(it Item) Item {
	it = w.log.append(it)
	if !it.Streaming {
		w.save(it)
	}
	return it
}

func (w itemWriter) change(id string, fn func(*Item)) (Item, bool) {
	it, ok := w.log.update(id, fn)
	if ok && !it.Streaming {
		w.save(it)
	}
	return it, ok
}

func (w itemWriter) delta(id string, f DeltaField, text string) { w.log.delta(id, f, text) }

// projector turns stream events into items. One per runner; not safe for concurrent
// use.
type projector struct {
	w itemWriter
	// msg is the top-level message being streamed.
	msg string
	// open are the streaming blocks of top-level messages, by message in index order.
	open map[string][]openBlock
	// compaction is the compaction item waiting for its summary.
	compaction string
	n          int // for generated ids
	// model is the model of the running turn's own replies (its assistant frames).
	model string
	costs turnCosts
	// ctx is the running turn's context size so far: the last top-level response's
	// usage (usageTokens), or a compaction's post-compaction size; 0 when none yet.
	ctx int64
	// last is the context of the last result (context.go); tokens 0 when the turn
	// reported none (a local command).
	last struct {
		tokens int64
		model  string
	}
	// async are the Agent calls launched in the background whose run has not reported
	// its end yet: their result came at once (async_launched), so their item stays
	// running until the run ends (agentEnded, agents_runner.go). The thread's own
	// background Bash and Monitor calls too, until their shell ends (bgshells.go).
	async map[string]bool
}

type openBlock struct {
	index int
	id    string
	kind  ItemKind
}

// newProjector projects onto w's log the events of a process that starts from base
// (restoredTotals). The log's last turn end from a result, if any, is the previous
// process's (a Reconnect, a daemon restart); one the daemon wrote for a process that
// ended without a result (turnclose.go) carries no totals and is skipped.
func newProjector(w itemWriter, base runningTotals) *projector {
	p := &projector{w: w, open: map[string][]openBlock{}, async: map[string]bool{}}
	items := w.log.snapshot().Items
	for i := len(items) - 1; i >= 0; i-- {
		if items[i].Kind == KindTurnEnd && !isSynthTurn(items[i].Turn) {
			p.costs.seed(items[i].Turn)
			break
		}
	}
	p.costs.start(base)
	return p
}

// restart: the next events come from a new process (an effort change's restart) that
// starts from base.
func (p *projector) restart(base runningTotals) {
	p.costs.start(base)
	p.model = ""
}

func (p *projector) nextID(prefix string) string {
	p.n++
	return fmt.Sprintf("%s-%d-%d", prefix, p.w.log.now().UnixMilli(), p.n)
}

// event applies one stream event.
func (p *projector) event(ev claudestream.Event) {
	defer p.queueEvent(ev) // after a result's turn end (queued.go)
	switch e := ev.(type) {
	case *claudestream.StreamEvent:
		if e.ParentToolUseID == "" {
			p.stream(e)
		}
	case *claudestream.Assistant:
		p.assistant(e)
	case *claudestream.User:
		p.user(e)
	case *claudestream.CompactBoundary:
		it := p.w.add(Item{ID: "compact-" + nonEmpty(e.UUID, p.nextID("c")), Kind: KindCompaction, Compaction: &Compaction{
			Trigger: e.Metadata.Trigger, PreTokens: e.Metadata.PreTokens, PostTokens: e.Metadata.PostTokens,
		}})
		p.compaction = it.ID
		if e.Metadata.PostTokens > 0 {
			p.ctx = e.Metadata.PostTokens
		}
	case *claudestream.PermissionDenied:
		p.w.add(Item{ID: "denied-" + nonEmpty(e.ToolUseID, p.nextID("d")), Kind: KindPermission, Request: &Request{
			ToolName: e.ToolName, ToolUseID: e.ToolUseID, AgentID: e.AgentID, DecisionReason: e.DecisionReason,
			State: RequestDenied, Decision: DecisionAutoDenied, Message: e.Message,
		}})
	case *claudestream.Result:
		p.closeOpen()
		t := turnEnd(e)
		var turnOut int64
		if e.Usage != nil {
			turnOut = e.Usage.OutputTokens
		}
		t.TurnCostUSD = p.costs.turn(e.TotalCostUSD, e.OutputTokens(), turnOut)
		t.Model, t.ProcessOutputTokens = p.model, e.OutputTokens()
		p.last.tokens, p.last.model = turnContext(p.ctx, e.Usage), p.model
		p.model, p.ctx = "", 0
		p.w.add(Item{ID: "turn-" + nonEmpty(e.UUID, p.nextID("t")), Kind: KindTurnEnd, Turn: t})
	}
}

func (p *projector) stream(e *claudestream.StreamEvent) {
	se := e.Event
	switch se.Type {
	case "message_start":
		if se.Message != nil {
			p.msg = se.Message.ID
			p.noteUsage(se.Message.Usage)
		}
	case "message_delta":
		// The response's final usage (message_start's has the output so far).
		p.noteUsage(se.Usage)
	case "content_block_start":
		msg := nonEmpty(e.APIMessageID, p.msg)
		cb := se.ContentBlock
		if cb == nil {
			return
		}
		var it Item
		switch cb.Type {
		case "text":
			it = Item{ID: fmt.Sprintf("%s/%d", msg, se.Index), Kind: KindAssistantText, Text: cb.Text}
		case "thinking":
			it = Item{ID: fmt.Sprintf("%s/%d", msg, se.Index), Kind: KindThinking, Text: cb.Thinking}
		case "tool_use":
			it = Item{ID: cb.ID, Kind: KindToolCall, Tool: &ToolCall{ToolUseID: cb.ID, Name: cb.Name, Status: ToolRunning}}
		default:
			return
		}
		it.Streaming = true
		it = p.w.add(it)
		p.open[msg] = append(p.open[msg], openBlock{index: se.Index, id: it.ID, kind: it.Kind})
	case "content_block_delta":
		msg := nonEmpty(e.APIMessageID, p.msg)
		i := slices.IndexFunc(p.open[msg], func(b openBlock) bool { return b.index == se.Index })
		if i < 0 || se.Delta == nil {
			return
		}
		id := p.open[msg][i].id
		switch se.Delta.Type {
		case "text_delta":
			p.w.delta(id, DeltaText, se.Delta.Text)
		case "thinking_delta":
			p.w.delta(id, DeltaText, se.Delta.Thinking)
		case "input_json_delta":
			p.w.delta(id, DeltaInput, se.Delta.PartialJSON)
		}
	case "content_block_stop":
		// The assistant frame normally completed the block already; if it did not
		// arrive, the streamed content is final.
		msg := nonEmpty(e.APIMessageID, p.msg)
		i := slices.IndexFunc(p.open[msg], func(b openBlock) bool { return b.index == se.Index })
		if i >= 0 {
			p.finish(p.open[msg][i].id, nil)
			p.drop(msg, i)
		}
	}
}

// noteUsage records a top-level response's usage as the running turn's context size.
func (p *projector) noteUsage(u *claudestream.APIUsage) {
	if n := usageTokens(u); n > 0 {
		p.ctx = n
	}
}

func (p *projector) drop(msg string, i int) {
	p.open[msg] = slices.Delete(p.open[msg], i, i+1)
	if len(p.open[msg]) == 0 {
		delete(p.open, msg)
	}
}

// finish completes a streaming item, with b's final content when given.
func (p *projector) finish(id string, b *claudestream.Block) {
	p.w.change(id, func(it *Item) {
		it.Streaming = false
		if b == nil {
			return
		}
		switch b.Type {
		case "text":
			it.Text = b.Text
		case "thinking":
			if b.Thinking != "" {
				it.Text = b.Thinking
			}
		case "tool_use":
			if it.Tool != nil && len(b.Input) > 0 {
				it.Tool.InputJSON = string(b.Input)
			}
		}
	})
}

// closeOpen completes every block still streaming (a turn ended without their stop).
func (p *projector) closeOpen() {
	for msg, blocks := range p.open {
		for _, b := range blocks {
			p.finish(b.id, nil)
		}
		delete(p.open, msg)
	}
}

func blockKind(t string) ItemKind {
	switch t {
	case "text":
		return KindAssistantText
	case "thinking":
		return KindThinking
	case "tool_use":
		return KindToolCall
	}
	return ""
}

func (p *projector) assistant(e *claudestream.Assistant) {
	// A turn's model is its own replies' (a subagent may run another); synthetic API
	// error messages name none.
	if e.ParentToolUseID == "" && e.Message.Model != "" && e.Message.Model != "<synthetic>" {
		p.model = e.Message.Model
		// Without partial messages this frame is the only usage of the response; with
		// them its message_delta follows with the final output count.
		p.noteUsage(e.Message.Usage)
	}
	for _, b := range e.Message.Content {
		kind := blockKind(b.Type)
		if kind == "" {
			continue
		}
		if e.ParentToolUseID == "" {
			blocks := p.open[e.Message.ID]
			i := slices.IndexFunc(blocks, func(o openBlock) bool {
				return o.kind == kind && (kind != KindToolCall || o.id == b.ID)
			})
			if i >= 0 {
				p.finish(blocks[i].id, &b)
				p.drop(e.Message.ID, i)
				continue
			}
		}
		// Not streamed: a subagent's frame, or output without partial messages.
		it := Item{Kind: kind, ParentToolUseID: e.ParentToolUseID}
		switch kind {
		case KindAssistantText:
			it.ID, it.Text = p.nextID(e.Message.ID+"/t"), b.Text
		case KindThinking:
			it.ID, it.Text = p.nextID(e.Message.ID+"/th"), b.Thinking
		case KindToolCall:
			it.ID = b.ID
			it.Tool = &ToolCall{ToolUseID: b.ID, Name: b.Name, InputJSON: string(b.Input), Status: ToolRunning}
		}
		if kind == KindAssistantText && it.Text == "" {
			continue
		}
		p.w.add(it)
	}
}

var localCommandOutput = regexp.MustCompile(`(?s)<local-command-std(?:out|err)>(.*?)</local-command-std(?:out|err)>`)

func (p *projector) user(e *claudestream.User) {
	blocks := e.Blocks()
	results := false
	for _, b := range blocks {
		if b.Type != "tool_result" {
			continue
		}
		results = true
		res := ""
		if len(e.ToolUseResult) > 0 && len(e.ToolUseResult) <= maxResultJSON && len(blocks) == 1 {
			res = string(e.ToolUseResult)
		}
		async := len(blocks) == 1 && !b.IsError && isAsyncLaunch(e.ToolUseResult)
		// A subagent's own background shell is not the thread's: its item ends here.
		shell := len(blocks) == 1 && !b.IsError && e.ParentToolUseID == "" && isShellLaunch(e.ToolUseResult)
		p.w.change(b.ToolUseID, func(it *Item) {
			if it.Tool == nil {
				return
			}
			it.Streaming = false
			it.Tool.Output, it.Tool.IsError, it.Tool.ResultJSON = capOutput(b.ResultText()), b.IsError, res
			it.Tool.Status = ToolDone
			if b.IsError {
				it.Tool.Status = ToolError
			}
			if async && (it.Tool.Name == "Agent" || it.Tool.Name == "Task") {
				// A background run: the call follows the run, not its result.
				it.Tool.Status = ToolRunning
				p.async[it.ID] = true
			}
			if shell && (it.Tool.Name == "Bash" || it.Tool.Name == "Monitor") {
				// A background shell: the call follows the shell (bgshells.go).
				it.Tool.Status = ToolRunning
				p.async[it.ID] = true
			}
		})
	}
	if results {
		return
	}
	text := e.Text()
	switch {
	case e.IsSynthetic && p.compaction != "":
		p.w.change(p.compaction, func(it *Item) { it.Text = text })
		p.compaction = ""
	case e.IsReplay:
		if m := localCommandOutput.FindStringSubmatch(text); m != nil {
			if out := strings.TrimSpace(m[1]); out != "" {
				p.w.add(Item{ID: "cmd-" + nonEmpty(e.UUID, p.nextID("o")), Kind: KindCommandOutput, Text: out})
			}
		}
	}
	// Anything else ("[Request interrupted by user]", a subagent's prompt, which the
	// Agent tool call's input already holds) is not an item.
}

func turnEnd(r *claudestream.Result) *TurnEnd {
	t := &TurnEnd{
		Subtype: r.Subtype, IsError: r.IsError, Interrupted: r.Interrupted(), StopReason: r.StopReason,
		TerminalReason: r.TerminalReason, DurationMS: r.DurationMS, NumTurns: r.NumTurns, CostUSD: r.TotalCostUSD,
		Errors: r.Errors,
	}
	if u := r.Usage; u != nil {
		t.InputTokens, t.OutputTokens = u.InputTokens, u.OutputTokens
		t.CacheReadTokens, t.CacheWriteTokens = u.CacheReadInputTokens, u.CacheCreationInputTokens
	}
	return t
}

// requestItem is the item for a can_use_tool request.
func requestItem(r *claudestream.PermissionRequest) Item {
	it := Item{ID: "perm-" + r.RequestID, Kind: KindPermission}
	if r.IsQuestion() {
		it = Item{ID: "q-" + r.RequestID, Kind: KindQuestion}
	}
	it.Request = &Request{
		RequestID: r.RequestID, ToolName: r.ToolName, DisplayName: r.DisplayName, Title: r.Title,
		Description: r.Description, ToolUseID: r.ToolUseID, AgentID: r.AgentID, BlockedPath: r.BlockedPath,
		DecisionReason: r.DecisionReason, InputJSON: string(r.Input), State: RequestPending,
	}
	if len(r.Suggestions) > 0 && string(r.Suggestions) != "null" {
		it.Request.SuggestionsJSON = string(r.Suggestions)
	}
	return it
}

// question is one AskUserQuestion question.
type question struct {
	Question    string `json:"question"`
	Header      string `json:"header"`
	MultiSelect bool   `json:"multiSelect"`
	Options     []struct {
		Label       string `json:"label"`
		Description string `json:"description"`
	} `json:"options"`
}

func questionsOf(inputJSON string) []question {
	var in struct {
		Questions []question `json:"questions"`
	}
	_ = json.Unmarshal([]byte(inputJSON), &in)
	return in.Questions
}

// permissionResult maps a decision on a request to the CLI's answer. A question needs
// an answer for each of its questions when allowed.
func permissionResult(r *Request, kind ItemKind, d Decision) (claudestream.PermissionResult, error) {
	if !d.Allow {
		return claudestream.PermissionResult{Message: denyMessage(d.Message), Interrupt: d.Interrupt}, nil
	}
	res := claudestream.PermissionResult{Allow: true}
	if d.ForSession && r.SuggestionsJSON != "" {
		res.UpdatedPermissions = json.RawMessage(r.SuggestionsJSON)
	}
	if kind != KindQuestion {
		return res, nil
	}
	var in map[string]json.RawMessage
	if err := json.Unmarshal([]byte(r.InputJSON), &in); err != nil || in == nil {
		in = map[string]json.RawMessage{}
	}
	for _, q := range questionsOf(r.InputJSON) {
		if strings.TrimSpace(d.Answers[q.Question]) == "" {
			return res, fmt.Errorf("%w: no answer for question %q", ErrInvalidArgument, q.Question)
		}
	}
	answers, err := json.Marshal(d.Answers)
	if err != nil {
		return res, fmt.Errorf("%w: answers: %v", ErrInvalidArgument, err)
	}
	in["answers"] = answers
	up, err := json.Marshal(in)
	if err != nil {
		return res, fmt.Errorf("thread: question answer: %w", err)
	}
	res.UpdatedInput = up
	return res, nil
}

// What Claude reads when the user denies a request: Claude Code's own rejection
// texts (2.1.296 binary), so a denial from the app reads to Claude like one in its TUI.
// The CLI passes a deny's message through as the tool result verbatim. A skipped
// question is the same rejection: the TUI's Esc on AskUserQuestion rejects the tool use
// (its "User declined to answer questions" is only how the TUI draws that rejection).
const (
	rejectText       = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file)."
	rejectStop       = rejectText + " STOP what you are doing and wait for the user to tell you how to proceed."
	rejectWithReason = rejectText + " To tell you how to proceed, the user said:\n"
)

// denyMessage is the tool result Claude gets for a deny (a permission or a skipped
// question) with the user's reason, possibly empty.
func denyMessage(reason string) string {
	if reason = strings.TrimSpace(reason); reason != "" {
		return rejectWithReason + reason
	}
	return rejectStop
}

func nonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
