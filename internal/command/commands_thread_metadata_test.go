package command_test

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
)

func TestThreadMetadataCommands(t *testing.T) {
	auto := v1.PermissionMode_PERMISSION_MODE_AUTO
	done := v1.ThreadReportStatus_THREAD_REPORT_STATUS_DONE
	inThread := command.Context{ActiveThreadID: "s-me"}
	tests := []struct {
		name     string
		cmd      string
		ctx      command.Context
		args     map[string]string
		current  *v1.Thread
		others   []*v1.Thread // listed after current
		wantErr  error
		wantCode connect.Code
		wantMsg  string
		wantReqs []proto.Message
	}{
		{name: "new with metadata", cmd: "thread.new",
			args:    map[string]string{"project": "r1", "created-by": "s-parent", "brief": "say hi", "labels": "test, b", "budget": "5.00"},
			wantMsg: "created thread s1 in ",
			wantReqs: []proto.Message{&v1.CreateThreadRequest{ProjectId: "r1", PermissionMode: auto, CreatedBy: "s-parent", Brief: "say hi",
				Labels: []string{"test", "b"}, BudgetUsd: 5}}},
		// The active thread is the one the user views in the GUI: never the creator.
		{name: "new never takes the creator from the context", cmd: "thread.new", ctx: command.Context{ActiveThreadID: "s-viewed", ActiveProjectID: "r1"},
			wantReqs: []proto.Message{&v1.CreateThreadRequest{ProjectId: "r1", PermissionMode: auto}}},
		{name: "new with a $ budget", cmd: "thread.new", args: map[string]string{"project": "r1", "budget": "$0.25"},
			wantReqs: []proto.Message{&v1.CreateThreadRequest{ProjectId: "r1", PermissionMode: auto, BudgetUsd: 0.25}}},
		{name: "new with a bad budget", cmd: "thread.new", args: map[string]string{"project": "r1", "budget": "five"}, wantErr: command.ErrInvalidArgs},
		{name: "new with a negative budget", cmd: "thread.new", args: map[string]string{"project": "r1", "budget": "-1"}, wantErr: command.ErrInvalidArgs},

		{name: "label edits the context thread", cmd: "thread.label", ctx: inThread,
			args:     map[string]string{"add": "x,y", "remove": "test"},
			current:  &v1.Thread{Name: "child", Labels: []string{"test"}},
			wantMsg:  "labels of thread child (s-me): x, y",
			wantReqs: []proto.Message{&v1.LabelThreadRequest{Id: "s-me", Add: []string{"x", "y"}, Remove: []string{"test"}}}},
		{name: "label clear", cmd: "thread.label", args: map[string]string{"id": "s-2", "clear": "true"},
			current:  &v1.Thread{Labels: []string{"a"}},
			wantMsg:  "labels of thread s-2: none",
			wantReqs: []proto.Message{&v1.LabelThreadRequest{Id: "s-2", Clear: true}}},

		{name: "report on the context thread", cmd: "thread.report", ctx: inThread,
			args:     map[string]string{"status": "done", "summary": "all good", "data": `{"n":1}`},
			wantMsg:  "reported done on thread s-me: all good",
			wantReqs: []proto.Message{&v1.ReportThreadRequest{Id: "s-me", Status: done, Summary: "all good", Data: `{"n":1}`}}},
		{name: "report on another thread", cmd: "thread.report", ctx: inThread, args: map[string]string{"id": "s-9", "status": "blocked"},
			wantMsg:  "reported blocked on thread s-9",
			wantReqs: []proto.Message{&v1.ReportThreadRequest{Id: "s-9", Status: v1.ThreadReportStatus_THREAD_REPORT_STATUS_BLOCKED}}},
		{name: "report needs a status", cmd: "thread.report", ctx: inThread, args: map[string]string{"summary": "x"}, wantErr: command.ErrInvalidArgs},
		{name: "report refuses an unknown status", cmd: "thread.report", ctx: inThread, args: map[string]string{"status": "meh"}, wantErr: command.ErrInvalidArgs},

		{name: "budget", cmd: "thread.budget", ctx: inThread, args: map[string]string{"usd": "0.0001"},
			current:  &v1.Thread{CostUsd: 0.25},
			wantMsg:  "budget of thread s-me: $0.0001 (spent $0.25)",
			wantReqs: []proto.Message{&v1.SetThreadBudgetRequest{Id: "s-me", BudgetUsd: 0.0001}}},
		{name: "budget 0 removes it", cmd: "thread.budget", ctx: inThread, args: map[string]string{"usd": "0"},
			wantMsg:  "removed the budget of thread s-me (spent $0.00)",
			wantReqs: []proto.Message{&v1.SetThreadBudgetRequest{Id: "s-me"}}},
		{name: "budget refuses words", cmd: "thread.budget", ctx: inThread, args: map[string]string{"usd": "lots"}, wantErr: command.ErrInvalidArgs},

		{name: "get prints the metadata", cmd: "thread.get", args: map[string]string{"id": "s-2"},
			current: &v1.Thread{Name: "child", State: v1.ThreadState_THREAD_STATE_CONNECTED, Status: v1.ThreadStatus_THREAD_STATUS_NEEDS_ATTENTION,
				StatusReason: "budget reached", WorktreePath: "/wt", CreatedBy: "s-1", CreatedByName: "Parent", Brief: "say hi",
				Labels: []string{"a", "b"}, ReportStatus: done, ReportSummary: "all good", ReportData: `{"n":1}`,
				CostUsd: 1.5, BudgetUsd: 5},
			others: []*v1.Thread{{Id: "s-1", Name: "Parent"}},
			wantMsg: "thread child (s-2)\nstatus: needs attention (budget reached)\nworktree: /wt\ncreated by: Parent (s-1)\nbrief: say hi\n" +
				"labels: a, b\nreport: done: all good\nreport data: {\"n\":1}\ncost: $1.50 of a $5.00 budget",
			wantReqs: []proto.Message{&v1.GetThreadRequest{Id: "s-2"}, &v1.ListThreadsRequest{Filter: &v1.ThreadFilter{All: true}}}},
		// The creator is resolved by its id: its current name, the recorded one only
		// once it is removed.
		{name: "get shows a renamed creator's current name", cmd: "thread.get", args: map[string]string{"id": "s-2"},
			current: &v1.Thread{Name: "child", Status: v1.ThreadStatus_THREAD_STATUS_IDLE, WorktreePath: "/wt", CreatedBy: "s-1", CreatedByName: "Parent"},
			others:  []*v1.Thread{{Id: "s-1", Name: "Parent, renamed"}},
			wantMsg: "thread child (s-2)\nstatus: idle\nworktree: /wt\ncreated by: Parent, renamed (s-1)\ncost: $0.00"},
		{name: "get names an unnamed creator by its id", cmd: "thread.get", args: map[string]string{"id": "s-2"},
			current: &v1.Thread{Name: "child", Status: v1.ThreadStatus_THREAD_STATUS_IDLE, WorktreePath: "/wt", CreatedBy: "s-1", CreatedByName: "Parent"},
			others:  []*v1.Thread{{Id: "s-1"}},
			wantMsg: "thread child (s-2)\nstatus: idle\nworktree: /wt\ncreated by: s-1 (s-1)\ncost: $0.00"},
		{name: "get keeps a removed creator's recorded name", cmd: "thread.get", args: map[string]string{"id": "s-2"},
			current: &v1.Thread{Name: "child", Status: v1.ThreadStatus_THREAD_STATUS_IDLE, WorktreePath: "/wt", CreatedBy: "s-1", CreatedByName: "Parent"},
			wantMsg: "thread child (s-2)\nstatus: idle\nworktree: /wt\ncreated by: Parent (s-1, removed)\ncost: $0.00"},
		{name: "get of a plain thread", cmd: "thread.get", ctx: inThread,
			current: &v1.Thread{State: v1.ThreadState_THREAD_STATE_DISCONNECTED, Status: v1.ThreadStatus_THREAD_STATUS_IDLE, StatusReason: "at prompt", WorktreePath: "/wt"},
			wantMsg: "thread s-me\nstatus: idle (at prompt), disconnected\nworktree: /wt\ncost: $0.00"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, b, _ := newLifecycleRegistry(t)
			b.Current, b.Others = tt.current, tt.others
			res, err := reg.Invoke(context.Background(), tt.ctx, tt.cmd, tt.args, command.Confirmed(true))
			switch {
			case tt.wantCode != 0:
				if connect.CodeOf(err) != tt.wantCode {
					t.Fatalf("err = %v, want code %v", err, tt.wantCode)
				}
			case !errors.Is(err, tt.wantErr):
				t.Fatalf("err = %v, want %v", err, tt.wantErr)
			}
			if tt.wantErr != nil {
				if got := b.Requests(); len(got) != 0 {
					t.Errorf("requests = %v, want none", got)
				}
				return
			}
			if tt.wantMsg != "" && res.Message != tt.wantMsg {
				t.Errorf("message = %q, want %q", res.Message, tt.wantMsg)
			}
			if tt.wantReqs != nil {
				if got := b.Requests(); !slices.EqualFunc(got, tt.wantReqs, proto.Equal) {
					t.Errorf("requests = %v, want %v", got, tt.wantReqs)
				}
			}
		})
	}
}

func TestThreadGetShowsReportTime(t *testing.T) {
	reg, b, _ := newLifecycleRegistry(t)
	at := time.Date(2026, 10, 17, 9, 30, 0, 0, time.Local)
	b.Current = &v1.Thread{ReportStatus: v1.ThreadReportStatus_THREAD_REPORT_STATUS_PROGRESS, ReportAt: timestamppb.New(at)}
	res, err := reg.Invoke(context.Background(), command.Context{}, "thread.get", map[string]string{"id": "s-1"})
	if err != nil {
		t.Fatal(err)
	}
	if want := "report: progress (2026-10-17 09:30:00)"; !slices.Contains(strings.Split(res.Message, "\n"), want) {
		t.Errorf("message = %q, want a line %q", res.Message, want)
	}
}
