package command

import (
	"slices"
	"strings"
	"testing"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// thread.respond names a question's answer as one (E3 item 6).
func TestAnsweredLine(t *testing.T) {
	tests := []struct {
		answers map[string]string
		want    string
	}{
		{map[string]string{"Which color?": "Blue"}, `answered "Which color?": Blue`},
		{map[string]string{"Year?": "2026", "License?": "MIT"}, `answered "License?": MIT; "Year?": 2026`},
	}
	for _, tt := range tests {
		if got := answeredLine(tt.answers); got != tt.want {
			t.Errorf("answeredLine(%v) = %q, want %q", tt.answers, got, tt.want)
		}
	}
}

// thread.get marks a report made before the thread's last message (E6 §4.2, W4 finding 5).
func TestThreadDetailStaleReport(t *testing.T) {
	tests := []struct {
		name  string
		stale bool
		want  string
	}{
		{name: "current", want: "report: done: Added --json"},
		{name: "stale", stale: true, want: "report: done*: Added --json (report predates its last message)"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := &v1.Thread{Id: "s-1", ReportStatus: v1.ThreadReportStatus_THREAD_REPORT_STATUS_DONE, ReportSummary: "Added --json",
				ReportStale: tt.stale}
			lines := strings.Split(threadDetail(s, nil), "\n")
			if !slices.Contains(lines, tt.want) {
				t.Errorf("no line %q in\n%s", tt.want, strings.Join(lines, "\n"))
			}
		})
	}
}

// thread.get names the pending request under the status (W2 finding 4).
func TestThreadDetailPendingLine(t *testing.T) {
	tests := []struct {
		name    string
		pending *v1.ThreadPendingDetail
		want    string // the pending line; "" for none
	}{
		{name: "none"},
		{name: "a permission", pending: &v1.ThreadPendingDetail{Kind: "permission", RequestId: "r1", Tool: "Bash"},
			want: "pending: permission Bash (request r1)"},
		{name: "a question", pending: &v1.ThreadPendingDetail{Kind: "question", RequestId: "r2", Tool: "AskUserQuestion",
			Question: "Which color?", Options: []string{"Red", "Blue"}},
			want: `pending: question "Which color?" [Red | Blue] (request r2)`},
		{name: "several questions", pending: &v1.ThreadPendingDetail{Kind: "question", RequestId: "r3", Question: "A?",
			Questions: []*v1.ThreadPendingQuestion{{Question: "A?"}, {Question: "B?"}}},
			want: "pending: question: 2 questions (request r3)"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := &v1.Thread{Id: "s-1", Status: v1.ThreadStatus_THREAD_STATUS_NEEDS_ATTENTION, StatusReason: "permission: Bash ls",
				WorktreePath: "/wt", Pending: tt.pending}
			lines := strings.Split(threadDetail(s, nil), "\n")
			got := ""
			if strings.HasPrefix(lines[2], "pending: ") {
				got = lines[2]
			}
			if got != tt.want {
				t.Errorf("line 3 = %q, want %q\n%s", lines[2], tt.want, strings.Join(lines, "\n"))
			}
		})
	}
}
