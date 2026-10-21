package command

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"text/tabwriter"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// thread.reports (docs/notes/agent-cli-feedback-2.md): the reports of many threads in
// one call, for an agent that created them and would otherwise read each with
// thread.get or harvest its wake messages. It reads ThreadService.List with a
// ThreadFilter like thread.list; the report status is filtered here, since the filter
// has no field for it. --json is a compact array of ThreadReport, not whole threads.

// ThreadReportsStatuses are thread.reports' status values: a report status
// (ThreadReportStatuses), or none for threads without a report.
var ThreadReportsStatuses = append(slices.Clone(ThreadReportStatuses), "none")

// ThreadReport is one thread in thread.reports' --json answer.
type ThreadReport struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// Status is the thread's status as thread.list's --status names it: busy, idle,
	// attention or error.
	Status string `json:"status"`
	// ReportStatus is done, blocked, failed or progress; none without a report.
	ReportStatus  string `json:"reportStatus"`
	ReportSummary string `json:"reportSummary,omitempty"`
	// ReportData is the report's JSON object as it is (the daemon validates it); a
	// string should it not parse.
	ReportData json.RawMessage `json:"reportData,omitempty"`
	ReportAt   *time.Time      `json:"reportAt,omitempty"`
	// Stale: the report was made before the thread's last message, so it describes an
	// older turn (Thread.report_stale, the wake's rule).
	Stale bool `json:"stale,omitempty"`
	// CreatedBy is the creator's id; "" for a thread the user started.
	CreatedBy string   `json:"createdBy"`
	Labels    []string `json:"labels"`
	// Removed is set, with Status "removed" and RemovedAt, for a thread removed within
	// the last day (--all lists them; commands_thread_removed.go).
	Removed   bool       `json:"removed,omitempty"`
	RemovedAt *time.Time `json:"removedAt,omitempty"`
	// CostUSD is what the thread cost (at removal, for a removed one); omitted at 0.
	CostUSD float64 `json:"costUsd,omitempty"`
	// Depth is how far below descendants-of the thread is (0: that thread); only with
	// descendants-of.
	Depth *int32 `json:"depth,omitempty"`
}

// RegisterThreadReports registers thread.reports.
func RegisterThreadReports(r *Registry, b ThreadBackend) error {
	return r.Register(Command{
		Name:  "thread.reports",
		Title: "Show Thread Reports",
		Description: "The reports of threads: one line each " +
			"(`-`: no report yet; `(data)`: it has JSON data, see full; `*`: from before its last message). --json: one object each.",
		Category:     "Thread",
		NoKeybinding: true,
		Args: []ArgSpec{
			{Name: "created-by", Type: String, Description: "Only threads created by this thread (id or suffix); user: by the user"},
			{Name: "label", Type: String, Description: "Comma-separated labels, all required"},
			{Name: "status", Type: Enum, Enum: ThreadReportsStatuses, Description: "Only threads with this report; none: not reported"},
			{Name: "archived", Type: Bool, Description: "Include archived threads"},
			{Name: "all", Type: Bool, Description: "Archived and removed too"},
			{Name: "full", Type: Bool, Description: "Print each report's JSON data"},
			{Name: "limit", Type: Int, Description: "At most this many, most recently active first (0: all)"},
			descendantsArg("only it and the threads below it, as a tree (each lead before its workers) with costs and a total line"),
		},
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			limit := a.Int("limit")
			if limit < 0 {
				return Result{}, InvalidArg("limit", "limit must be 0 (no limit) or more, not %d", limit)
			}
			by, err := resolveCreatedBy(ctx, b, a.String("created-by"))
			if err != nil {
				return Result{}, err
			}
			// all here only adds the archived and removed threads: ThreadFilter.all would
			// also drop created-by and labels, which this command is for.
			f := &v1.ThreadFilter{IncludeArchived: a.Bool("archived") || a.Bool("all"), IncludeRemoved: a.Bool("all"), CreatedBy: by,
				Labels: splitList(a.String("label")), DescendantsOf: a.String("descendants-of")}
			res, err := b.List(ctx, connect.NewRequest(&v1.ListThreadsRequest{Filter: f}))
			if err != nil {
				return Result{}, err
			}
			all := make([]ThreadReport, 0, len(res.Msg.GetThreads())+len(res.Msg.GetRemoved()))
			for _, s := range res.Msg.GetThreads() {
				all = append(all, threadReport(s))
			}
			for _, r := range res.Msg.GetRemoved() {
				all = append(all, removedReport(r))
			}
			out := filterReports(all, a.String("status"), limit)
			markStale(ctx, b, out)
			return Result{Message: formatThreadReports(out, f, a.Bool("full")), JSON: out}, nil
		},
	})
}

// resolveCreatedBy is a created-by filter as ThreadFilter takes it: "" and "user" as
// they are, else the full id of the thread it names (an id or a unique suffix).
func resolveCreatedBy(ctx context.Context, b ThreadBackend, by string) (string, error) {
	by = strings.TrimSpace(by)
	if by == "" || by == "user" {
		return by, nil
	}
	ids, err := threadIDs(b)(ctx)
	if err != nil {
		return "", err
	}
	return ResolveID(ThreadID, "created-by", by, ids)
}

// filterReports keeps the reports whose status is status ("" any, "none" no report),
// at most limit of them (0: all).
func filterReports(reports []ThreadReport, status string, limit int) []ThreadReport {
	out := []ThreadReport{}
	for _, r := range reports {
		if status != "" && r.ReportStatus != status {
			continue
		}
		out = append(out, r)
		if limit > 0 && len(out) == limit {
			break
		}
	}
	return out
}

// markStale sets Stale on each report its thread's detail says predates its last
// message (GetThreadRequest.with_detail reads the thread's items, so only threads with a
// report are asked). A thread gone meanwhile stays as listed.
func markStale(ctx context.Context, b ThreadBackend, reports []ThreadReport) {
	for i, r := range reports {
		if r.Removed || r.ReportStatus == "none" {
			continue
		}
		res, err := b.Get(ctx, connect.NewRequest(&v1.GetThreadRequest{Id: r.ID, WithDetail: true}))
		if err == nil {
			reports[i].Stale = res.Msg.GetThread().GetReportStale()
		}
	}
}

// reportWord is s's report status as thread.reports' status names it; "none" without
// a report.
func reportWord(s *v1.Thread) string {
	if w := reportStatusName(s.GetReportStatus()); w != "" {
		return w
	}
	return "none"
}

// threadReport is s for thread.reports' --json.
func threadReport(s *v1.Thread) ThreadReport {
	r := ThreadReport{
		ID: s.GetId(), Name: s.GetName(), Status: threadStatusName(s), ReportStatus: reportWord(s),
		ReportSummary: s.GetReportSummary(), CreatedBy: s.GetCreatedBy(), Labels: slices.Clone(s.GetLabels()),
		CostUSD: s.GetCostUsd(), Depth: s.Depth,
	}
	if r.Labels == nil {
		r.Labels = []string{}
	}
	r.ReportData = reportDataJSON(s.GetReportData())
	if at := s.GetReportAt(); at != nil {
		t := at.AsTime().UTC()
		r.ReportAt = &t
	}
	return r
}

// threadStatusName is a thread status as thread.list's --status names it, without the
// reason threadStatusWord adds (noStatusWord before it has one).
func threadStatusName(s *v1.Thread) string {
	for name, v := range threadListStatuses {
		if v == s.GetStatus() {
			return name
		}
	}
	return noStatusWord(s)
}

// formatThreadReports is thread.reports' text: one aligned line per thread, each with
// its JSON data indented under it when full is set (else a "(data)" marker), or why
// the list is empty. With f.descendants_of the reports are a subtree in tree order:
// each name indented for its depth (subtreeName), its cost before the summary, and a
// total line.
func formatThreadReports(reports []ThreadReport, f *v1.ThreadFilter, full bool) string {
	if len(reports) == 0 {
		if !f.GetIncludeArchived() {
			return "no threads (archived threads are left out; --archived includes them)"
		}
		if !f.GetIncludeRemoved() {
			return "no threads (removed threads are left out; --all includes them)"
		}
		return "no threads"
	}
	tree := f.GetDescendantsOf() != ""
	var cost float64
	var sb strings.Builder
	tw := tabwriter.NewWriter(&sb, 0, 4, 2, ' ', 0)
	for _, r := range reports {
		st := r.ReportStatus
		if st == "none" {
			st = "-"
		}
		name := r.Name
		if name == "" {
			name = "(unnamed)"
		}
		summary := oneLineText(r.ReportSummary)
		if r.Removed {
			// The status column says removed; the last report goes before its summary.
			switch {
			case st == "-":
				summary = "no report"
			case summary == "":
				summary = "last report " + st
			default:
				summary = "last report " + st + ": " + summary
			}
			st = "removed"
		}
		if len(r.ReportData) > 0 && !full {
			summary = strings.TrimSpace(summary + " (data)")
		}
		if r.Stale {
			st += "*"
			summary = strings.TrimSpace(summary + " " + staleNote)
		}
		if tree {
			name = subtreeName(name, r.depth()) + "\t" + formatUSD(r.CostUSD)
			cost += r.CostUSD
		}
		_, _ = fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", r.ID, st, name, summary)
	}
	_ = tw.Flush()
	// The data goes in after the alignment: a line without cells would end tabwriter's
	// column block and misalign the rows after it.
	lines := strings.Split(strings.TrimRight(sb.String(), "\n"), "\n")
	var out []string
	for i, line := range lines {
		out = append(out, strings.TrimRight(line, " "))
		if full && len(reports[i].ReportData) > 0 {
			var buf bytes.Buffer
			if json.Indent(&buf, reports[i].ReportData, "    ", "  ") == nil {
				out = append(out, "    "+buf.String())
			}
		}
	}
	if tree {
		out = append(out, subtreeTotal(len(reports), cost))
	}
	return strings.Join(out, "\n")
}

// depth is r's Depth, 0 without one.
func (r ThreadReport) depth() int32 {
	if r.Depth == nil {
		return 0
	}
	return *r.Depth
}

// oneLineText joins a text's lines with spaces.
func oneLineText(s string) string { return strings.Join(strings.Fields(s), " ") }
