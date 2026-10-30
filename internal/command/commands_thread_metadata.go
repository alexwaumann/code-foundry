package command

import (
	"context"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// Thread metadata for agents that create and supervise other threads
// (docs/notes/agents-2-metadata.md): thread.get prints one thread, thread.label edits
// its labels, thread.report records how its task went and thread.budget sets its
// spending limit. thread.new's created-by, brief, labels and budget args set them at
// creation (commands_thread_lifecycle.go). Every id defaults to the context thread, so
// an agent acts on its own thread unless it names another.

// MetadataBackend is the slice of ThreadService the metadata commands need.
type MetadataBackend interface {
	Label(context.Context, *connect.Request[v1.LabelThreadRequest]) (*connect.Response[v1.LabelThreadResponse], error)
	Report(context.Context, *connect.Request[v1.ReportThreadRequest]) (*connect.Response[v1.ReportThreadResponse], error)
	SetBudget(context.Context, *connect.Request[v1.SetThreadBudgetRequest]) (*connect.Response[v1.SetThreadBudgetResponse], error)
}

// ThreadReportStatuses are thread.report's status values.
var ThreadReportStatuses = []string{"done", "blocked", "failed", "progress"}

var threadReportStatuses = map[string]v1.ThreadReportStatus{
	"done":     v1.ThreadReportStatus_THREAD_REPORT_STATUS_DONE,
	"blocked":  v1.ThreadReportStatus_THREAD_REPORT_STATUS_BLOCKED,
	"failed":   v1.ThreadReportStatus_THREAD_REPORT_STATUS_FAILED,
	"progress": v1.ThreadReportStatus_THREAD_REPORT_STATUS_PROGRESS,
}

// reportStatusName is a report status as thread.report spells it; "" for none.
func reportStatusName(s v1.ThreadReportStatus) string {
	for name, v := range threadReportStatuses {
		if v == s {
			return name
		}
	}
	return ""
}

// parseUSD reads a budget in USD: "5", "5.00", "$0.25"; 0 clears. Never negative.
func parseUSD(arg, s string) (float64, error) {
	v, err := strconv.ParseFloat(strings.TrimPrefix(strings.TrimSpace(s), "$"), 64)
	if err != nil || math.IsNaN(v) || math.IsInf(v, 0) || v < 0 {
		return 0, InvalidArg(arg, "%q is not an amount in USD (5, 5.00, 0.25; 0 for none)", s)
	}
	return v, nil
}

// formatBudget is a budget for a message: two decimals, or every digit it needs below a
// cent ($0.0001), like the daemon's notes. Costs use formatUSD.
func formatBudget(usd float64) string {
	if usd >= 0.01 || usd == 0 {
		return "$" + strconv.FormatFloat(usd, 'f', 2, 64)
	}
	return "$" + strconv.FormatFloat(usd, 'f', -1, 64)
}

// labelList is a thread's labels for a message: "a, b", or "none".
func labelList(s *v1.Thread) string {
	if len(s.GetLabels()) == 0 {
		return "none"
	}
	return strings.Join(s.GetLabels(), ", ")
}

// staleNote follows a report made before its thread's last message (Thread.report_stale,
// the wake's rule), whose status thread.get and thread.reports mark with "*" (E6 §4.2,
// W4 finding 5: a superseded done looked current).
const staleNote = "(report predates its last message)"

// threadDetail is thread.get's text: one "key: value" line per fact the thread has.
// names resolves the creator (threadNames): its current name, or the recorded one and
// "removed".
func threadDetail(s *v1.Thread, names map[string]string) string {
	lines := []string{"thread " + threadLabel(s), "status: " + waitStatus(s)}
	if p := s.GetPending(); p != nil {
		lines = append(lines, "pending: "+pendingLine(p))
	}
	if l := transcriptMissingLine(s); l != "" { // commands_thread_transcript.go
		lines = append(lines, l)
	}
	// Where the thread is listed: an agent sending to an archived child unarchives it.
	if at := s.GetArchivedAt(); at != nil {
		lines = append(lines, "archived: "+at.AsTime().Local().Format(time.DateTime))
	}
	if at := s.GetSnoozedUntil(); at != nil {
		lines = append(lines, "snoozed until: "+at.AsTime().Local().Format(time.DateTime))
	}
	if s.GetPinned() {
		lines = append(lines, "pinned")
	}
	lines = append(lines, "worktree: "+s.GetWorktreePath())
	if s.GetBranch() != "" {
		// The branch the worktree was made for (what a recreation checks out again), not
		// what it has checked out now (thread checkouts).
		lines = append(lines, "created for branch: "+s.GetBranch())
	}
	if s.GetCreatedBy() != "" {
		name, exists := creatorName(s, names)
		ref := s.GetCreatedBy()
		if !exists {
			ref += ", removed"
		}
		lines = append(lines, "created by: "+name+" ("+ref+")")
	}
	if s.GetParentId() != "" {
		lines = append(lines, "forked from: "+s.GetParentId())
	}
	if s.GetBrief() != "" {
		lines = append(lines, "brief: "+s.GetBrief())
	}
	if len(s.GetLabels()) > 0 {
		lines = append(lines, "labels: "+labelList(s))
	}
	if st := reportStatusName(s.GetReportStatus()); st != "" {
		r := "report: " + st
		if s.GetReportStale() {
			r += "*"
		}
		if s.GetReportSummary() != "" {
			r += ": " + s.GetReportSummary()
		}
		if at := s.GetReportAt(); at != nil {
			r += " (" + at.AsTime().Local().Format(time.DateTime) + ")"
		}
		if s.GetReportStale() {
			r += " " + staleNote
		}
		lines = append(lines, r)
		if s.GetReportData() != "" {
			lines = append(lines, "report data: "+s.GetReportData())
		}
	}
	if l := flagsLine(s); l != "" {
		lines = append(lines, l)
	}
	if l := pluginEnvLine(s); l != "" { // commands_thread_restart.go
		lines = append(lines, l)
	}
	if l := sessionLine(s); l != "" { // commands_thread_reseed.go
		lines = append(lines, l)
	}
	lines = append(lines, shellLines(s)...) // commands_thread_shell.go
	cost := "cost: " + formatUSD(s.GetCostUsd())
	if s.GetUnpriced() {
		cost += " (some usage unpriced)"
	}
	if b := s.GetBudgetUsd(); b > 0 {
		cost += " of a " + formatBudget(b) + " budget"
	}
	return strings.Join(append(lines, cost), "\n")
}

// pendingLine is thread.get's line for the pending request: `permission Bash (request
// r1)`, `question "Which color?" [Red | Blue] (request r2)`; --json has the input.
func pendingLine(p *v1.ThreadPendingDetail) string {
	line := p.GetKind()
	switch {
	case len(p.GetQuestions()) > 1:
		line += fmt.Sprintf(": %d questions", len(p.GetQuestions()))
	case p.GetQuestion() != "":
		line += " " + strconv.Quote(p.GetQuestion())
		if len(p.GetOptions()) > 0 {
			line += " [" + strings.Join(p.GetOptions(), " | ") + "]"
		}
	case p.GetTool() != "":
		line += " " + p.GetTool()
	}
	return line + " (request " + p.GetRequestId() + ")"
}

func threadGet(b ThreadBackend, idArg ArgSpec) Command {
	idArg.Positional = true
	return Command{
		Name:      "thread.get",
		NoPalette: true,
		ReadOnly:  true,
		Title:     "Show Thread",
		Description: "Print one thread: its status and pending request, worktree, who created it and why, labels, report " +
			"(`*`: from before its last message) and cost.",
		Category:     "Thread",
		NoKeybinding: true,
		Args:         []ArgSpec{idArg},
		When:         hasThread,
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			res, err := b.Get(ctx, connect.NewRequest(&v1.GetThreadRequest{Id: a.String("id"), WithDetail: true}))
			if r, ok := removedFrom(err); ok {
				return removedGetResult(r), nil
			}
			if err != nil {
				return Result{}, err
			}
			s := res.Msg.GetThread()
			names, err := threadNames(ctx, b, []*v1.Thread{s})
			if err != nil {
				return Result{}, err
			}
			return Result{Message: threadDetail(s, names), JSON: s}, nil
		},
	}
}

func threadLabelCmd(b ThreadBackend, idArg ArgSpec) Command {
	return Command{
		Name:      "thread.label",
		NoPalette: true,
		Title:     "Label Thread",
		Description: "Add or remove a thread's labels (lowercase letters, digits, -, _, . and /; up to 40 characters each). " +
			"clear removes every label first, then remove's go, then add's are added. Prints the labels.",
		Category: "Thread",
		Args: []ArgSpec{
			idArg,
			{Name: "add", Type: String, Positional: true, Description: "Comma-separated labels to add"},
			{Name: "remove", Type: String, Description: "Comma-separated labels to remove"},
			{Name: "clear", Type: Bool, Description: "Remove every label first"},
		},
		When: hasThread,
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			res, err := b.Label(ctx, connect.NewRequest(&v1.LabelThreadRequest{
				Id: a.String("id"), Add: splitList(a.String("add")), Remove: splitList(a.String("remove")), Clear: a.Bool("clear"),
			}))
			if err != nil {
				return Result{}, err
			}
			s := res.Msg.GetThread()
			return Result{Message: "labels of thread " + threadLabel(s) + ": " + labelList(s), JSON: s}, nil
		},
	}
}

func threadReportCmd(b ThreadBackend, idArg ArgSpec) Command {
	return Command{
		Name:      "thread.report",
		NoPalette: true,
		Title:     "Report on Thread",
		Description: "Record how a thread's task went: done, blocked, failed or progress, " +
			"a summary and optional JSON data. A new report replaces the previous one; the thread's creator reads it with thread reports.",
		Category:     "Thread",
		NoKeybinding: true,
		Args: []ArgSpec{
			idArg,
			{Name: "status", Type: Enum, Enum: ThreadReportStatuses, Required: true, Positional: true, Description: "done, blocked, failed or progress"},
			{Name: "summary", Type: String, Positional: true, Description: "What happened, in at most 1000 characters (a longer one is cut)"},
			{Name: "data", Type: String, FileOrStdin: true, Description: "A JSON object of results, at most 16 KiB (@file: from a file, -: stdin)"},
		},
		When: hasThread,
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			res, err := b.Report(ctx, connect.NewRequest(&v1.ReportThreadRequest{
				Id: a.String("id"), Status: threadReportStatuses[a.String("status")], Summary: a.String("summary"), Data: a.String("data"),
			}))
			if err != nil {
				return Result{}, err
			}
			s := res.Msg.GetThread()
			msg := "reported " + reportStatusName(s.GetReportStatus()) + " on thread " + threadLabel(s)
			if n := res.Msg.GetSummaryCutFrom(); n > 0 {
				msg += fmt.Sprintf(" (the summary had %d characters and was cut to 1000; details belong in --data)", n)
			}
			if s.GetReportSummary() != "" {
				msg += ": " + s.GetReportSummary()
			}
			return Result{Message: msg, JSON: s}, nil
		},
	}
}

func threadBudgetCmd(b ThreadBackend, idArg ArgSpec) Command {
	return Command{
		Name:      "thread.budget",
		NoPalette: true,
		Title:     "Set Thread Budget",
		Description: "Set a thread's spending limit in USD at Claude API rates (0 removes it). When the thread's cost reaches it " +
			"while Claude works, Claude is interrupted and the thread needs attention (\"budget reached\"); messages can still be sent. " +
			"A budget above the cost re-arms it.",
		Category: "Thread",
		Args: []ArgSpec{
			idArg,
			{Name: "usd", Type: String, Required: true, Positional: true, Description: "Budget in USD, e.g. 5 or 0.25; 0 removes it"},
		},
		When: hasThread,
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			usd, err := parseUSD("usd", a.String("usd"))
			if err != nil {
				return Result{}, err
			}
			res, err := b.SetBudget(ctx, connect.NewRequest(&v1.SetThreadBudgetRequest{Id: a.String("id"), BudgetUsd: usd}))
			if err != nil {
				return Result{}, err
			}
			s := res.Msg.GetThread()
			spent := "spent " + formatUSD(s.GetCostUsd())
			if s.GetBudgetUsd() == 0 {
				return Result{Message: fmt.Sprintf("removed the budget of thread %s (%s)", threadLabel(s), spent), JSON: s}, nil
			}
			return Result{Message: fmt.Sprintf("budget of thread %s: %s (%s)", threadLabel(s), formatBudget(s.GetBudgetUsd()), spent), JSON: s}, nil
		},
	}
}
