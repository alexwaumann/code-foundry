package command_test

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
)

// thread.snooze given ids (the sidebar's bulk Snooze ▸ and its Snoozed header as a drop
// target): every thread gets the same request, past one that fails, and nothing asks, busy
// threads among them or not: a snooze cuts nothing off (docs/notes/snooze-without-teardown.md).
func TestThreadSnoozeIDs(t *testing.T) {
	a, b := idle("s-aaaa11112222", "one"), idle("s-bbbb33334444", "two")
	busy := &v1.Thread{Id: "s-cccc55556666", Name: "three", State: v1.ThreadState_THREAD_STATE_CONNECTED, Status: v1.ThreadStatus_THREAD_STATUS_BUSY}
	asking := &v1.Thread{Id: "s-dddd77778888", Name: "four", State: v1.ThreadState_THREAD_STATE_CONNECTED,
		Status: v1.ThreadStatus_THREAD_STATUS_NEEDS_ATTENTION, StatusReason: "question: Which?"}
	far := time.Date(2099, time.January, 2, 15, 4, 0, 0, time.UTC)
	farText := far.In(time.Local).Format("Mon Jan 2 2006 3:04 PM")
	tests := []struct {
		name      string
		ctx       command.Context
		args      map[string]string
		confirmed bool
		wantAsk   string
		wantMsg   string
		wantErr   error
		wantIDs   []string // the Snooze requests, in order
		wantSave  bool
		wantUntil bool
	}{
		{name: "idle threads save for later without asking", args: map[string]string{"ids": "11112222,33334444", "save": "true"},
			wantMsg: "saved 2 threads for later: s-aaaa11112222, s-bbbb33334444", wantIDs: []string{"s-aaaa11112222", "s-bbbb33334444"}, wantSave: true},
		{name: "idle threads snooze until a time", args: map[string]string{"ids": "s-aaaa11112222,s-bbbb33334444", "until": "2099-01-02T15:04:00Z"},
			wantMsg: "snoozed 2 threads until " + farText + ": s-aaaa11112222, s-bbbb33334444", wantIDs: []string{"s-aaaa11112222", "s-bbbb33334444"}, wantUntil: true},
		{name: "clear unsnoozes each without asking", args: map[string]string{"ids": "11112222,55556666", "clear": "true"},
			wantMsg: "unsnoozed 2 threads: s-aaaa11112222, s-cccc55556666", wantIDs: []string{"s-aaaa11112222", "s-cccc55556666"}},
		{name: "a busy thread among them does not ask", args: map[string]string{"ids": "11112222,55556666,33334444", "until": "2099-01-02T15:04:00Z"},
			wantMsg:   "snoozed 3 threads until " + farText + ": s-aaaa11112222, s-cccc55556666, s-bbbb33334444",
			wantIDs:   []string{"s-aaaa11112222", "s-cccc55556666", "s-bbbb33334444"},
			wantUntil: true},
		{name: "busy and asking threads save without asking", args: map[string]string{"ids": "55556666,77778888", "save": "true"},
			wantMsg: "saved 2 threads for later: s-cccc55556666, s-dddd77778888", wantIDs: []string{"s-cccc55556666", "s-dddd77778888"}, wantSave: true},
		// In a thread id defaults to the caller's own thread; ids replaces it.
		{name: "ids ignore the context thread", ctx: command.Context{ActiveThreadID: "s-cccc55556666", ActiveView: "thread"},
			args: map[string]string{"ids": "11112222", "save": "true"}, wantIDs: []string{"s-aaaa11112222"}, wantSave: true,
			wantMsg: "saved 1 thread for later: s-aaaa11112222"},
		{name: "ids with neither until, save nor clear", args: map[string]string{"ids": "11112222"}, wantErr: command.ErrInvalidArgs},
		{name: "neither id nor ids", args: map[string]string{"save": "true"}, wantErr: command.ErrInvalidArgs},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, fake := newBulkRegistry(t, a, b, busy, asking)
			res, err := reg.Invoke(context.Background(), tt.ctx, "thread.snooze", tt.args, command.Confirmed(tt.confirmed))
			var ce *command.ConfirmError
			switch {
			case tt.wantErr != nil:
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("err = %v, want %v", err, tt.wantErr)
				}
			case tt.wantAsk != "":
				if !errors.As(err, &ce) || ce.Message != tt.wantAsk {
					t.Fatalf("err = %v, want the confirmation %q", err, tt.wantAsk)
				}
			case err != nil:
				t.Fatal(err)
			}
			var ids []string
			for _, r := range fake.Requests() {
				r, ok := r.(*v1.SnoozeThreadRequest)
				if !ok {
					continue
				}
				ids = append(ids, r.GetId())
				if r.GetSave() != tt.wantSave || (r.GetUntil() != nil) != tt.wantUntil {
					t.Errorf("request %v: save %v until %v", r, tt.wantSave, tt.wantUntil)
				}
			}
			if fmt.Sprint(ids) != fmt.Sprint(tt.wantIDs) {
				t.Errorf("snoozed %v, want %v", ids, tt.wantIDs)
			}
			if err == nil && res.Message != tt.wantMsg {
				t.Errorf("message =\n%s\nwant\n%s", res.Message, tt.wantMsg)
			}
		})
	}
}
