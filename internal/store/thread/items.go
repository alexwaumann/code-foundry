package thread

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/alexwaumann/code-foundry/internal/bus"
)

// Thread items: a thread's conversation (docs/notes/rendered-threads-1-daemon.md).
//
// The stdio runner (stream.go) projects the CLI's stream into items (project.go). Each
// item gets the next ordinal when it first appears; text that is still streaming lives
// in memory only (Item.Streaming) and is published as ItemDelta events, and the item
// is written to thread_items once complete. Later changes (a tool call's result, a
// permission's decision) rewrite the row. A thread's items are loaded from the table
// the first time they are asked for (Items, WatchItems, a spawn), so a daemon restart
// rehydrates them; a reconnect appends to them.

// ItemKind is the kind of a thread item. Values are stored in thread_items.kind.
type ItemKind string

// Item kinds.
const (
	// KindUserMessage is what the user sent: the composer text as typed (file tags
	// as cf-file tokens, not the projected prompt) and the attachments' paths.
	KindUserMessage ItemKind = "user_message"
	// KindAssistantText is one text block of Claude's reply (markdown).
	KindAssistantText ItemKind = "assistant_text"
	// KindThinking is one thinking block; Text is empty when Claude does not show
	// its thinking (the usual case: only its progress is streamed).
	KindThinking ItemKind = "thinking"
	// KindToolCall is a tool_use and, once it arrives, its result.
	KindToolCall ItemKind = "tool_call"
	// KindPermission is a can_use_tool request and its resolution, or a tool call
	// denied without a prompt (Decision DecisionAutoDenied).
	KindPermission ItemKind = "permission_request"
	// KindQuestion is an AskUserQuestion request and its answers.
	KindQuestion ItemKind = "question"
	// KindTurnEnd ends a turn (the CLI's result): usage, cost, duration, stop reason.
	// When the process ended before its result the daemon writes one itself
	// (SubtypeProcessEnded, turnclose.go), so every turn ends with one.
	KindTurnEnd ItemKind = "turn_end"
	// KindError is something that went wrong outside a turn's result: the process
	// failed to start or exited mid-turn (Text says what).
	KindError ItemKind = "error"
	// KindCompaction marks a compaction (/compact or automatic); Text is the summary
	// once it arrives.
	KindCompaction ItemKind = "compaction"
	// KindCommandOutput is a local slash command's output (/cost, /compact's
	// "Compacted", ...).
	KindCommandOutput ItemKind = "command_output"
	// KindNote is a line the daemon adds to the conversation, not Claude: Text says
	// what happened. A fork's log starts with its parent's items and a note "Forked
	// from <parent>" where they end (fork.go).
	KindNote ItemKind = "note"
)

// ToolStatus is a tool call's progress.
type ToolStatus string

// Tool statuses.
const (
	ToolRunning ToolStatus = "running"
	ToolDone    ToolStatus = "done"
	ToolError   ToolStatus = "error"
)

// RequestState is a permission request's or question's state.
type RequestState string

// Request states.
const (
	RequestPending RequestState = "pending"
	// RequestAllowed: allowed (a question: answered).
	RequestAllowed RequestState = "allowed"
	RequestDenied  RequestState = "denied"
	// RequestCancelled: withdrawn by Claude (the turn was interrupted) or the
	// process ended before it was answered.
	RequestCancelled RequestState = "cancelled"
)

// Permission decisions recorded on a resolved request.
const (
	DecisionAllow           = "allow"
	DecisionAllowForSession = "allow_session"
	DecisionDeny            = "deny"
	// DecisionAutoDenied: Claude denied the call without asking (a rule, the
	// auto-mode classifier).
	DecisionAutoDenied = "auto_denied"
)

// Item is one entry of a thread's conversation. Kind says which of the
// payload fields are set. Items are values: never mutate one read from a snapshot.
type Item struct {
	// ID is stable for the item's life: the user message's uuid, "<message id>/<block
	// index>" for text and thinking, the tool_use id, "perm-"/"q-" + the request id, ...
	ID      string
	Ordinal int64
	Kind    ItemKind
	// ParentToolUseID is the Agent tool_use a subagent's item belongs to; empty for
	// the thread's own.
	ParentToolUseID string
	CreatedAt       time.Time
	UpdatedAt       time.Time
	// Streaming: the item is still arriving (text deltas) and not yet persisted.
	Streaming bool
	// Text: user_message (as typed), assistant_text, thinking, error, compaction (the
	// summary), command_output, note.
	Text string
	// NoteCreatedBy: a note's creator thread id when it is the "Created by" note that
	// starts a thread another thread made (Text keeps the creator's name at creation);
	// empty for every other note. A fork's copy keeps it.
	NoteCreatedBy string
	// Attachments: user_message's staged image and PDF paths.
	Attachments []string
	// ComposerText: user_message's composer text with its tag tokens, when the GUI
	// sent it (Message.ComposerText); stored for display only.
	ComposerText string
	// Origin, WakeTitle and WakeJSON: user_message's sender (Message.Origin); a wake's
	// header line without its prefix and its JSON payload (subscriptions_fire.go).
	Origin    MessageOrigin
	WakeTitle string
	WakeJSON  string
	// SentBy: user_message's sending thread (Message.ByThreadID; a created thread's first
	// prompt, its creator); "" for the user. Prompt history leaves such messages out
	// (prompts.go).
	SentBy string
	// ResumeNote: user_message's resume note, the line Claude got before the text after
	// something other than the user stopped its previous turn (resumenote.go).
	ResumeNote string
	// SeedPrefix: user_message's seed prefix, what Claude got before the text (and the
	// resume note) as the first message of a fresh session a reseed asked for (reseed.go).
	SeedPrefix string
	// MemoryNote: user_message's app memory refresh, the standing preferences Claude got
	// before the text (and the seed prefix and resume note) because they changed since its
	// conversation started (memory.go). Not shown: the message shows as typed.
	MemoryNote string
	// Queued: a user_message Claude has but has not read yet. A message sent while a turn
	// runs waits in Claude Code's queue until its next tool call (or the end of the reply);
	// the item is in the log from its arrival so the send shows at once (queued.go).
	Queued bool
	// PlacedAfter: the ordinal of the item a user_message is shown after, set when Claude
	// read it later than it arrived (queued.go); 0 for every other item. The item keeps its
	// Ordinal (an agent's since/after still names it); only its place in the log moves.
	PlacedAfter int64
	Tool        *ToolCall
	Request     *Request // permission_request and question
	Turn        *TurnEnd
	Compaction  *Compaction
	// HTML: an html item's page (html.go).
	HTML *HTMLPage
	// Theme: a theme item's card (theme.go).
	Theme *ThemeCard
}

// ToolCall is a tool_call item's payload.
type ToolCall struct {
	ToolUseID string
	Name      string
	// InputJSON is the tool's input (JSON). While Streaming it is the partial JSON
	// received so far.
	InputJSON string
	Status    ToolStatus
	// Output is the tool_result's text; IsError its is_error.
	Output  string
	IsError bool
	// ResultJSON is the tool's structured output when Claude sends one (Write/Edit:
	// filePath, structuredPatch, originalFile; AskUserQuestion: answers), dropped
	// when over maxResultJSON.
	ResultJSON string
}

// Request is a permission_request or question item's payload (a can_use_tool
// control request).
type Request struct {
	RequestID   string
	ToolName    string
	DisplayName string
	Title       string
	Description string
	ToolUseID   string
	// AgentID is set when a subagent asked.
	AgentID        string
	BlockedPath    string
	DecisionReason string
	// InputJSON is the tool's input; a question's has "questions" (each with
	// question, header, options [{label, description}], multiSelect).
	InputJSON string
	// SuggestionsJSON are Claude's permission_suggestions ("allow for the session"
	// applies them).
	SuggestionsJSON string
	State           RequestState
	// Decision is one of the Decision* constants once resolved.
	Decision string
	// Message is the deny message, or why it was cancelled or auto-denied.
	Message string
	// Answers are a question's answers: question text -> chosen label(s) (several
	// joined with ", ").
	Answers map[string]string
}

// TurnEnd is a turn_end item's payload (the CLI's result).
type TurnEnd struct {
	// Subtype is "success" or error_during_execution, error_max_turns, ...; the
	// daemon's own SubtypeProcessEnded ("process_ended") when the process ended before
	// Claude's result (turnclose.go).
	Subtype string
	IsError bool
	// Interrupted: the turn was stopped by an interrupt.
	Interrupted    bool
	StopReason     string
	TerminalReason string
	DurationMS     int64
	NumTurns       int
	// CostUSD is Claude's estimate for the process so far (cumulative across turns).
	CostUSD float64
	// TurnCostUSD is this turn's share of it (turnCosts); nil when the daemon could
	// not tell, and on items recorded before it existed.
	TurnCostUSD *float64 `json:",omitempty"`
	// Model is the model of the turn's own replies as Claude names it
	// ("claude-haiku-5-5"); "" when the turn had none.
	Model string `json:",omitempty"`
	// ProcessOutputTokens is the process's output tokens so far (modelUsage), kept to
	// tell whether a resumed process carried the previous one's totals over.
	ProcessOutputTokens int64 `json:",omitempty"`
	InputTokens         int64
	OutputTokens        int64
	CacheReadTokens     int64
	CacheWriteTokens    int64
	Errors              []string
}

// Compaction is a compaction item's payload.
type Compaction struct {
	Trigger    string // manual | auto
	PreTokens  int64
	PostTokens int64
}

// PendingRequest is a permission request or question waiting on the user.
type PendingRequest struct {
	RequestID string
	ItemID    string
	// Kind is KindPermission or KindQuestion.
	Kind     ItemKind
	ToolName string
	// Summary is a one-line description ("Write hello.txt", the question).
	Summary string
}

// ItemsSnapshot is a thread's items at one point.
type ItemsSnapshot struct {
	ThreadID string
	// Seq is the thread's event sequence number the snapshot includes: apply only
	// ThreadEvents with a greater Seq.
	Seq     uint64
	Items   []Item
	Pending []PendingRequest
	// Mcp is the thread's MCP servers as last checked (mcp.go), kept while it is not
	// running; nil when Claude never reported them.
	Mcp *McpStatus
	// Commands are the slash commands the thread offers (slashcommands.go): what Claude
	// last reported, kept while it is not running; nil when it never answered a
	// handshake.
	Commands []SlashCommand
	// Agents are the thread's subagent runs, in spawn order (agents.go), without usage;
	// also while it is not running (the persisted runs).
	Agents []AgentRun
}

// Message is a user turn for Store.Send.
type Message struct {
	// Text as typed; cf-file references are rewritten to paths for Claude (filerefs.go)
	// and kept as typed in the item.
	Text string
	// Attachments are StageAttachment paths: a path line in the prompt and a base64
	// image or document block each (none for a PDF over MaxInlinePDFPages).
	Attachments []string
	// ComposerText is the GUI composer's text with its tags as tokens, kept on the
	// user_message item for display only (never sent to Claude).
	ComposerText string
	// Origin is who sends it: the user (OriginUser), or a wake subscription
	// (OriginWake, with WakeTitle and WakeJSON kept on the item for display).
	Origin    MessageOrigin
	WakeTitle string
	WakeJSON  string
	// ByThreadID is the thread that sends it (the CLI's $CODE_FOUNDRY_THREAD), kept on the
	// item as SentBy; "" for the user.
	ByThreadID string
}

// MessageOrigin is who sent a user message.
type MessageOrigin string

// Message origins.
const (
	// OriginUser: the user (the GUI, the CLI, an agent's CLI).
	OriginUser MessageOrigin = ""
	// OriginWake: the daemon, for a wake subscription (subscriptions_fire.go).
	OriginWake MessageOrigin = "wake"
)

// Decision answers a pending request (Store.Respond).
type Decision struct {
	Allow bool
	// ForSession, with Allow, also applies Claude's permission suggestions ("allow for
	// this thread").
	ForSession bool
	// Answers answer a question: question text -> chosen label(s). Required for a
	// question unless denying.
	Answers map[string]string
	// Message is the deny reason Claude sees.
	Message string
	// Interrupt, with a deny, also stops the turn.
	Interrupt bool
}

// ThreadEvent is published on the bus as bus.Publish[thread.ThreadEvent] for every
// change to a thread's items. Seq increases per thread.
type ThreadEvent interface {
	isThreadEvent()
	// Thread is the thread id.
	Thread() string
}

// ItemAppended: a new item (possibly Streaming).
type ItemAppended struct {
	ThreadID string
	Seq      uint64
	Item     Item
}

// ItemUpdated: an item's new full state (completed, a tool result, a decision).
type ItemUpdated struct {
	ThreadID string
	Seq      uint64
	Item     Item
}

// DeltaField names what an ItemDelta extends.
type DeltaField string

// Delta fields.
const (
	DeltaText  DeltaField = "text"  // Item.Text (assistant_text, thinking)
	DeltaInput DeltaField = "input" // Item.Tool.InputJSON (partial JSON)
)

// ItemDelta: Text was appended to a streaming item's Field.
type ItemDelta struct {
	ThreadID string
	Seq      uint64
	ItemID   string
	Ordinal  int64
	Field    DeltaField
	Text     string
}

// PendingChanged: the thread's pending requests changed (the whole list).
type PendingChanged struct {
	ThreadID string
	Seq      uint64
	Pending  []PendingRequest
}

func (ItemAppended) isThreadEvent()   {}
func (ItemUpdated) isThreadEvent()    {}
func (ItemDelta) isThreadEvent()      {}
func (PendingChanged) isThreadEvent() {}

// Thread implements ThreadEvent.
func (e ItemAppended) Thread() string { return e.ThreadID }

// Thread implements ThreadEvent.
func (e ItemUpdated) Thread() string { return e.ThreadID }

// Thread implements ThreadEvent.
func (e ItemDelta) Thread() string { return e.ThreadID }

// Thread implements ThreadEvent.
func (e PendingChanged) Thread() string { return e.ThreadID }

// maxResultJSON bounds ToolCall.ResultJSON (a Read's structured result holds the
// whole file). maxToolOutput bounds ToolCall.Output the same way: every update of
// the item travels whole over the bus and to each watcher, and a Read of a big file
// or a long Bash output can run to megabytes; the tail is replaced by a marker.
const (
	maxResultJSON = 256 << 10
	maxToolOutput = 512 << 10
)

// capOutput cuts s to maxToolOutput bytes (on a rune boundary) with a marker.
func capOutput(s string) string {
	if len(s) <= maxToolOutput {
		return s
	}
	cut := maxToolOutput
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut] + fmt.Sprintf("\n… [output truncated: %d more bytes]", len(s)-cut)
}

// threadLog is one thread's items in memory. Mutations happen on the
// thread's runner goroutine (or while it has none); readers take mu.
type threadLog struct {
	id  string
	bus *bus.Bus
	now func() time.Time

	mu      sync.Mutex
	seq     uint64
	items   []Item
	byID    map[string]int
	nextOrd int64
	mcp     mcpState
	// commands: the slash commands Claude last reported (slashcommands.go); kept, and
	// persisted, while the thread is not running.
	commands []SlashCommand
	// agents: the thread's subagent runs (agents_runner.go setAgents).
	agents []AgentRun
	// saveCommands and saveMcp persist the commands and the MCP status when they change
	// (threadcache_db.go); nil in tests that build a log alone. Called without mu.
	saveCommands func([]SlashCommand)
	saveMcp      func(*McpStatus)
	// saveMu orders the MCP saves (persistMcp); taken without mu.
	saveMu sync.Mutex
}

func newThreadLog(id string, b *bus.Bus, now func() time.Time, items []Item) *threadLog {
	t := &threadLog{id: id, bus: b, now: now, byID: map[string]int{}, nextOrd: 1}
	t.items = slices.Clone(items)
	for _, it := range items {
		if it.Ordinal >= t.nextOrd {
			t.nextOrd = it.Ordinal + 1
		}
	}
	t.reorderLocked() // a placed message (queued.go) sits after its anchor, not at its ordinal
	return t
}

func (t *threadLog) snapshot() ItemsSnapshot {
	t.mu.Lock()
	defer t.mu.Unlock()
	return ItemsSnapshot{ThreadID: t.id, Seq: t.seq, Items: slices.Clone(t.items), Pending: pendingOf(t.items), Mcp: t.mcp.status, Commands: t.commands,
		Agents: t.agents}
}

// get returns the item with id.
func (t *threadLog) get(id string) (Item, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	i, ok := t.byID[id]
	if !ok {
		return Item{}, false
	}
	return t.items[i], true
}

// last returns the newest item.
func (t *threadLog) last() (Item, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if len(t.items) == 0 {
		return Item{}, false
	}
	return t.items[len(t.items)-1], true
}

// append adds it with the next ordinal (an existing id is updated instead) and
// returns it as stored.
func (t *threadLog) append(it Item) Item {
	t.mu.Lock()
	defer t.mu.Unlock()
	if i, ok := t.byID[it.ID]; ok {
		it.Ordinal, it.CreatedAt, it.PlacedAfter = t.items[i].Ordinal, t.items[i].CreatedAt, t.items[i].PlacedAfter
		it.UpdatedAt = t.now()
		t.items[i] = it
		t.publishLocked(func(seq uint64) ThreadEvent { return ItemUpdated{ThreadID: t.id, Seq: seq, Item: it} }, it.Kind)
		return it
	}
	now := t.now()
	it.Ordinal, it.CreatedAt, it.UpdatedAt = t.nextOrd, now, now
	t.nextOrd++
	t.byID[it.ID] = len(t.items)
	t.items = append(t.items, it)
	t.publishLocked(func(seq uint64) ThreadEvent { return ItemAppended{ThreadID: t.id, Seq: seq, Item: it} }, it.Kind)
	return it
}

// update applies fn to item id and publishes its new state.
func (t *threadLog) update(id string, fn func(*Item)) (Item, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	i, ok := t.byID[id]
	if !ok {
		return Item{}, false
	}
	it := cloneItem(t.items[i])
	fn(&it)
	it.UpdatedAt = t.now()
	t.items[i] = it
	t.publishLocked(func(seq uint64) ThreadEvent { return ItemUpdated{ThreadID: t.id, Seq: seq, Item: it} }, it.Kind)
	return it, true
}

// delta appends text to a streaming item's field.
func (t *threadLog) delta(id string, field DeltaField, text string) {
	if text == "" {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	i, ok := t.byID[id]
	if !ok {
		return
	}
	it := t.items[i]
	switch field {
	case DeltaText:
		it.Text += text
	case DeltaInput:
		if it.Tool == nil {
			return
		}
		tc := *it.Tool
		tc.InputJSON += text
		it.Tool = &tc
	}
	t.items[i] = it
	t.seq++
	bus.Publish[ThreadEvent](t.bus, ItemDelta{ThreadID: t.id, Seq: t.seq, ItemID: id, Ordinal: it.Ordinal, Field: field, Text: text})
}

// publishLocked bumps seq and publishes ev, then PendingChanged when a request item
// changed (the pending list may have).
func (t *threadLog) publishLocked(ev func(seq uint64) ThreadEvent, kind ItemKind) {
	t.seq++
	bus.Publish(t.bus, ev(t.seq))
	if kind == KindPermission || kind == KindQuestion {
		t.seq++
		bus.Publish[ThreadEvent](t.bus, PendingChanged{ThreadID: t.id, Seq: t.seq, Pending: pendingOf(t.items)})
	}
}

// unfinished returns the items still streaming or running, pending requests, and
// messages still queued.
func (t *threadLog) unfinished() []Item {
	t.mu.Lock()
	defer t.mu.Unlock()
	var out []Item
	for _, it := range t.items {
		if it.Streaming || it.Queued || (it.Tool != nil && it.Tool.Status == ToolRunning) || (it.Request != nil && it.Request.State == RequestPending) {
			out = append(out, it)
		}
	}
	return out
}

func pendingOf(items []Item) []PendingRequest {
	var out []PendingRequest
	for _, it := range items {
		if it.Request == nil || it.Request.State != RequestPending {
			continue
		}
		out = append(out, PendingRequest{
			RequestID: it.Request.RequestID, ItemID: it.ID, Kind: it.Kind, ToolName: it.Request.ToolName,
			Summary: requestSummary(it),
		})
	}
	return out
}

// requestSummary is a request item's one-line description: a question's first
// question, else "<Tool> <description or title>".
func requestSummary(it Item) string {
	r := it.Request
	if it.Kind == KindQuestion {
		if qs := questionsOf(r.InputJSON); len(qs) > 0 {
			return qs[0].Question
		}
		return "question"
	}
	what := r.Description
	if what == "" {
		what = r.Title
	}
	name := r.DisplayName
	if name == "" {
		name = r.ToolName
	}
	return strings.TrimSpace(name + " " + what)
}

func cloneItem(it Item) Item {
	if it.Tool != nil {
		t := *it.Tool
		it.Tool = &t
	}
	if it.Request != nil {
		r := *it.Request
		if r.Answers != nil {
			a := make(map[string]string, len(r.Answers))
			for k, v := range r.Answers {
				a[k] = v
			}
			r.Answers = a
		}
		it.Request = &r
	}
	if it.Turn != nil {
		t := *it.Turn
		t.Errors = slices.Clone(t.Errors)
		it.Turn = &t
	}
	if it.Compaction != nil {
		c := *it.Compaction
		it.Compaction = &c
	}
	if it.HTML != nil {
		h := *it.HTML
		it.HTML = &h
	}
	if it.Theme != nil {
		c := *it.Theme
		c.File = c.File.Clone()
		it.Theme = &c
	}
	it.Attachments = slices.Clone(it.Attachments)
	return it
}

// thread returns the thread's item log, loading it from the database the
// first time.
func (m *Manager) thread(ctx context.Context, id string) (*threadLog, error) {
	// m.mu before (never inside) m.tmu: Remove takes them the other way round. The
	// record, not the snapshot: Create's spawn gets here before the first publish.
	m.mu.Lock()
	rec, err := m.record(id)
	if err != nil {
		m.mu.Unlock()
		return nil, err
	}
	idle := rec.run == nil
	runs := rec.s.AgentRuns
	m.mu.Unlock()
	m.tmu.Lock()
	defer m.tmu.Unlock()
	if t, ok := m.threads[id]; ok {
		return t, nil
	}
	items, err := loadItems(ctx, m.opts.DB, id)
	if err != nil {
		return nil, err
	}
	t := newThreadLog(id, m.opts.Bus, m.opts.Now, items)
	t.agents = logAgents(runs)
	// What Claude last reported outlives its process (threadcache_db.go).
	cmds, mcp, err := loadThreadCache(ctx, m.opts.DB, id)
	if err != nil {
		m.log.Warn("load thread cache", "thread", id, "err", err)
	}
	t.commands, t.mcp.status = cmds, mcp
	t.saveCommands = func(cs []SlashCommand) {
		if err := saveSlashCommands(context.Background(), m.opts.DB, id, cs); err != nil {
			m.log.Error("persist slash commands", "thread", id, "err", err)
		}
	}
	t.saveMcp = func(s *McpStatus) {
		if err := saveMcpStatus(context.Background(), m.opts.DB, id, s); err != nil {
			m.log.Error("persist MCP status", "thread", id, "err", err)
		}
	}
	m.threads[id] = t
	if idle {
		// A run the daemon lost (a crash) left items and its turn open; nothing will
		// finish them.
		closeLostRun(itemWriter{log: t, save: func(it Item) { m.saveItem(id, it) }}, "the thread's process ended")
	}
	return t, nil
}

// Items implements Store.
func (m *Manager) Items(ctx context.Context, id string) (ItemsSnapshot, error) {
	t, err := m.thread(ctx, id)
	if err != nil {
		return ItemsSnapshot{}, err
	}
	return t.snapshot(), nil
}

// WatchItems implements Store: it counts a viewer until ctx ends (see
// runner.acknowledge and attended.go) and returns the snapshot.
func (m *Manager) WatchItems(ctx context.Context, id string) (ItemsSnapshot, error) {
	t, err := m.thread(ctx, id)
	if err != nil {
		return ItemsSnapshot{}, err
	}
	m.addViewer(id, 1)
	context.AfterFunc(ctx, func() { m.addViewer(id, -1) })
	return t.snapshot(), nil
}

// addViewer changes the thread's viewer count and tells its runner.
func (m *Manager) addViewer(id string, d int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.viewers[id] += d
	if m.viewers[id] <= 0 {
		delete(m.viewers, id)
	}
	rec, ok := m.recs[id]
	if ok && d > 0 && m.attended() && m.seenFlagsLocked(rec) {
		// The user opened the thread while looking at the app: its until-seen flags are
		// seen (flags.go). Otherwise they are once presence is attended (attended.go).
		m.commitLocked(rec, false)
	}
	if ok && rec.run != nil {
		rec.run.viewersChanged()
	}
}

// Viewed reports whether the thread has a viewer now: a GUI view showing it holds a
// ThreadService.WatchThread stream (WatchItems), whether or not presence is attended.
// Read-only; ui.presence reports it to the thread's own model.
func (m *Manager) Viewed(id string) bool { return m.viewerCount(id) > 0 }

func (m *Manager) viewerCount(id string) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.viewers[id]
}
