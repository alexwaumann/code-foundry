package thread

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/alexwaumann/code-foundry/internal/pricing"
)

// Thread metadata for agent-created threads (docs/notes/agents-2-metadata.md): who
// created a thread and why (CreatedBy, Brief), labels, the thread's latest report and
// its spending limit. Create validates and records the first three; Label, Report and
// SetBudget change the rest. Every change commits the thread (persisted, published on
// the thread list). The budget stop itself is in budget.go.

// Limits on the metadata.
const (
	MaxBriefRunes         = 500
	MaxLabelRunes         = 40
	MaxLabels             = 32
	MaxReportSummaryRunes = 1000
	MaxReportDataBytes    = 16 << 10
)

// ReportStatus is how a thread's task went, as its agent reports it. Values mirror
// codefoundry.v1.ThreadReportStatus.
type ReportStatus int

// Report statuses.
const (
	ReportNone ReportStatus = iota
	ReportDone
	ReportBlocked
	ReportFailed
	ReportProgress
)

func (s ReportStatus) String() string {
	switch s {
	case ReportDone:
		return "done"
	case ReportBlocked:
		return "blocked"
	case ReportFailed:
		return "failed"
	case ReportProgress:
		return "progress"
	default:
		return "none"
	}
}

func (s ReportStatus) valid() bool { return s >= ReportNone && s <= ReportProgress }

// Report is a thread's latest report (Store.Report). Data is a compacted JSON object,
// "" for none. At is when it was made; zero when the thread never reported.
type Report struct {
	Status  ReportStatus
	Summary string
	Data    string
	At      time.Time
}

// createdByNoteID is the id of the note that starts a thread an agent created.
const createdByNoteID = "note-created-by"

// createdByNoteText is that note: "Created by <name> · brief: <brief>", without the
// brief part when there is none.
func createdByNoteText(name, brief string) string {
	text := "Created by " + name
	if brief != "" {
		text += " · brief: " + brief
	}
	return text
}

// CleanBrief trims a brief and checks its length.
func CleanBrief(b string) (string, error) {
	b = strings.TrimSpace(b)
	switch {
	case strings.ContainsRune(b, 0):
		return "", fmt.Errorf("%w: brief contains a NUL byte", ErrInvalidArgument)
	case utf8.RuneCountInString(b) > MaxBriefRunes:
		return "", fmt.Errorf("%w: brief is %d characters; at most %d", ErrInvalidArgument, utf8.RuneCountInString(b), MaxBriefRunes)
	}
	return b, nil
}

// CleanLabel trims and lowercases a label and checks it: 1 to MaxLabelRunes of a-z,
// 0-9, '-', '_', '.', '/'.
func CleanLabel(l string) (string, error) {
	l = strings.ToLower(strings.TrimSpace(l))
	if l == "" || utf8.RuneCountInString(l) > MaxLabelRunes {
		return "", fmt.Errorf("%w: label %q must have 1 to %d characters", ErrInvalidArgument, l, MaxLabelRunes)
	}
	for _, c := range l {
		if (c < 'a' || c > 'z') && (c < '0' || c > '9') && !strings.ContainsRune("-_./", c) {
			return "", fmt.Errorf("%w: label %q may only have lowercase letters, digits, -, _, . and /", ErrInvalidArgument, l)
		}
	}
	return l, nil
}

// CleanLabels validates labels and returns them sorted and deduplicated: a new slice,
// nil for none.
func CleanLabels(labels []string) ([]string, error) {
	var out []string
	for _, l := range labels {
		c, err := CleanLabel(l)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	slices.Sort(out)
	out = slices.Compact(out)
	if len(out) > MaxLabels {
		return nil, fmt.Errorf("%w: %d labels; at most %d", ErrInvalidArgument, len(out), MaxLabels)
	}
	return out, nil
}

// EditLabels is Label's result for a thread with labels cur.
func EditLabels(cur, add, remove []string, clear bool) ([]string, error) {
	add, err := CleanLabels(add)
	if err != nil {
		return nil, err
	}
	remove, err = CleanLabels(remove)
	if err != nil {
		return nil, err
	}
	for _, l := range add {
		if slices.Contains(remove, l) {
			return nil, fmt.Errorf("%w: label %q is both added and removed", ErrInvalidArgument, l)
		}
	}
	var out []string
	if !clear {
		out = slices.DeleteFunc(slices.Clone(cur), func(l string) bool { return slices.Contains(remove, l) })
	}
	return CleanLabels(append(out, add...))
}

// CleanReport validates a report's status, summary and data; data is compacted.
func CleanReport(r Report) (Report, error) {
	if r.Status == ReportNone || !r.Status.valid() {
		return Report{}, fmt.Errorf("%w: report status %d: give done, blocked, failed or progress", ErrInvalidArgument, r.Status)
	}
	r.Summary = strings.TrimSpace(r.Summary)
	if strings.ContainsRune(r.Summary, 0) {
		return Report{}, fmt.Errorf("%w: report summary contains a NUL byte", ErrInvalidArgument)
	}
	if n := utf8.RuneCountInString(r.Summary); n > MaxReportSummaryRunes {
		return Report{}, fmt.Errorf("%w: report summary is %d characters; at most %d", ErrInvalidArgument, n, MaxReportSummaryRunes)
	}
	data := bytes.TrimSpace([]byte(r.Data))
	if len(data) == 0 {
		r.Data = ""
		return r, nil
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(data, &obj); err != nil || obj == nil {
		return Report{}, fmt.Errorf("%w: report data must be a JSON object", ErrInvalidArgument)
	}
	var buf bytes.Buffer
	if err := json.Compact(&buf, data); err != nil {
		return Report{}, fmt.Errorf("%w: report data: %v", ErrInvalidArgument, err)
	}
	if buf.Len() > MaxReportDataBytes {
		return Report{}, fmt.Errorf("%w: report data is %d bytes; at most %d", ErrInvalidArgument, buf.Len(), MaxReportDataBytes)
	}
	r.Data = buf.String()
	return r, nil
}

// CheckBudget refuses a negative or non-finite budget.
func CheckBudget(usd float64) error {
	if math.IsNaN(usd) || math.IsInf(usd, 0) || usd < 0 {
		return fmt.Errorf("%w: budget %v: give 0 (none) or a positive amount in USD", ErrInvalidArgument, usd)
	}
	return nil
}

// UsageCost prices usage buckets at first-party API rates (the thread's cost_usd);
// unpriced buckets count 0.
func UsageCost(buckets []UsageBucket) float64 {
	var usd float64
	for _, b := range buckets {
		c, _ := pricing.Cost(pricing.Bucket{
			Model: b.Model, Tier: b.Tier, Speed: b.Speed,
			Input: b.Input, Output: b.Output, CacheRead: b.CacheRead,
			CacheWrite5m: b.CacheWrite5m, CacheWrite1h: b.CacheWrite1h,
		})
		usd += c
	}
	return usd
}

// FormatUSD is an amount for a message: two decimals ("$5.00"), or every digit it needs
// below a cent ("$0.0001").
func FormatUSD(usd float64) string {
	if usd >= 0.01 || usd == 0 {
		return "$" + strconv.FormatFloat(usd, 'f', 2, 64)
	}
	return "$" + strconv.FormatFloat(usd, 'f', -1, 64)
}

// creator resolves CreateOptions.CreatedBy: the creator's id and its name (its id when
// unnamed). Empty for none; ErrInvalidArgument for an unknown thread.
func (m *Manager) creator(id string) (string, string, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return "", "", nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.recs[id]
	if !ok {
		return "", "", fmt.Errorf("%w: created by %s: no such thread", ErrInvalidArgument, id)
	}
	name := rec.s.Name
	if name == "" {
		name = id
	}
	return id, name, nil
}

// Label implements Store.
func (m *Manager) Label(_ context.Context, id string, add, remove []string, clear bool) (Thread, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, err := m.record(id)
	if err != nil {
		return Thread{}, err
	}
	labels, err := EditLabels(rec.s.Labels, add, remove, clear)
	if err != nil {
		return Thread{}, err
	}
	if slices.Equal(labels, rec.s.Labels) {
		return rec.s, nil
	}
	rec.s.Labels = labels
	m.commitLocked(rec, true)
	m.log.Info("thread labels changed", "thread", id, "labels", labels)
	return rec.s, nil
}

// Report implements Store.
func (m *Manager) Report(_ context.Context, id string, r Report) (Thread, error) {
	r, err := CleanReport(r)
	if err != nil {
		return Thread{}, err
	}
	r.At = m.opts.Now().Round(0).Truncate(time.Millisecond)
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, err := m.record(id)
	if err != nil {
		return Thread{}, err
	}
	rec.s.Report = r
	m.commitLocked(rec, true)
	m.log.Info("thread reported", "thread", id, "status", r.Status.String(), "summary_chars", utf8.RuneCountInString(r.Summary), "data_bytes", len(r.Data))
	return rec.s, nil
}

// SetBudget implements Store. A budget above the thread's cost re-arms the stop
// (BudgetHitUSD 0); otherwise the marker stays, and a budget value it did not fire for
// fires on the thread's next priced response while Claude works (budget.go).
func (m *Manager) SetBudget(_ context.Context, id string, usd float64) (Thread, error) {
	if err := CheckBudget(usd); err != nil {
		return Thread{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, err := m.record(id)
	if err != nil {
		return Thread{}, err
	}
	if usd == 0 || usd > UsageCost(rec.s.Usage) {
		rec.s.BudgetHitUSD = 0
	}
	rec.s.BudgetUSD = usd
	m.commitLocked(rec, true)
	m.log.Info("thread budget set", "thread", id, "budget_usd", usd)
	return rec.s, nil
}

// startNote appends a note to a new thread's log before its first spawn and returns it;
// the caller saves the row once spawn wrote the thread's (thread_items references it).
func (m *Manager) startNote(ctx context.Context, id, noteID, text string) (Item, error) {
	log, err := m.thread(ctx, id)
	if err != nil {
		return Item{}, fmt.Errorf("thread: create %s: %w", id, err)
	}
	return log.append(Item{ID: noteID, Kind: KindNote, Text: text}), nil
}
