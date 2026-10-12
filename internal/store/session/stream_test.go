package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/claudestream"
)

// renderedEnv is an env whose claude is the fake (fakeclaude_test.go) replaying
// fixture, defaulting new threads to rendered.
type renderedEnv struct {
	*env
	log, argv string
	mutate    func(*Options)
}

func newRenderedEnv(t *testing.T, fixture string) *renderedEnv {
	t.Helper()
	return newRenderedEnvAt(t, fixturePath(fixture))
}

// newRenderedEnvAt is newRenderedEnv replaying the capture at path (absolute).
// env adds variables to the fake's environment (its knobs, fakeclaude_test.go).
func newRenderedEnvAt(t *testing.T, path string, env ...string) *renderedEnv {
	t.Helper()
	dir := t.TempDir()
	re := &renderedEnv{log: filepath.Join(dir, "stdin.log"), argv: filepath.Join(dir, "argv.json")}
	re.mutate = func(o *Options) {
		o.Claude = os.Args[0]
		o.Env = append([]string{fakeClaudeEnv + "=" + path, "CF_FAKE_CLAUDE_LOG=" + re.log, "CF_FAKE_CLAUDE_ARGV=" + re.argv}, env...)
		o.DefaultRender = func() Render { return RenderRendered }
		o.DisablePreTrust = true
	}
	re.env = newEnv(t, re.mutate)
	return re
}

// sent returns what the daemon wrote to the fake's stdin, decoded.
func (re *renderedEnv) sent() []map[string]any {
	data, _ := os.ReadFile(re.log)
	var out []map[string]any
	for _, l := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var m map[string]any
		if json.Unmarshal([]byte(l), &m) == nil {
			out = append(out, m)
		}
	}
	return out
}

// waitSent waits for a stdin line satisfying cond.
func (re *renderedEnv) waitSent(what string, cond func(map[string]any) bool) map[string]any {
	re.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		for _, m := range re.sent() {
			if cond(m) {
				return m
			}
		}
		if time.Now().After(deadline) {
			re.t.Fatalf("never sent %s; sent %v", what, re.sent())
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (re *renderedEnv) items(id string) ItemsSnapshot {
	re.t.Helper()
	snap, err := re.m.Items(re.ctx(), id)
	if err != nil {
		re.t.Fatal(err)
	}
	return snap
}

// waitItems waits until the thread's items satisfy cond.
func (re *renderedEnv) waitItems(id, what string, cond func([]Item) bool) []Item {
	re.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		items := re.items(id).Items
		if cond(items) {
			return items
		}
		if time.Now().After(deadline) {
			re.t.Fatalf("timed out waiting for %s; items:\n%s", what, describeItems(items))
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func describeItems(items []Item) string {
	var sb strings.Builder
	for _, it := range items {
		fmt.Fprintf(&sb, "  %d %s %s streaming=%v %q", it.Ordinal, it.Kind, it.ID, it.Streaming, trunc(it.Text, 40))
		if it.Tool != nil {
			fmt.Fprintf(&sb, " tool=%s %s", it.Tool.Name, it.Tool.Status)
		}
		if it.Request != nil {
			fmt.Fprintf(&sb, " req=%s %s", it.Request.ToolName, it.Request.State)
		}
		sb.WriteString("\n")
	}
	return sb.String()
}

func trunc(s string, n int) string {
	if len(s) > n {
		return s[:n] + "…"
	}
	return s
}

func kinds(items []Item) []string {
	out := make([]string, len(items))
	for i, it := range items {
		out[i] = string(it.Kind)
	}
	return out
}

func lastKind(items []Item, k ItemKind) (Item, bool) {
	for i := len(items) - 1; i >= 0; i-- {
		if items[i].Kind == k {
			return items[i], true
		}
	}
	return Item{}, false
}

func hasTurnEnd(items []Item) bool { _, ok := lastKind(items, KindTurnEnd); return ok }

func TestRenderedWritePermissionEndToEnd(t *testing.T) {
	re := newRenderedEnv(t, "write-allow")
	s := re.create(CreateOptions{Model: "haiku", Effort: "low", PermissionMode: PermissionSupervised,
		InitialPrompt: "  create @cf-file://r1/hello.txt please  ", ComposerPrompt: "create [hello.txt](cf-file://r1/hello.txt) please"})
	if s.Render != RenderRendered || s.TerminalID != "" {
		t.Fatalf("created %+v", s)
	}
	var argv []string
	re.waitFor(s.ID, "connected", func(s Session) bool { return s.State == StateConnected })
	if b, err := os.ReadFile(re.argv); err == nil {
		_ = json.Unmarshal(b, &argv)
	}
	for _, want := range [][]string{{"-p"}, {"--input-format", "stream-json"}, {"--output-format", "stream-json"}, {"--verbose"},
		{"--include-partial-messages"}, {"--permission-prompt-tool", "stdio"}, {"--model", "haiku"}, {"--permission-mode", "manual"}} {
		if i := slices.Index(argv, want[0]); i < 0 || (len(want) == 2 && argOf(argv, want[0]) != want[1]) {
			t.Errorf("argv %q lacks %q", argv, want)
		}
	}
	if slices.Contains(argv, "--") || slices.ContainsFunc(argv, func(a string) bool { return strings.Contains(a, "hello.txt") }) {
		t.Errorf("prompt in argv: %q", argv)
	}

	// The handshake comes first, then the prompt as the first user message, file
	// references rewritten for Claude.
	msgs := re.sent()
	if len(msgs) < 2 || msgs[0]["type"] != "control_request" {
		t.Fatalf("stdin = %v", msgs)
	}
	user := re.waitSent("the prompt", func(m map[string]any) bool { return m["type"] == "user" })
	content := user["message"].(map[string]any)["content"].([]any)
	if text := content[0].(map[string]any)["text"]; text != "create @"+filepath.Join(re.wt, "hello.txt")+" please" {
		t.Errorf("prompt text = %q", text)
	}

	// Claude asks to Write: needs attention, one pending request.
	got := re.waitFor(s.ID, "permission", func(s Session) bool { return s.Status == StatusNeedsAttention })
	if got.StatusReason != "permission: Write hello.txt" {
		t.Errorf("reason %q", got.StatusReason)
	}
	snap := re.items(s.ID)
	if len(snap.Pending) != 1 || snap.Pending[0].Kind != KindPermission || snap.Pending[0].Summary != "Write hello.txt" {
		t.Fatalf("pending %+v", snap.Pending)
	}
	first := snap.Items[0]
	if first.Kind != KindUserMessage || first.Text != "create @cf-file://r1/hello.txt please" || first.ID != user["uuid"] ||
		first.ComposerText != "create [hello.txt](cf-file://r1/hello.txt) please" {
		t.Errorf("first item %+v (sent uuid %v)", first, user["uuid"])
	}
	tool, _ := lastKind(snap.Items, KindToolCall)
	if tool.Streaming || tool.Tool.Name != "Write" || tool.Tool.Status != ToolRunning || !strings.Contains(tool.Tool.InputJSON, `"content":"hi"`) {
		t.Errorf("tool item %+v %+v", tool, tool.Tool)
	}

	if _, err := re.m.Respond(re.ctx(), s.ID, "nope", Decision{Allow: true}); !errors.Is(err, ErrNotFound) {
		t.Errorf("respond to unknown request: %v", err)
	}
	reqID := snap.Pending[0].RequestID
	it, err := re.m.Respond(re.ctx(), s.ID, reqID, Decision{Allow: true})
	if err != nil {
		t.Fatal(err)
	}
	if it.Request.State != RequestAllowed || it.Request.Decision != DecisionAllow {
		t.Errorf("resolved %+v", it.Request)
	}
	ans := re.waitSent("the answer", func(m map[string]any) bool { return m["type"] == "control_response" })
	inner := ans["response"].(map[string]any)["response"].(map[string]any)
	if inner["behavior"] != "allow" || inner["updatedInput"].(map[string]any)["content"] != "hi" {
		t.Errorf("answer %v", ans)
	}

	items := re.waitItems(s.ID, "turn end", hasTurnEnd)
	want := []string{"user_message", "tool_call", "permission_request", "thinking", "assistant_text", "turn_end"}
	if !slices.Equal(kinds(items), want) {
		t.Errorf("kinds %v, want %v\n%s", kinds(items), want, describeItems(items))
	}
	tool, _ = lastKind(items, KindToolCall)
	if tool.Tool.Status != ToolDone || !strings.Contains(tool.Tool.Output, "File created successfully") || !strings.Contains(tool.Tool.ResultJSON, `"type":"create"`) {
		t.Errorf("tool after result %+v", tool.Tool)
	}
	text, _ := lastKind(items, KindAssistantText)
	turn, _ := lastKind(items, KindTurnEnd)
	if text.Text != "done" || text.Streaming || turn.Turn.Subtype != "success" || turn.Turn.CostUSD <= 0 || turn.Turn.OutputTokens == 0 {
		t.Errorf("text %+v turn %+v", text, turn.Turn)
	}
	for i, it := range items {
		if it.Ordinal != int64(i+1) {
			t.Errorf("ordinal %d at %d", it.Ordinal, i)
		}
	}
	// Nobody watched: the finished turn needs attention.
	re.waitFor(s.ID, "finished", func(s Session) bool { return s.Status == StatusNeedsAttention && s.StatusReason == "finished" })

	// The items survive a daemon restart; the thread is disconnected, its status kept.
	re.restart(re.mutate)
	after := re.items(s.ID).Items
	if !slices.Equal(kinds(after), want) {
		t.Fatalf("rehydrated %v\n%s", kinds(after), describeItems(after))
	}
	for i := range after {
		a, b := after[i], items[i]
		if a.ID != b.ID || a.Ordinal != b.Ordinal || a.Text != b.Text || a.ComposerText != b.ComposerText || a.Streaming || fmt.Sprint(a.Tool) != fmt.Sprint(b.Tool) || fmt.Sprint(a.Request) != fmt.Sprint(b.Request) {
			t.Errorf("item %d changed across restart:\n%+v\n%+v", i, a, b)
		}
	}
	got, _ = re.m.Get(re.ctx(), s.ID)
	if got.State != StateDisconnected || got.Render != RenderRendered || got.StatusReason != "finished" {
		t.Errorf("after restart %+v", got)
	}
	if _, err := re.m.Send(re.ctx(), s.ID, Message{Text: "more"}); !errors.Is(err, ErrFailedPrecondition) {
		t.Errorf("send while disconnected: %v", err)
	}

	// Reconnect keeps the mode and appends after the old items.
	if _, err := re.m.Reconnect(re.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	re.waitFor(s.ID, "reconnected", func(s Session) bool {
		return s.State == StateConnected && s.Render == RenderRendered && s.TerminalID == ""
	})
	sentIt, err := re.m.Send(re.ctx(), s.ID, Message{Text: "/tdd again", ComposerText: "[/tdd](cf-skill://~/tdd) again"})
	if err != nil {
		t.Fatal(err)
	}
	if sentIt.Ordinal != int64(len(want)+1) || sentIt.Text != "/tdd again" || sentIt.ComposerText != "[/tdd](cf-skill://~/tdd) again" {
		t.Errorf("appended %+v", sentIt)
	}
	if err := re.m.Close(re.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	got, _ = re.m.Get(re.ctx(), s.ID)
	if got.State != StateDisconnected || got.DisconnectReason != ReasonClosed {
		t.Errorf("after close %+v", got)
	}
}

func (e *env) restartWith(mutate ...func(*Options)) {
	e.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := e.m.Shutdown(ctx); err != nil {
		e.t.Fatal(err)
	}
	e.open(mutate...)
}

func (re *renderedEnv) restart(mutate func(*Options)) { re.restartWith(mutate) }

func TestRenderedWatchItemsAcknowledges(t *testing.T) {
	re := newRenderedEnv(t, "text-table")
	sub := bus.Subscribe[ThreadEvent](re.bus, 4096)
	defer sub.Close()
	ctx, cancel := context.WithCancel(context.Background())
	s := re.create(CreateOptions{InitialPrompt: "a table please"})
	snap, err := re.m.WatchItems(ctx, s.ID)
	if err != nil {
		t.Fatal(err)
	}
	items := re.waitItems(s.ID, "turn end", hasTurnEnd)
	// A viewer saw the turn finish: idle, not "finished".
	re.waitFor(s.ID, "idle", func(s Session) bool { return s.Status == StatusIdle && s.StatusReason == "at prompt" })
	cancel()

	// Replaying the events after the snapshot rebuilds the same items, the streamed
	// text included.
	byID := map[string]Item{}
	for _, it := range snap.Items {
		byID[it.ID] = it
	}
	deltas := 0
	deadline := time.After(2 * time.Second)
	for len(byID) < len(items) || !strings.Contains(byID[items[1].ID].Text, "Earth") {
		select {
		case ev := <-sub.C():
			if ev.Thread() != s.ID {
				continue
			}
			switch e := ev.(type) {
			case ItemAppended:
				if e.Seq > snap.Seq {
					byID[e.Item.ID] = e.Item
				}
			case ItemUpdated:
				if e.Seq > snap.Seq {
					byID[e.Item.ID] = e.Item
				}
			case ItemDelta:
				if e.Seq > snap.Seq {
					deltas++
					it := byID[e.ItemID]
					it.Text += e.Text
					byID[e.ItemID] = it
				}
			}
		case <-deadline:
			t.Fatalf("events never rebuilt the items: %v", byID)
		}
	}
	text, _ := lastKind(items, KindAssistantText)
	if byID[text.ID].Text != text.Text || !strings.Contains(text.Text, "| 3 | Earth |") || deltas == 0 {
		t.Errorf("rebuilt %q, items %q, deltas %d", byID[text.ID].Text, text.Text, deltas)
	}
}

func TestRenderedQuestion(t *testing.T) {
	re := newRenderedEnv(t, "ask")
	s := re.create(CreateOptions{InitialPrompt: "ask me"})
	re.waitFor(s.ID, "question", func(s Session) bool {
		return s.Status == StatusNeedsAttention && s.StatusReason == "question: Which color do you prefer?"
	})
	p := re.items(s.ID).Pending
	if len(p) != 1 || p[0].Kind != KindQuestion {
		t.Fatalf("pending %+v", p)
	}
	if _, err := re.m.Respond(re.ctx(), s.ID, p[0].RequestID, Decision{Allow: true}); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("answer without answers: %v", err)
	}
	it, err := re.m.Respond(re.ctx(), s.ID, p[0].RequestID, Decision{Allow: true, Answers: map[string]string{"Which color do you prefer?": "Blue"}})
	if err != nil {
		t.Fatal(err)
	}
	if it.Kind != KindQuestion || it.Request.Answers["Which color do you prefer?"] != "Blue" {
		t.Errorf("answered %+v", it.Request)
	}
	ans := re.waitSent("the answer", func(m map[string]any) bool { return m["type"] == "control_response" })
	up := ans["response"].(map[string]any)["response"].(map[string]any)["updatedInput"].(map[string]any)
	if up["answers"].(map[string]any)["Which color do you prefer?"] != "Blue" || len(up["questions"].([]any)) != 1 {
		t.Errorf("updatedInput %v", up)
	}
	re.waitItems(s.ID, "turn end", hasTurnEnd)
}

func TestRenderedDenyAndSubagent(t *testing.T) {
	t.Run("deny", func(t *testing.T) {
		re := newRenderedEnv(t, "write-deny")
		s := re.create(CreateOptions{InitialPrompt: "write"})
		re.waitFor(s.ID, "permission", func(s Session) bool { return s.Status == StatusNeedsAttention })
		p := re.items(s.ID).Pending
		it, err := re.m.Respond(re.ctx(), s.ID, p[0].RequestID, Decision{Message: "The user denied this."})
		if err != nil || it.Request.State != RequestDenied || it.Request.Decision != DecisionDeny {
			t.Fatalf("deny: %+v %v", it.Request, err)
		}
		ans := re.waitSent("the denial", func(m map[string]any) bool { return m["type"] == "control_response" })
		res := ans["response"].(map[string]any)["response"].(map[string]any)
		if res["behavior"] != "deny" || res["message"] != rejectWithReason+"The user denied this." {
			t.Errorf("deny sent %v", res)
		}
		items := re.waitItems(s.ID, "turn end", hasTurnEnd)
		tool, _ := lastKind(items, KindToolCall)
		if tool.Tool.Status != ToolError || !tool.Tool.IsError {
			t.Errorf("denied tool %+v", tool.Tool)
		}
	})
	t.Run("subagent", func(t *testing.T) {
		re := newRenderedEnv(t, "task")
		s := re.create(CreateOptions{InitialPrompt: "agent"})
		re.waitFor(s.ID, "permission", func(s Session) bool { return s.Status == StatusNeedsAttention })
		p := re.items(s.ID).Pending
		if _, err := re.m.Respond(re.ctx(), s.ID, p[0].RequestID, Decision{Allow: true, ForSession: true}); err != nil {
			t.Fatal(err)
		}
		ans := re.waitSent("the answer", func(m map[string]any) bool { return m["type"] == "control_response" })
		if perms := ans["response"].(map[string]any)["response"].(map[string]any)["updatedPermissions"]; perms == nil {
			t.Errorf("allow for session sent no permissions: %v", ans)
		}
		items := re.waitItems(s.ID, "turn end", hasTurnEnd)
		var agent, sub Item
		for _, it := range items {
			if it.Kind == KindToolCall && it.Tool.Name == "Agent" {
				agent = it
			}
			if it.Kind == KindToolCall && it.ParentToolUseID != "" {
				sub = it
			}
		}
		perm, _ := lastKind(items, KindPermission)
		if agent.ID == "" || sub.ParentToolUseID != agent.ID || sub.Tool.Name != "Write" || sub.Tool.Status != ToolDone ||
			perm.Request.AgentID == "" || perm.Request.Decision != DecisionAllowForSession || agent.Tool.Status != ToolDone {
			t.Errorf("agent %+v sub %+v perm %+v\n%s", agent.Tool, sub, perm.Request, describeItems(items))
		}
	})
}

func TestRenderedControls(t *testing.T) {
	re := newRenderedEnv(t, "text-table")
	s := re.create(CreateOptions{Render: RenderRendered})
	re.waitFor(s.ID, "connected", func(s Session) bool { return s.State == StateConnected })
	// No prompt: idle at the prompt once initialized.
	re.waitFor(s.ID, "idle", func(s Session) bool { return s.Status == StatusIdle })
	if err := re.m.Interrupt(re.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	re.waitSent("interrupt", func(m map[string]any) bool {
		r, _ := m["request"].(map[string]any)
		return r["subtype"] == "interrupt"
	})
	got, err := re.m.SetModel(re.ctx(), s.ID, "sonnet")
	if err != nil || got.Model != "sonnet" {
		t.Fatalf("set model %+v %v", got, err)
	}
	if _, err := re.m.SetPermissionMode(re.ctx(), s.ID, PermissionDefault); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("set default mode: %v", err)
	}
	got, err = re.m.SetPermissionMode(re.ctx(), s.ID, PermissionSupervised)
	if err != nil || got.PermissionMode != PermissionSupervised {
		t.Fatalf("set mode %+v %v", got, err)
	}
	re.waitSent("set_permission_mode default", func(m map[string]any) bool {
		r, _ := m["request"].(map[string]any)
		return r["subtype"] == "set_permission_mode" && r["mode"] == "default"
	})
	if _, err := re.m.Send(re.ctx(), s.ID, Message{Text: "  "}); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("empty send: %v", err)
	}

	// A terminal thread refuses the rendered calls.
	term := re.create(CreateOptions{Render: RenderTerminal})
	if term.Render != RenderTerminal || term.TerminalID == "" {
		t.Fatalf("terminal thread %+v", term)
	}
	if _, err := re.m.Items(re.ctx(), term.ID); !errors.Is(err, ErrFailedPrecondition) {
		t.Errorf("items of a terminal thread: %v", err)
	}
	if _, err := re.m.Send(re.ctx(), term.ID, Message{Text: "x"}); !errors.Is(err, ErrFailedPrecondition) {
		t.Errorf("send to a terminal thread: %v", err)
	}
	// Fork keeps the mode.
	re.writeTranscript("c-fork", userLine("hi"))
	re.m.mu.Lock()
	re.m.recs[s.ID].s.ClaudeSessionID = "c-fork"
	re.m.mu.Unlock()
	f, err := re.m.Fork(re.ctx(), s.ID, "")
	if err != nil || f.Render != RenderRendered {
		t.Fatalf("fork %+v %v", f, err)
	}
}

func TestDefaultRender(t *testing.T) {
	for _, tt := range []struct {
		def  func() Render
		opt  Render
		want Render
	}{
		{nil, RenderDefault, RenderTerminal},
		{func() Render { return RenderTerminal }, RenderDefault, RenderTerminal},
		{func() Render { return RenderTerminal }, RenderRendered, RenderRendered},
		{func() Render { return RenderRendered }, RenderTerminal, RenderTerminal},
		// A Create that does not pick (pr.ask / pr.explain / pr.fix.findings, the CLI
		// without --render) follows the setting.
		{func() Render { return RenderRendered }, RenderDefault, RenderRendered},
	} {
		e := newEnv(t, func(o *Options) {
			o.DefaultRender = tt.def
			o.Claude = os.Args[0]
			o.Env = []string{fakeClaudeEnv + "=" + fixturePath("text-table")}
		})
		s := e.create(CreateOptions{Render: tt.opt})
		if s.Render != tt.want {
			t.Errorf("default %v, asked %v: got %v", tt.def != nil, tt.opt, s.Render)
		}
	}
	e := newEnv(t)
	if _, err := e.m.Create(e.ctx(), CreateOptions{WorktreePath: e.wt, Render: Render(9)}); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("bad render: %v", err)
	}
}

func TestRenderedRunInUsesSetCwd(t *testing.T) {
	re := newRenderedEnv(t, "text-table")
	s := re.create(CreateOptions{})
	re.waitFor(s.ID, "idle", func(s Session) bool { return s.Status == StatusIdle })
	other := filepath.Join(t.TempDir(), "other")
	if err := os.MkdirAll(other, 0o755); err != nil {
		t.Fatal(err)
	}
	// The runner path, without a workspace store: queue a move directly.
	re.m.mu.Lock()
	run := re.m.recs[s.ID].run
	re.m.recs[s.ID].s.PendingWorktreePath = other
	run.cdReq <- cdRequest{path: other, repoID: "r2"}
	re.m.mu.Unlock()
	got := re.waitFor(s.ID, "moved", func(s Session) bool { return s.WorktreePath == other })
	if got.RepoID != "r2" || got.PendingWorktreePath != "" {
		t.Errorf("after move %+v", got)
	}
	re.waitSent("set_cwd", func(m map[string]any) bool {
		r, _ := m["request"].(map[string]any)
		return r["subtype"] == "set_cwd" && r["path"] == other
	})
}

// TestProjectFixtures feeds each captured stream through the projector alone.
func TestProjectFixtures(t *testing.T) {
	tests := []struct {
		fixture string
		want    []string // kind[:detail]
	}{
		{"text-table", []string{"assistant_text:| Order from Sun | Planet |", "turn_end:success"}},
		{"write-allow", []string{"tool_call:Write done", "thinking:", "assistant_text:done", "turn_end:success"}},
		{"bash", []string{"tool_call:Bash done", "thinking:", "assistant_text:The command ran successfully.", "turn_end:success"}},
		{"interrupt", []string{"assistant_text:one", "turn_end:error_during_execution interrupted"}},
		{"interrupt-pending", []string{"tool_call:Write error", "turn_end:error_during_execution interrupted"}},
		{"compact", []string{"assistant_text:Hello (English)", "turn_end:success", "compaction:This session is being continued", "command_output:Compacted", "turn_end:success"}},
		{"task", []string{"tool_call:Agent done", "tool_call:Write done sub", "thinking:", "assistant_text:Done.", "turn_end:success"}},
	}
	for _, tt := range tests {
		t.Run(tt.fixture, func(t *testing.T) {
			data, err := os.ReadFile(fixturePath(tt.fixture))
			if err != nil {
				t.Fatal(err)
			}
			log := newThreadLog("s", bus.New(), time.Now, nil)
			saved := map[string]Item{}
			p := newProjector(itemWriter{log: log, save: func(it Item) { saved[it.ID] = it }}, runningTotals{known: true})
			var sp claudestream.Splitter
			for _, line := range sp.Split(nil, data) {
				p.event(claudestream.Parse(line))
			}
			items := log.snapshot().Items
			var got []string
			for _, it := range items {
				d := ""
				switch it.Kind {
				case KindToolCall:
					d = it.Tool.Name + " " + string(it.Tool.Status)
					if it.ParentToolUseID != "" {
						d += " sub"
					}
				case KindTurnEnd:
					d = it.Turn.Subtype
					if it.Turn.Interrupted {
						d += " interrupted"
					}
				default:
					d = firstLine(it.Text)
				}
				got = append(got, string(it.Kind)+":"+d)
				if it.Streaming {
					t.Errorf("%s still streaming", it.ID)
				}
				if s, ok := saved[it.ID]; !ok || fmt.Sprint(s) != fmt.Sprint(it) {
					t.Errorf("%s not saved in its final state", it.ID)
				}
			}
			if len(got) != len(tt.want) {
				t.Fatalf("got %q\nwant %q", got, tt.want)
			}
			for i := range got {
				if !strings.HasPrefix(got[i], tt.want[i]) {
					t.Errorf("item %d = %q, want prefix %q", i, got[i], tt.want[i])
				}
			}
		})
	}
}

func firstLine(s string) string {
	s, _, _ = strings.Cut(s, "\n")
	return s
}

func TestRenderedFirstPromptWithImage(t *testing.T) {
	dir := t.TempDir()
	re := &renderedEnv{log: filepath.Join(dir, "stdin.log"), argv: filepath.Join(dir, "argv.json")}
	re.mutate = func(o *Options) {
		o.Claude = os.Args[0]
		o.Env = []string{fakeClaudeEnv + "=" + fixturePath("image"), "CF_FAKE_CLAUDE_LOG=" + re.log, "CF_FAKE_CLAUDE_ARGV=" + re.argv}
		o.DisablePreTrust = true
		o.AttachmentsDir = filepath.Join(dir, "attachments")
	}
	re.env = newEnv(t, re.mutate)
	// A 1x1 PNG.
	png := []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\xf8\xcf\xc0\x00\x00\x03\x01\x01\x00\xc9\xfe\x92\xef\x00\x00\x00\x00IEND\xaeB`\x82")
	path, err := re.m.StageAttachment(re.ctx(), "red.png", "image/png", png)
	if err != nil {
		t.Fatal(err)
	}
	s := re.create(CreateOptions{Render: RenderRendered, InitialPrompt: "What color?", Attachments: []string{path}})
	user := re.waitSent("the prompt", func(m map[string]any) bool { return m["type"] == "user" })
	content := user["message"].(map[string]any)["content"].([]any)
	if len(content) != 2 {
		t.Fatalf("content %v", content)
	}
	if text := content[0].(map[string]any)["text"]; text != "What color?\n\nAttached image: "+path {
		t.Errorf("text block %q", text)
	}
	src := content[1].(map[string]any)["source"].(map[string]any)
	if content[1].(map[string]any)["type"] != "image" || src["media_type"] != "image/png" || src["type"] != "base64" || src["data"] == "" {
		t.Errorf("image block %v", content[1])
	}
	items := re.waitItems(s.ID, "turn end", hasTurnEnd)
	if items[0].Text != "What color?" || !slices.Equal(items[0].Attachments, []string{path}) {
		t.Errorf("user item %+v", items[0])
	}
}

// TestRenderedStartCrash: a claude that dies before answering the initialize
// handshake (here the fake, whose fixture is missing: exit 2 with a stderr line) ends
// the thread crashed, with the stderr line as LastError and an error item, not
// "closed" (the close path is for a process that is alive and silent).
func TestRenderedStartCrash(t *testing.T) {
	re := newRenderedEnv(t, "no-such-fixture")
	s := re.create(CreateOptions{InitialPrompt: "hi"})
	got := re.waitFor(s.ID, "disconnected", func(s Session) bool { return s.State == StateDisconnected })
	if got.DisconnectReason != ReasonCrashed || got.ExitCode != 2 || !strings.Contains(got.LastError, "fake claude") {
		t.Errorf("after crash %+v", got)
	}
	items := re.items(s.ID).Items
	errItem, ok := lastKind(items, KindError)
	if !ok || !strings.Contains(errItem.Text, "before answering the initialize handshake") || !strings.Contains(errItem.Text, "fake claude") {
		t.Errorf("items:\n%s", describeItems(items))
	}
	if _, err := re.m.Reconnect(re.ctx(), s.ID); err != nil {
		t.Fatalf("reconnect after a crash: %v", err)
	}
}

// TestProjectToolOutputCap: a tool result longer than maxToolOutput keeps its head
// and a marker (the structured result is dropped over maxResultJSON already).
func TestProjectToolOutputCap(t *testing.T) {
	log := newThreadLog("s", bus.New(), time.Now, nil)
	p := newProjector(itemWriter{log: log, save: func(Item) {}}, runningTotals{known: true})
	p.event(claudestream.Parse([]byte(`{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"big"}}]},"parent_tool_use_id":null}`)))
	big := strings.Repeat("é", maxToolOutput/2+100) // multi-byte: the cut must land on a rune boundary
	line, _ := json.Marshal(map[string]any{
		"type": "user", "parent_tool_use_id": nil,
		"message":         map[string]any{"role": "user", "content": []map[string]any{{"type": "tool_result", "tool_use_id": "t1", "content": big}}},
		"tool_use_result": map[string]any{"file": map[string]any{"content": big}},
	})
	p.event(claudestream.Parse(line))
	it, _ := log.get("t1")
	if it.Tool.Status != ToolDone || len(it.Tool.Output) > maxToolOutput+80 || !utf8.ValidString(it.Tool.Output) ||
		!strings.HasSuffix(it.Tool.Output, fmt.Sprintf("[output truncated: %d more bytes]", len(big)-maxToolOutput)) {
		t.Errorf("output len %d, tail %q", len(it.Tool.Output), it.Tool.Output[max(0, len(it.Tool.Output)-60):])
	}
	if it.Tool.ResultJSON != "" {
		t.Errorf("structured result over the cap was kept (%d bytes)", len(it.Tool.ResultJSON))
	}
}

// TestRenderedPermissionFollowsItsToolCall: the CLI writes a tool_use's assistant
// frame and then its can_use_tool request on the same stdout, so the permission item
// must come right after its tool call. (The request used to reach the runner on a
// goroutine of its own, racing the ordered events: run with -race -count=20.)
func TestRenderedPermissionFollowsItsToolCall(t *testing.T) {
	const rounds = 10
	var lines []string
	for i := range rounds {
		for range 20 { // events queued ahead of the pair widen any race
			lines = append(lines, `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}`)
		}
		lines = append(lines,
			fmt.Sprintf(`{"type":"assistant","message":{"id":"msg_%d","role":"assistant","content":[{"type":"tool_use","id":"toolu_%d","name":"Bash","input":{"command":"echo %d"}}]},"parent_tool_use_id":null}`, i, i, i),
			fmt.Sprintf(`{"type":"control_request","request_id":"r-%d","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"echo %d"},"tool_use_id":"toolu_%d"}}`, i, i, i),
			fmt.Sprintf(`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_%d","content":"%d"}]},"parent_tool_use_id":null}`, i, i))
	}
	lines = append(lines, `{"type":"result","subtype":"success","is_error":false,"num_turns":1,"total_cost_usd":0.001,"usage":{"input_tokens":1,"output_tokens":1}}`)
	path := filepath.Join(t.TempDir(), "pairs.jsonl")
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	re := newRenderedEnvAt(t, path)
	s := re.create(CreateOptions{InitialPrompt: "run them"})
	for i := range rounds {
		reqID := fmt.Sprintf("r-%d", i)
		toolID := fmt.Sprintf("toolu_%d", i)
		at := func(items []Item, id string) int {
			return slices.IndexFunc(items, func(it Item) bool { return it.ID == id })
		}
		items := re.waitItems(s.ID, "request "+reqID, func(items []Item) bool {
			return at(items, "perm-"+reqID) >= 0 && at(items, toolID) >= 0
		})
		if at(items, "perm-"+reqID) != at(items, toolID)+1 {
			t.Fatalf("round %d: the request does not follow its tool call:\n%s", i, describeItems(items))
		}
		if _, err := re.m.Respond(re.ctx(), s.ID, reqID, Decision{Allow: true}); err != nil {
			t.Fatal(err)
		}
	}
	items := re.waitItems(s.ID, "turn end", hasTurnEnd)
	want := []string{"user_message"}
	for range rounds {
		want = append(want, "tool_call", "permission_request")
	}
	want = append(want, "turn_end")
	if !slices.Equal(kinds(items), want) {
		t.Errorf("kinds %v, want %v\n%s", kinds(items), want, describeItems(items))
	}
}

// TestRenderedConnectsBusyWithItsFirstPrompt: the update that says connected already
// says busy and the first message is an item by then, so the GUI never sees a connected
// thread with nothing to show between "Starting Claude…" and "Working".
func TestRenderedConnectsBusyWithItsFirstPrompt(t *testing.T) {
	re := newRenderedEnv(t, "text-table")
	s := re.create(CreateOptions{InitialPrompt: "a table please"})
	deadline := time.After(5 * time.Second)
	for {
		select {
		case ev := <-re.events.C():
			u, ok := ev.(Updated)
			if !ok || u.Session.ID != s.ID || u.Session.State != StateConnected {
				continue
			}
			if u.Session.Status != StatusBusy {
				t.Fatalf("first connected update: status %v %q", u.Session.Status, u.Session.StatusReason)
			}
			items, err := re.m.Items(re.ctx(), s.ID)
			if err != nil || len(items.Items) == 0 || items.Items[0].Kind != KindUserMessage {
				t.Fatalf("items when connected: %+v %v", items, err)
			}
			return
		case <-deadline:
			t.Fatal("never connected")
		}
	}
}
