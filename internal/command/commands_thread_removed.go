package command

import (
	"cmp"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// Removed threads (docs/notes/removed-thread-signal.md). The daemon remembers a removed
// thread for a day (v1.RemovedThread): thread.wait, thread.send and thread.get on its
// id say it was removed and exit 1, instead of the usage exit 2 of an unknown id, and
// thread.reports --all and thread.list --all list it.

// removedTimeLayout is how a removal time is printed (the daemon's local time).
const removedTimeLayout = "2006-01-02 15:04:05"

// removedFrom returns the RemovedThread a NOT_FOUND error carries, when it does.
func removedFrom(err error) (*v1.RemovedThread, bool) {
	var ce *connect.Error
	if !errors.As(err, &ce) || ce.Code() != connect.CodeNotFound {
		return nil, false
	}
	for _, d := range ce.Details() {
		if m, derr := d.Value(); derr == nil {
			if r, ok := m.(*v1.RemovedThread); ok {
				return r, true
			}
		}
	}
	return nil, false
}

// removedLine is the first line every command prints for a removed thread: "thread
// <name> (<id>) was removed at <time>". thread.get, thread.wait, thread.send and
// thread.read print it alike (E4 4.5, W4 finding 4).
func removedLine(r *v1.RemovedThread) string {
	line := "thread " + r.GetId()
	if r.GetName() != "" {
		line = "thread " + r.GetName() + " (" + r.GetId() + ")"
	}
	line += " was removed"
	if at := r.GetRemovedAt(); at != nil {
		line += " at " + at.AsTime().Local().Format(removedTimeLayout)
	}
	return line
}

// removedWaitResult is thread.wait's, thread.send's and thread.read's answer for a
// removed thread: removedLine, its last report and cost, exit 1 (not the usage exit 2
// of an unknown id). --json: the thread as thread.reports has it, removed true. what,
// when set, starts the message ("sent to thread s-1; ").
func removedWaitResult(r *v1.RemovedThread, what string) Result {
	return Result{Message: withCost(withLastReport(what+removedLine(r), r), r), JSON: removedReport(r), ExitCode: 1}
}

// removedGetResult is thread.get's answer for a removed thread: removedLine, its
// creator and labels, its last report and cost, exit 1.
func removedGetResult(r *v1.RemovedThread) Result {
	line := removedLine(r)
	if by := r.GetCreatedBy(); by != "" {
		line += "\ncreated by: " + by
	}
	if len(r.GetLabels()) > 0 {
		line += "\nlabels: " + strings.Join(r.GetLabels(), ", ")
	}
	return Result{Message: withCost(withLastReport(line, r), r), JSON: removedReport(r), ExitCode: 1}
}

// withCost adds "cost: $0.09" (of its budget) under msg: what the removed thread cost.
func withCost(msg string, r *v1.RemovedThread) string {
	msg += "\ncost: " + formatUSD(r.GetCostUsd())
	if r.GetUnpriced() {
		msg += " (some usage unpriced)"
	}
	if b := r.GetBudgetUsd(); b > 0 {
		msg += " of a " + formatBudget(b) + " budget"
	}
	return msg
}

// withLastReport adds "last report: done — <summary>" (or "no report") under msg.
func withLastReport(msg string, r *v1.RemovedThread) string {
	st := reportStatusName(r.GetReportStatus())
	if st == "" {
		return msg + "\nno report"
	}
	msg += "\nlast report: " + st
	if s := oneLineText(r.GetReportSummary()); s != "" {
		msg += " — " + s
	}
	if r.GetReportData() != "" {
		msg += "\n" + indentJSON(r.GetReportData())
	}
	return msg
}

// indentJSON is a report's data indented under a report line; as it is should it not
// parse.
func indentJSON(data string) string {
	var v any
	if json.Unmarshal([]byte(data), &v) != nil {
		return "    " + data
	}
	out, err := json.MarshalIndent(v, "    ", "  ")
	if err != nil {
		return "    " + data
	}
	return "    " + string(out)
}

// removedReport is a removed thread as thread.reports' --json has it: status
// "removed", removed true.
func removedReport(r *v1.RemovedThread) ThreadReport {
	out := ThreadReport{
		ID: r.GetId(), Name: r.GetName(), Status: "removed", ReportStatus: cmp.Or(reportStatusName(r.GetReportStatus()), "none"),
		ReportSummary: r.GetReportSummary(), CreatedBy: r.GetCreatedBy(), Labels: slices.Clone(r.GetLabels()), Removed: true,
		CostUSD: r.GetCostUsd(),
	}
	if out.Labels == nil {
		out.Labels = []string{}
	}
	out.ReportData = reportDataJSON(r.GetReportData())
	if at := r.GetReportAt(); at != nil {
		t := at.AsTime().UTC()
		out.ReportAt = &t
	}
	if at := r.GetRemovedAt(); at != nil {
		t := at.AsTime().UTC()
		out.RemovedAt = &t
	}
	return out
}

// removedListLine is a removed thread's line in thread.list: the columns of a thread's,
// with "-" for its status and place, and [removed]. names resolves its creator.
func removedListLine(r *v1.RemovedThread, names map[string]string, now time.Time) string {
	name := r.GetName()
	if name == "" {
		name = "(unnamed)"
	}
	var removed time.Time
	if at := r.GetRemovedAt(); at != nil {
		removed = at.AsTime()
	}
	line := r.GetId() + "\t-\t" + name + "\t-\t" + age(removed, now) + "  [removed]"
	if by := r.GetCreatedBy(); by != "" {
		line += "  ↳ " + cmp.Or(names[by], by)
	}
	return line
}

// reportDataJSON is a report's data for --json: the object as it is, a JSON string
// should it not parse, nil when empty.
func reportDataJSON(d string) json.RawMessage {
	if d == "" {
		return nil
	}
	if json.Valid([]byte(d)) {
		return json.RawMessage(d)
	}
	s, _ := json.Marshal(d) // a string always marshals
	return s
}
