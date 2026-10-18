package command_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
)

func TestThreadReports(t *testing.T) {
	at := timestamppb.New(time.Date(2026, 10, 18, 9, 30, 0, 0, time.UTC))
	done := &v1.Thread{Id: "s-867564981c98", Name: "Fix the login", Status: v1.ThreadStatus_THREAD_STATUS_NEEDS_ATTENTION, StatusReason: "finished",
		CreatedBy: "s-7754a478e649", Labels: []string{"bug"},
		ReportStatus: v1.ThreadReportStatus_THREAD_REPORT_STATUS_DONE, ReportSummary: "Fixed the\nredirect", ReportData: `{"pr": 12, "files": ["a.go"]}`, ReportAt: at}
	blocked := &v1.Thread{Id: "s-000000000002", Name: "Docs", Status: v1.ThreadStatus_THREAD_STATUS_IDLE, CreatedBy: "s-7754a478e649",
		ReportStatus: v1.ThreadReportStatus_THREAD_REPORT_STATUS_BLOCKED, ReportSummary: "needs a token"}
	silent := &v1.Thread{Id: "s-000000000003", Status: v1.ThreadStatus_THREAD_STATUS_BUSY, CreatedBy: "s-7754a478e649"}
	children := []*v1.Thread{done, blocked, silent}
	tests := []struct {
		name       string
		args       map[string]string
		threads    []*v1.Thread
		wantFilter *v1.ThreadFilter
		wantMsg    string
		wantIDs    []string // the --json answer's ids
		wantCode   connect.Code
		wantArgErr bool
	}{
		{name: "every child, unreported ones with -", args: map[string]string{"created-by": "64981c98"}, threads: children,
			wantFilter: &v1.ThreadFilter{CreatedBy: "s-867564981c98"}, // the fake does not filter
			wantMsg: "s-867564981c98  done     Fix the login  Fixed the redirect (data)\n" +
				"s-000000000002  blocked  Docs           needs a token\n" +
				"s-000000000003  -        (unnamed)",
			wantIDs: []string{"s-867564981c98", "s-000000000002", "s-000000000003"}},
		{name: "full prints the data under its line", args: map[string]string{"full": "true"}, threads: []*v1.Thread{done, silent},
			wantFilter: &v1.ThreadFilter{},
			wantMsg: "s-867564981c98  done  Fix the login  Fixed the redirect\n" +
				"    {\n      \"pr\": 12,\n      \"files\": [\n        \"a.go\"\n      ]\n    }\n" +
				"s-000000000003  -     (unnamed)",
			wantIDs: []string{"s-867564981c98", "s-000000000003"}},
		{name: "status filters here", args: map[string]string{"status": "blocked"}, threads: children,
			wantFilter: &v1.ThreadFilter{}, wantMsg: "s-000000000002  blocked  Docs  needs a token", wantIDs: []string{"s-000000000002"}},
		{name: "none is the unreported", args: map[string]string{"status": "none"}, threads: children,
			wantFilter: &v1.ThreadFilter{}, wantMsg: "s-000000000003  -  (unnamed)", wantIDs: []string{"s-000000000003"}},
		{name: "limit after the status filter", args: map[string]string{"limit": "1", "status": "blocked"}, threads: children,
			wantFilter: &v1.ThreadFilter{}, wantIDs: []string{"s-000000000002"}, wantMsg: "s-000000000002  blocked  Docs  needs a token"},
		{name: "limit", args: map[string]string{"limit": "2"}, threads: children,
			wantFilter: &v1.ThreadFilter{}, wantIDs: []string{"s-867564981c98", "s-000000000002"},
			wantMsg: "s-867564981c98  done     Fix the login  Fixed the redirect (data)\ns-000000000002  blocked  Docs           needs a token"},
		// all keeps the other filters: ThreadFilter.all would drop them.
		{name: "all and labels", args: map[string]string{"all": "true", "label": "bug, auth", "created-by": "user"},
			wantFilter: &v1.ThreadFilter{IncludeArchived: true, CreatedBy: "user", Labels: []string{"bug", "auth"}}, wantMsg: "no threads", wantIDs: []string{}},
		{name: "empty says archived threads are left out", wantFilter: &v1.ThreadFilter{},
			wantMsg: "no threads (archived threads are left out; --archived includes them)", wantIDs: []string{}},
		{name: "created-by an unknown suffix", args: map[string]string{"created-by": "ffff"}, wantCode: connect.CodeNotFound},
		{name: "a negative limit", args: map[string]string{"limit": "-1"}, wantArgErr: true},
		{name: "an unknown status", args: map[string]string{"status": "shipped"}, wantArgErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg := command.NewRegistry()
			b := &commandtest.Thread{Others: tt.threads}
			if err := command.RegisterThreadReports(reg, b); err != nil {
				t.Fatal(err)
			}
			res, err := reg.Invoke(context.Background(), command.Context{}, "thread.reports", tt.args)
			switch {
			case tt.wantArgErr:
				if !errors.Is(err, command.ErrInvalidArgs) {
					t.Fatalf("err = %v, want an argument error", err)
				}
				return
			case tt.wantCode != 0:
				if connect.CodeOf(err) != tt.wantCode {
					t.Fatalf("err = %v, want %v", err, tt.wantCode)
				}
				return
			case err != nil:
				t.Fatal(err)
			}
			var got *v1.ThreadFilter
			for _, r := range b.Requests() {
				if l, ok := r.(*v1.ListThreadsRequest); ok && !l.GetFilter().GetAll() {
					got = l.GetFilter()
				}
			}
			if !proto.Equal(got, tt.wantFilter) {
				t.Errorf("filter = %v, want %v", got, tt.wantFilter)
			}
			if res.Message != tt.wantMsg {
				t.Errorf("output =\n%s\nwant\n%s", res.Message, tt.wantMsg)
			}
			reports, ok := res.JSON.([]command.ThreadReport)
			if !ok {
				t.Fatalf("JSON = %T", res.JSON)
			}
			var ids []string
			for _, r := range reports {
				ids = append(ids, r.ID)
			}
			if strings.Join(ids, ",") != strings.Join(tt.wantIDs, ",") {
				t.Errorf("JSON ids = %v, want %v", ids, tt.wantIDs)
			}
		})
	}
}

// The --json answer is compact: the report's data as an object, the thread status
// without its reason, none for no report, labels never null.
func TestThreadReportsJSON(t *testing.T) {
	at := timestamppb.New(time.Date(2026, 10, 18, 9, 30, 0, 0, time.UTC))
	reg := command.NewRegistry()
	b := &commandtest.Thread{Others: []*v1.Thread{
		{Id: "s-1", Name: "a", Status: v1.ThreadStatus_THREAD_STATUS_NEEDS_ATTENTION, StatusReason: "finished", CreatedBy: "s-0", Labels: []string{"x"},
			ReportStatus: v1.ThreadReportStatus_THREAD_REPORT_STATUS_DONE, ReportSummary: "ok", ReportData: `{"n": 1}`, ReportAt: at},
		{Id: "s-2", Status: v1.ThreadStatus_THREAD_STATUS_BUSY},
	}}
	if err := command.RegisterThreadReports(reg, b); err != nil {
		t.Fatal(err)
	}
	res, err := reg.Invoke(context.Background(), command.Context{}, "thread.reports", nil)
	if err != nil {
		t.Fatal(err)
	}
	js, err := res.EncodeJSON()
	if err != nil {
		t.Fatal(err)
	}
	want := `[{"id":"s-1","name":"a","status":"attention","reportStatus":"done","reportSummary":"ok","reportData":{"n":1},` +
		`"reportAt":"2026-10-18T09:30:00Z","createdBy":"s-0","labels":["x"]},` +
		`{"id":"s-2","name":"","status":"busy","reportStatus":"none","createdBy":"","labels":[]}]`
	if js != want {
		t.Errorf("JSON =\n%s\nwant\n%s", js, want)
	}
	if !json.Valid([]byte(js)) {
		t.Error("invalid JSON")
	}
}
