package api

import (
	"context"
	"testing"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// Get with with_detail reads the pending request from the items as a wake does (W2
// finding 4: after respond said "1 more pending", get --json had no pending).
func TestThreadGetDetailPending(t *testing.T) {
	question := `{"questions":[{"question":"Which color?","options":[{"label":"Red"},{"label":"Blue"}]}]}`
	tests := []struct {
		name   string
		status thread.Status
		reason string
		items  []thread.Item
		detail bool
		want   string // protojson of Thread.pending; "" for none
	}{
		{name: "a permission", status: thread.StatusNeedsAttention, reason: "permission: Bash ls", detail: true,
			items: []thread.Item{{ID: "p1", Kind: thread.KindPermission, Request: &thread.Request{RequestID: "r1", ToolName: "Bash", Description: "ls",
				InputJSON: `{"command":"ls"}`, State: thread.RequestPending}}},
			want: `{"kind":"permission","requestId":"r1","tool":"Bash","input":{"command":"ls"}}`},
		{name: "a question", status: thread.StatusNeedsAttention, reason: "question: Which color?", detail: true,
			items: []thread.Item{{ID: "q1", Kind: thread.KindQuestion, Request: &thread.Request{RequestID: "r2", ToolName: "AskUserQuestion",
				InputJSON: question, State: thread.RequestPending}}},
			want: `{"kind":"question","requestId":"r2","tool":"AskUserQuestion","input":` + question +
				`,"question":"Which color?","options":["Red","Blue"]}`},
		{name: "without with_detail", status: thread.StatusNeedsAttention, reason: "permission: Bash ls",
			items: []thread.Item{{ID: "p1", Kind: thread.KindPermission, Request: &thread.Request{RequestID: "r1", ToolName: "Bash", State: thread.RequestPending}}}},
		{name: "finished", status: thread.StatusNeedsAttention, reason: "finished", detail: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fake, c := newThreadServer(t)
			fake.Put(thread.Thread{ID: "s-1", State: thread.StateConnected, Status: tt.status, StatusReason: tt.reason})
			fake.PutItems("s-1", tt.items...)
			res, err := c.Get(context.Background(), connect.NewRequest(&v1.GetThreadRequest{Id: "s-1", WithDetail: tt.detail}))
			if err != nil {
				t.Fatal(err)
			}
			p := res.Msg.GetThread().GetPending()
			if tt.want == "" {
				if p != nil {
					t.Errorf("pending = %v, want none", p)
				}
				return
			}
			want := &v1.ThreadPendingDetail{}
			if err := protojson.Unmarshal([]byte(tt.want), want); err != nil {
				t.Fatal(err)
			}
			if !proto.Equal(p, want) {
				t.Errorf("pending = %v, want %v", p, want)
			}
		})
	}
}
