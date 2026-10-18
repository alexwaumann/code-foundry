package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/internal/store/thread/threadtest"
)

func newThreadServer(t *testing.T) (*threadtest.Fake, codefoundryv1connect.ThreadServiceClient) {
	t.Helper()
	b := bus.New()
	fake := threadtest.New(b)
	route := NewThread(fake, b).Route()
	mux := http.NewServeMux()
	mux.Handle(route.Path, route.Handler)
	srv := httptest.NewUnstartedServer(mux)
	srv.EnableHTTP2 = true
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return fake, codefoundryv1connect.NewThreadServiceClient(srv.Client(), srv.URL)
}

func TestThreadWatchSendRespond(t *testing.T) {
	fake, c := newThreadServer(t)
	fake.Put(thread.Thread{ID: "s1", State: thread.StateConnected})
	fake.Put(thread.Thread{ID: "d1", State: thread.StateDisconnected})
	fake.PutItems("s1",
		thread.Item{ID: "u1", Kind: thread.KindUserMessage, Text: "hi @cf-file://r1/a.go", Attachments: []string{"/att/1.png"},
			ComposerText: "hi [a.go](cf-file://r1/a.go)"},
		thread.Item{ID: "m/0", Kind: thread.KindAssistantText, Text: "| a |", Streaming: true},
		thread.Item{ID: "perm-r1", Kind: thread.KindPermission, Request: &thread.Request{RequestID: "r1", ToolName: "Write", Description: "a.go", State: thread.RequestPending}},
	)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if _, err := c.ListItems(ctx, connect.NewRequest(&v1.ListThreadItemsRequest{ThreadId: "nope"})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("items of an unknown thread: %v", err)
	}

	stream, err := c.WatchThread(ctx, connect.NewRequest(&v1.WatchThreadRequest{ThreadId: "s1"}))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = stream.Close() }()
	next := func() *v1.ThreadEvent {
		t.Helper()
		if !stream.Receive() {
			t.Fatalf("stream ended: %v", stream.Err())
		}
		return stream.Msg()
	}
	snap := next().GetSnapshot()
	if snap == nil || len(snap.GetItems()) != 3 || snap.GetSeq() != 3 || len(snap.GetPending()) != 1 {
		t.Fatalf("snapshot %v", snap)
	}
	u := snap.GetItems()[0]
	if u.GetUserMessage().GetText() != "hi @cf-file://r1/a.go" || u.GetUserMessage().GetAttachments()[0] != "/att/1.png" || u.GetOrdinal() != 1 ||
		u.GetUserMessage().GetComposerText() != "hi [a.go](cf-file://r1/a.go)" {
		t.Errorf("user item %v", u)
	}
	if !snap.GetItems()[1].GetStreaming() || snap.GetItems()[1].GetAssistantText().GetText() != "| a |" {
		t.Errorf("text item %v", snap.GetItems()[1])
	}
	if p := snap.GetItems()[2].GetPermission(); p.GetState() != v1.ThreadRequestState_THREAD_REQUEST_STATE_PENDING || p.GetRequestId() != "r1" {
		t.Errorf("permission item %v", p)
	}
	if fake.Watchers("s1") != 1 {
		t.Errorf("watchers = %d", fake.Watchers("s1"))
	}

	res, err := c.Send(ctx, connect.NewRequest(&v1.SendThreadMessageRequest{ThreadId: "s1", Text: "more", Attachments: []string{"/att/2.png"},
		ComposerText: "![a.png](cf-attachment://0) more"}))
	if err != nil {
		t.Fatal(err)
	}
	if um := res.Msg.GetItem().GetUserMessage(); um.GetText() != "more" || um.GetComposerText() != "![a.png](cf-attachment://0) more" {
		t.Errorf("sent item %v", res.Msg.GetItem())
	}
	if ev := next().GetAppended(); ev.GetItem().GetId() != res.Msg.GetItem().GetId() || ev.GetSeq() != 4 {
		t.Errorf("appended %v", ev)
	}

	if _, err := c.Respond(ctx, connect.NewRequest(&v1.RespondThreadRequest{ThreadId: "s1", RequestId: "r1"})); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("respond without a decision: %v", err)
	}
	rr, err := c.Respond(ctx, connect.NewRequest(&v1.RespondThreadRequest{ThreadId: "s1", RequestId: "r1", Decision: v1.ThreadDecision_THREAD_DECISION_ALLOW_FOR_SESSION}))
	if err != nil {
		t.Fatal(err)
	}
	if p := rr.Msg.GetItem().GetPermission(); p.GetState() != v1.ThreadRequestState_THREAD_REQUEST_STATE_ALLOWED || p.GetDecision() != "allow_session" {
		t.Errorf("resolved %v", p)
	}
	if ev := next().GetUpdated(); ev.GetItem().GetId() != "perm-r1" {
		t.Errorf("updated %v", ev)
	}
	if ev := next().GetPending(); ev == nil || len(ev.GetPending()) != 0 {
		t.Errorf("pending %v", ev)
	}
	if _, err := c.Respond(ctx, connect.NewRequest(&v1.RespondThreadRequest{ThreadId: "s1", RequestId: "r1", Decision: v1.ThreadDecision_THREAD_DECISION_DENY})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("respond twice: %v", err)
	}
	if _, err := c.Interrupt(ctx, connect.NewRequest(&v1.InterruptThreadRequest{ThreadId: "s1"})); err != nil {
		t.Fatal(err)
	}
	ms, err := c.SetModel(ctx, connect.NewRequest(&v1.SetThreadModelRequest{ThreadId: "s1", Model: "sonnet"}))
	if err != nil || ms.Msg.GetThread().GetModel() != "sonnet" {
		t.Fatalf("set model %v %v", ms, err)
	}
	if _, err := c.SetPermissionMode(ctx, connect.NewRequest(&v1.SetThreadPermissionModeRequest{ThreadId: "s1"})); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("set default mode: %v", err)
	}
	if _, err := c.SetPermissionMode(ctx, connect.NewRequest(&v1.SetThreadPermissionModeRequest{ThreadId: "s1", PermissionMode: v1.PermissionMode_PERMISSION_MODE_ACCEPT_EDITS})); err != nil {
		t.Fatal(err)
	}
	es, err := c.SetEffort(ctx, connect.NewRequest(&v1.SetThreadEffortRequest{ThreadId: "s1", Effort: "max"}))
	if err != nil || es.Msg.GetThread().GetEffort() != "max" {
		t.Fatalf("set effort %v %v", es, err)
	}
	if _, err := c.SetEffort(ctx, connect.NewRequest(&v1.SetThreadEffortRequest{ThreadId: "s1", Effort: "huge"})); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("bad effort: %v", err)
	}
	// A message starts a stopped thread.
	if res, err := c.Send(ctx, connect.NewRequest(&v1.SendThreadMessageRequest{ThreadId: "d1", Text: "x"})); err != nil || res.Msg.GetItem().GetUserMessage().GetText() != "x" {
		t.Errorf("send to a stopped thread: %v, %v", res, err)
	}
	if s, _ := fake.Get(ctx, "d1"); s.State != thread.StateConnected {
		t.Errorf("after the send %+v", s)
	}

	// Closing the stream releases the viewer.
	cancel()
	deadline := time.Now().Add(2 * time.Second)
	for fake.Watchers("s1") != 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if fake.Watchers("s1") != 0 {
		t.Error("watcher not released")
	}
}

func TestItemToProto(t *testing.T) {
	now := time.Unix(1700000000, 0)
	tests := []struct {
		name  string
		item  thread.Item
		check func(*v1.ThreadItem) bool
	}{
		{"tool call", thread.Item{Kind: thread.KindToolCall, Tool: &thread.ToolCall{ToolUseID: "t", Name: "Bash", InputJSON: `{"command":"ls"}`, Status: thread.ToolError, Output: "no", IsError: true, ResultJSON: "{}"}},
			func(p *v1.ThreadItem) bool {
				tc := p.GetToolCall()
				return tc.GetStatus() == v1.ToolCallStatus_TOOL_CALL_STATUS_ERROR && tc.GetIsError() && tc.GetInputJson() == `{"command":"ls"}` && tc.GetResultJson() == "{}"
			}},
		{"question", thread.Item{Kind: thread.KindQuestion, Request: &thread.Request{RequestID: "q", State: thread.RequestAllowed, Answers: map[string]string{"Q": "A"}}},
			func(p *v1.ThreadItem) bool {
				return p.GetQuestion().GetAnswers()["Q"] == "A" && p.GetQuestion().GetState() == v1.ThreadRequestState_THREAD_REQUEST_STATE_ALLOWED
			}},
		{"auto denied", thread.Item{Kind: thread.KindPermission, Request: &thread.Request{State: thread.RequestDenied, Decision: thread.DecisionAutoDenied}},
			func(p *v1.ThreadItem) bool { return p.GetPermission().GetDecision() == "auto_denied" }},
		{"turn end", thread.Item{Kind: thread.KindTurnEnd, Turn: &thread.TurnEnd{Subtype: "success", CostUSD: 0.5, NumTurns: 2, Interrupted: true, Errors: []string{"e"}}},
			func(p *v1.ThreadItem) bool {
				te := p.GetTurnEnd()
				return te.GetCostUsd() == 0.5 && te.GetNumTurns() == 2 && te.GetInterrupted() && te.GetErrors()[0] == "e" &&
					te.TurnCostUsd == nil && te.GetModel() == ""
			}},
		{"turn end with its own cost and model", thread.Item{Kind: thread.KindTurnEnd, Turn: &thread.TurnEnd{CostUSD: 0.5, TurnCostUSD: new(0.2), Model: "claude-haiku-5-5"}},
			func(p *v1.ThreadItem) bool {
				te := p.GetTurnEnd()
				return te.TurnCostUsd != nil && te.GetTurnCostUsd() == 0.2 && te.GetModel() == "claude-haiku-5-5"
			}},
		{"compaction", thread.Item{Kind: thread.KindCompaction, Text: "summary", Compaction: &thread.Compaction{Trigger: "auto", PreTokens: 9}},
			func(p *v1.ThreadItem) bool {
				return p.GetCompaction().GetSummary() == "summary" && p.GetCompaction().GetTrigger() == "auto" && p.GetCompaction().GetPreTokens() == 9
			}},
		{"thinking", thread.Item{Kind: thread.KindThinking, Text: "hm"}, func(p *v1.ThreadItem) bool { return p.GetThinking().GetText() == "hm" }},
		{"error", thread.Item{Kind: thread.KindError, Text: "boom"}, func(p *v1.ThreadItem) bool { return p.GetError().GetText() == "boom" }},
		{"command output", thread.Item{Kind: thread.KindCommandOutput, Text: "Compacted"}, func(p *v1.ThreadItem) bool { return p.GetCommandOutput().GetText() == "Compacted" }},
		{"note", thread.Item{Kind: thread.KindNote, Text: "Forked from base"}, func(p *v1.ThreadItem) bool {
			return p.GetNote().GetText() == "Forked from base" && p.GetNote().GetCreatedBy() == ""
		}},
		{"created-by note", thread.Item{Kind: thread.KindNote, Text: "Created by Parent", NoteCreatedBy: "s-parent"}, func(p *v1.ThreadItem) bool {
			return p.GetNote().GetText() == "Created by Parent" && p.GetNote().GetCreatedBy() == "s-parent"
		}},
		{"subagent", thread.Item{Kind: thread.KindAssistantText, Text: "x", ParentToolUseID: "agent"}, func(p *v1.ThreadItem) bool { return p.GetParentToolUseId() == "agent" }},
		{"unknown kind", thread.Item{Kind: "future"}, func(p *v1.ThreadItem) bool { return p.GetPayload() == nil }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tt.item.ID, tt.item.Ordinal, tt.item.CreatedAt, tt.item.UpdatedAt = "i", 7, now, now
			p := itemToProto(tt.item)
			if p.GetId() != "i" || p.GetOrdinal() != 7 || !p.GetCreatedAt().AsTime().Equal(now) || !tt.check(p) {
				t.Errorf("got %v", p)
			}
		})
	}
}
