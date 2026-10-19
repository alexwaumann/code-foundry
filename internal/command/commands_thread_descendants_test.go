package command_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
)

// subtree is an orchestrator, two leads and their workers as the daemon answers a List
// with descendants_of s-0rch00000000: tree order, depths set. The fake answers it
// whatever the filter.
func subtree() []*v1.Thread {
	ago := func(d time.Duration) *timestamppb.Timestamp { return timestamppb.New(time.Now().Add(-d)) }
	row := func(id, name, by string, depth int32, cost float64, status v1.ThreadStatus) *v1.Thread {
		return &v1.Thread{Id: id, Name: name, CreatedBy: by, Depth: proto.Int32(depth), CostUsd: cost, Status: status,
			State: v1.ThreadState_THREAD_STATE_CONNECTED, WorktreePath: "/Users/me", LastActivityAt: ago(2 * time.Minute)}
	}
	idle, busy := v1.ThreadStatus_THREAD_STATUS_IDLE, v1.ThreadStatus_THREAD_STATUS_BUSY
	leadA := row("s-1eada0000000", "Lead A", "s-0rch00000000", 1, 0.0125, idle)
	leadA.ReportStatus, leadA.ReportSummary = v1.ThreadReportStatus_THREAD_REPORT_STATUS_PROGRESS, "2 workers started"
	w1 := row("s-a10000000000", "Worker 1", "s-1eada0000000", 2, 0.004, busy)
	w2 := row("s-a20000000000", "Worker 2", "s-1eada0000000", 2, 0.0035, idle)
	w2.ReportStatus, w2.ReportSummary = v1.ThreadReportStatus_THREAD_REPORT_STATUS_DONE, "Added --json"
	return []*v1.Thread{
		row("s-0rch00000000", "Orchestrator", "", 0, 0.05, idle),
		leadA, w1, w2,
		row("s-1eadb0000000", "Lead B", "s-0rch00000000", 1, 1.5, idle),
	}
}

func TestThreadListDescendants(t *testing.T) {
	tests := []struct {
		name       string
		args       map[string]string
		caller     string
		wantFilter *v1.ThreadFilter
		want       string
	}{
		{name: "the tree, each row's cost, the total",
			args:       map[string]string{"descendants-of": "s-0rch00000000"},
			wantFilter: &v1.ThreadFilter{DescendantsOf: "s-0rch00000000", Limit: 50},
			want: "s-0rch00000000  idle  Orchestrator  no project  2m  $0.05\n" +
				"s-1eada0000000  idle  ↳ Lead A      no project  2m  $0.01\n" +
				"s-a10000000000  busy    ↳ Worker 1  no project  2m  $0.0040\n" +
				"s-a20000000000  idle    ↳ Worker 2  no project  2m  $0.0035\n" +
				"s-1eadb0000000  idle  ↳ Lead B      no project  2m  $1.50\n" +
				"total: 5 threads, $1.57"},
		// It composes: the other filters go to the daemon with it; the caller's row says so.
		{name: "with other filters and the caller", caller: "s-0rch00000000",
			args:       map[string]string{"descendants-of": "s-0rch00000000", "all": "true", "label": "x", "limit": "0"},
			wantFilter: &v1.ThreadFilter{DescendantsOf: "s-0rch00000000", All: true, IncludeRemoved: true, Labels: []string{"x"}},
			want: "s-0rch00000000  idle  Orchestrator (you)  no project  2m  $0.05\n" +
				"s-1eada0000000  idle  ↳ Lead A            no project  2m  $0.01\n" +
				"s-a10000000000  busy    ↳ Worker 1        no project  2m  $0.0040\n" +
				"s-a20000000000  idle    ↳ Worker 2        no project  2m  $0.0035\n" +
				"s-1eadb0000000  idle  ↳ Lead B            no project  2m  $1.50\n" +
				"total: 5 threads, $1.57"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg := command.NewRegistry()
			b := &commandtest.Thread{Others: subtree()}
			if err := command.RegisterThreadList(reg, command.ThreadListDeps{Thread: b, Project: &commandtest.Project{}}); err != nil {
				t.Fatal(err)
			}
			res, err := reg.Invoke(context.Background(), command.Context{ActiveThreadID: tt.caller}, "thread.list", tt.args)
			if err != nil {
				t.Fatal(err)
			}
			if got := firstList(b); !proto.Equal(got, tt.wantFilter) {
				t.Errorf("filter = %v, want %v", got, tt.wantFilter)
			}
			if res.Message != tt.want {
				t.Errorf("output =\n%s\nwant\n%s", res.Message, tt.want)
			}
		})
	}
}

// firstList is the filter of b's first List request.
func firstList(b *commandtest.Thread) *v1.ThreadFilter {
	for _, r := range b.Requests() {
		if l, ok := r.(*v1.ListThreadsRequest); ok {
			return l.GetFilter()
		}
	}
	return nil
}

func TestThreadReportsDescendants(t *testing.T) {
	reg := command.NewRegistry()
	b := &commandtest.Thread{Others: subtree()}
	if err := command.RegisterThreadReports(reg, b); err != nil {
		t.Fatal(err)
	}
	res, err := reg.Invoke(context.Background(), command.Context{}, "thread.reports", map[string]string{"descendants-of": "s-0rch00000000"})
	if err != nil {
		t.Fatal(err)
	}
	if got, want := firstList(b), (&v1.ThreadFilter{DescendantsOf: "s-0rch00000000"}); !proto.Equal(got, want) {
		t.Errorf("filter = %v, want %v", got, want)
	}
	want := "s-0rch00000000  -         Orchestrator  $0.05\n" +
		"s-1eada0000000  progress  ↳ Lead A      $0.01    2 workers started\n" +
		"s-a10000000000  -           ↳ Worker 1  $0.0040\n" +
		"s-a20000000000  done        ↳ Worker 2  $0.0035  Added --json\n" +
		"s-1eadb0000000  -         ↳ Lead B      $1.50\n" +
		"total: 5 threads, $1.57"
	if res.Message != want {
		t.Errorf("output =\n%s\nwant\n%s", res.Message, want)
	}
	reports := res.JSON.([]command.ThreadReport)
	var depths []int32
	for _, r := range reports {
		if r.Depth == nil {
			t.Fatalf("%s has no depth", r.ID)
		}
		depths = append(depths, *r.Depth)
	}
	if got := depths; len(got) != 5 || got[0] != 0 || got[1] != 1 || got[2] != 2 || got[3] != 2 || got[4] != 1 {
		t.Errorf("depths = %v", got)
	}
	js, err := res.EncodeJSON()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(js, `"id":"s-0rch00000000","name":"Orchestrator","status":"idle","reportStatus":"none","createdBy":"","labels":[],"costUsd":0.05,"depth":0}`) {
		t.Errorf("the root's JSON lacks depth 0:\n%s", js)
	}
}

func TestThreadArchiveDescendants(t *testing.T) {
	archived := func(s *v1.Thread) *v1.Thread {
		s = proto.CloneOf(s)
		s.ArchivedAt = timestamppb.New(time.UnixMilli(7))
		return s
	}
	all := subtree()
	tree := func(edit func([]*v1.Thread)) []*v1.Thread {
		out := make([]*v1.Thread, len(all))
		for i, s := range all {
			out[i] = proto.CloneOf(s)
		}
		if edit != nil {
			edit(out)
		}
		return out
	}
	quiet := tree(func(ts []*v1.Thread) { ts[2].Status = v1.ThreadStatus_THREAD_STATUS_IDLE })
	ids := func(list ...string) []proto.Message {
		var out []proto.Message
		for _, id := range list {
			out = append(out, &v1.ArchiveThreadRequest{Id: id, Archived: true})
		}
		return out
	}
	tests := []struct {
		name      string
		threads   []*v1.Thread
		args      map[string]string
		confirmed bool
		wantAsk   string
		wantMsg   string
		wantErr   bool
		wantReqs  []proto.Message
	}{
		{name: "always asks, with the count and the ids", threads: quiet, args: map[string]string{"descendants-of": "s-0rch00000000"},
			wantAsk: "Archive 4 threads under Orchestrator? They are closed and listed apart: " +
				"s-1eada0000000, s-a10000000000, s-a20000000000, s-1eadb0000000."},
		{name: "a busy worker is named", threads: tree(nil), args: map[string]string{"descendants-of": "s-0rch00000000"},
			wantAsk: "Archive 4 threads under Orchestrator? They are closed and listed apart: " +
				"s-1eada0000000, s-a10000000000, s-a20000000000, s-1eadb0000000. " +
				"1 of them is busy: Worker 1 (Claude is still working); archiving ends its turn or stops its background work."},
		{name: "include-root counts the root", threads: quiet, args: map[string]string{"descendants-of": "s-0rch00000000", "include-root": "true"},
			wantAsk: "Archive 5 threads under Orchestrator (Orchestrator too)? They are closed and listed apart: " +
				"s-0rch00000000, s-1eada0000000, s-a10000000000, s-a20000000000, s-1eadb0000000."},
		{name: "confirmed, archives the threads below, not the root", threads: tree(nil), confirmed: true,
			args:     map[string]string{"descendants-of": "s-0rch00000000"},
			wantMsg:  "archived 4 threads: s-1eada0000000, s-a10000000000, s-a20000000000, s-1eadb0000000",
			wantReqs: ids("s-1eada0000000", "s-a10000000000", "s-a20000000000", "s-1eadb0000000")},
		{name: "confirmed with include-root", threads: quiet, confirmed: true,
			args:     map[string]string{"descendants-of": "s-0rch00000000", "include-root": "true"},
			wantMsg:  "archived 5 threads: s-0rch00000000, s-1eada0000000, s-a10000000000, s-a20000000000, s-1eadb0000000",
			wantReqs: ids("s-0rch00000000", "s-1eada0000000", "s-a10000000000", "s-a20000000000", "s-1eadb0000000")},
		// Archived threads of the subtree are left as they are; a lead's own team.
		{name: "already archived ones are skipped", confirmed: true,
			threads:  tree(func(ts []*v1.Thread) { ts[3] = archived(ts[3]) })[1:4],
			args:     map[string]string{"descendants-of": "s-1eada0000000"},
			wantMsg:  "archived 1 thread: s-a10000000000",
			wantReqs: ids("s-a10000000000")},
		{name: "nothing under the root: no question, nothing done", threads: quiet[4:],
			args: map[string]string{"descendants-of": "s-1eadb0000000"}, wantMsg: "no threads under Lead B to archive"},
		{name: "archived=false unarchives the archived ones without asking",
			threads:  tree(func(ts []*v1.Thread) { ts[2], ts[3] = archived(ts[2]), archived(ts[3]) }),
			args:     map[string]string{"descendants-of": "s-0rch00000000", "archived": "false"},
			wantMsg:  "unarchived 2 threads: s-a10000000000, s-a20000000000",
			wantReqs: []proto.Message{&v1.ArchiveThreadRequest{Id: "s-a10000000000"}, &v1.ArchiveThreadRequest{Id: "s-a20000000000"}}},
		{name: "not with ids", threads: quiet, confirmed: true,
			args: map[string]string{"descendants-of": "s-0rch00000000", "ids": "s-a10000000000"}, wantErr: true},
		{name: "include-root alone", threads: quiet, confirmed: true,
			args: map[string]string{"id": "s-a10000000000", "include-root": "true"}, wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, fake := newBulkRegistry(t, tt.threads...)
			res, err := reg.Invoke(context.Background(), command.Context{}, "thread.archive", tt.args, command.Confirmed(tt.confirmed))
			var archives []proto.Message
			for _, r := range fake.Requests() {
				if r, ok := r.(*v1.ArchiveThreadRequest); ok {
					archives = append(archives, r)
				}
			}
			switch {
			case tt.wantAsk != "":
				var ce *command.ConfirmError
				if !errors.As(err, &ce) || ce.Message != tt.wantAsk {
					t.Fatalf("err = %v, want the confirmation\n%s", err, tt.wantAsk)
				}
				if len(archives) > 0 {
					t.Fatal("archived before confirming")
				}
				return
			case tt.wantErr:
				if !errors.Is(err, command.ErrInvalidArgs) || len(archives) > 0 {
					t.Fatalf("err = %v (archived %v), want an argument error", err, archives)
				}
				return
			case err != nil:
				t.Fatal(err)
			}
			if res.Message != tt.wantMsg {
				t.Errorf("result = %q, want %q", res.Message, tt.wantMsg)
			}
			if len(archives) != len(tt.wantReqs) {
				t.Fatalf("archive requests = %v, want %v", archives, tt.wantReqs)
			}
			for i := range archives {
				if !proto.Equal(archives[i], tt.wantReqs[i]) {
					t.Errorf("request %d = %v, want %v", i, archives[i], tt.wantReqs[i])
				}
			}
			for _, r := range fake.Requests() {
				if l, ok := r.(*v1.ListThreadsRequest); ok && l.GetFilter().GetDescendantsOf() != "" &&
					!proto.Equal(l.GetFilter(), &v1.ThreadFilter{IncludeArchived: true, DescendantsOf: tt.args["descendants-of"]}) {
					t.Errorf("filter = %v", l.GetFilter())
				}
			}
		})
	}
}
