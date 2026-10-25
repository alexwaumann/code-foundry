package command

import (
	"cmp"
	"context"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"text/tabwriter"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// Token usage (docs/notes/session-usage.md). The daemon prices every bucket
// (UsageBucket.cost_usd, .unpriced) so this file only adds up.

// UsageModel is one model's row in a usage report.
type UsageModel struct {
	Model        string  `json:"model"`
	Requests     int64   `json:"requests"`
	Input        int64   `json:"input"`
	Output       int64   `json:"output"`
	CacheRead    int64   `json:"cache_read"`
	CacheWrite5m int64   `json:"cache_write_5m"`
	CacheWrite1h int64   `json:"cache_write_1h"`
	Tokens       int64   `json:"tokens"`
	CostUSD      float64 `json:"cost_usd"`
	// CacheSavingsUSD is what cache reads saved against the input rate (priced buckets).
	CacheSavingsUSD float64 `json:"cache_savings_usd"`
	// Unpriced: some of the row's buckets have no known rate; CostUSD leaves them out
	// and the text table shows "—".
	Unpriced bool `json:"unpriced,omitempty"`
	// Share of the priced total cost, 0..1; 0 when unpriced.
	Share float64 `json:"share"`
}

// UsageDay is one bucket of a usage report, as the daemon sent it.
type UsageDay struct {
	Day          string  `json:"day"`
	Model        string  `json:"model"`
	Tier         string  `json:"tier,omitempty"`
	Speed        string  `json:"speed,omitempty"`
	Requests     int64   `json:"requests"`
	Input        int64   `json:"input"`
	Output       int64   `json:"output"`
	CacheRead    int64   `json:"cache_read"`
	CacheWrite5m int64   `json:"cache_write_5m"`
	CacheWrite1h int64   `json:"cache_write_1h"`
	CostUSD      float64 `json:"cost_usd"`
	// CacheSavingsUSD: the daemon's UsageBucket.cache_savings_usd.
	CacheSavingsUSD float64 `json:"cache_savings_usd"`
	Unpriced        bool    `json:"unpriced,omitempty"`
}

// UsageReport is usage.show's --json result.
type UsageReport struct {
	// Thread is the thread id with --thread; empty for every thread.
	Thread string `json:"thread,omitempty"`
	// Threads is how many live threads are summed (1 with --thread); Retired is true
	// when removed threads' usage is included.
	Threads int          `json:"threads"`
	Retired bool         `json:"retired"`
	Models  []UsageModel `json:"models"`
	Total   UsageModel   `json:"total"`
	Buckets []UsageDay   `json:"buckets"`
	// AgentRuns are the thread's subagent runs (with --thread); their usage is already
	// in the totals above.
	AgentRuns []UsageRun `json:"agent_runs,omitempty"`
}

// UsageRun is one subagent run of a thread in a usage report.
type UsageRun struct {
	ID          string  `json:"id"`
	Description string  `json:"description"`
	AgentType   string  `json:"agent_type"`
	Model       string  `json:"model"`
	Background  bool    `json:"background,omitempty"`
	Status      string  `json:"status"` // "open" | "closed"
	SpawnDepth  int32   `json:"spawn_depth"`
	Requests    int64   `json:"requests"`
	Tokens      int64   `json:"tokens"`
	CostUSD     float64 `json:"cost_usd"`
	Unpriced    bool    `json:"unpriced,omitempty"`
}

// usageRuns summarizes a thread's runs.
func usageRuns(runs []*v1.AgentRun) []UsageRun {
	out := make([]UsageRun, 0, len(runs))
	for _, r := range runs {
		t := summarizeUsage(r.GetUsage()).Total
		status := "closed"
		if r.GetStatus() == v1.AgentRunStatus_AGENT_RUN_STATUS_OPEN {
			status = "open"
		}
		out = append(out, UsageRun{ID: r.GetId(), Description: r.GetDescription(), AgentType: r.GetAgentType(), Model: r.GetModel(),
			Background: r.GetBackground(), Status: status, SpawnDepth: r.GetSpawnDepth(), Requests: t.Requests, Tokens: t.Tokens,
			CostUSD: r.GetCostUsd(), Unpriced: r.GetUnpriced()})
	}
	return out
}

// renderRuns is the agent runs table under a thread's usage.
func renderRuns(runs []UsageRun) string {
	if len(runs) == 0 {
		return ""
	}
	var sb strings.Builder
	open := 0
	for _, r := range runs {
		if r.Status == "open" {
			open++
		}
	}
	noun := "runs"
	if len(runs) == 1 {
		noun = "run"
	}
	fmt.Fprintf(&sb, "\n%d agent %s (%d open), included above:\n\n", len(runs), noun, open)
	tw := tabwriter.NewWriter(&sb, 0, 4, 2, ' ', 0)
	_, _ = fmt.Fprintln(tw, "STATUS\tRUN\tTYPE\tMODEL\tREQUESTS\tTOKENS\tCOST")
	for _, r := range runs {
		desc := cmp.Or(r.Description, r.ID)
		if r.Background {
			desc += " (background)"
		}
		cost := formatUSD(r.CostUSD)
		if r.Unpriced {
			cost += " + unpriced"
		}
		_, _ = fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\t%s\n", r.Status, desc, cmp.Or(r.AgentType, "—"), cmp.Or(r.Model, "inherited"),
			groupInt(r.Requests), formatTokens(r.Tokens), cost)
	}
	_ = tw.Flush()
	return sb.String()
}

// summarizeUsage adds buckets up per model (rows by cost, then tokens, then name) and
// in total. Buckets with the same key from different threads are listed separately.
func summarizeUsage(buckets []*v1.UsageBucket) UsageReport {
	rep := UsageReport{Total: UsageModel{Model: "TOTAL"}, Models: []UsageModel{}, Buckets: []UsageDay{}}
	byModel := map[string]*UsageModel{}
	add := func(m *UsageModel, b *v1.UsageBucket) {
		m.Requests += b.GetRequests()
		m.Input += b.GetInput()
		m.Output += b.GetOutput()
		m.CacheRead += b.GetCacheRead()
		m.CacheWrite5m += b.GetCacheWrite_5M()
		m.CacheWrite1h += b.GetCacheWrite_1H()
		m.Tokens += b.GetInput() + b.GetOutput() + b.GetCacheRead() + b.GetCacheWrite_5M() + b.GetCacheWrite_1H()
		m.CostUSD += b.GetCostUsd()
		m.CacheSavingsUSD += b.GetCacheSavingsUsd()
		m.Unpriced = m.Unpriced || b.GetUnpriced()
	}
	for _, b := range buckets {
		m, ok := byModel[b.GetModel()]
		if !ok {
			m = &UsageModel{Model: b.GetModel()}
			byModel[b.GetModel()] = m
		}
		add(m, b)
		add(&rep.Total, b)
		rep.Buckets = append(rep.Buckets, UsageDay{Day: b.GetDay(), Model: b.GetModel(), Tier: b.GetTier(), Speed: b.GetSpeed(),
			Requests: b.GetRequests(), Input: b.GetInput(), Output: b.GetOutput(), CacheRead: b.GetCacheRead(),
			CacheWrite5m: b.GetCacheWrite_5M(), CacheWrite1h: b.GetCacheWrite_1H(), CostUSD: b.GetCostUsd(), CacheSavingsUSD: b.GetCacheSavingsUsd(),
			Unpriced: b.GetUnpriced()})
	}
	for _, m := range byModel {
		if !m.Unpriced && rep.Total.CostUSD > 0 {
			m.Share = m.CostUSD / rep.Total.CostUSD
		}
		rep.Models = append(rep.Models, *m)
	}
	if rep.Total.CostUSD > 0 {
		rep.Total.Share = 1
	}
	slices.SortFunc(rep.Models, func(a, b UsageModel) int {
		return cmp.Or(cmp.Compare(b.CostUSD, a.CostUSD), cmp.Compare(b.Tokens, a.Tokens), strings.Compare(a.Model, b.Model))
	})
	slices.SortStableFunc(rep.Buckets, func(a, b UsageDay) int {
		return cmp.Or(strings.Compare(a.Day, b.Day), strings.Compare(a.Model, b.Model),
			strings.Compare(a.Tier, b.Tier), strings.Compare(a.Speed, b.Speed))
	})
	return rep
}

// formatTokens is a compact count: 812, 41.2K, 12.3M, 1.05B.
func formatTokens(n int64) string {
	f := float64(n)
	switch {
	case n < 1_000:
		return strconv.FormatInt(n, 10)
	case n < 1_000_000:
		return trimZero(strconv.FormatFloat(f/1e3, 'f', 1, 64)) + "K"
	case n < 1_000_000_000:
		return trimZero(strconv.FormatFloat(f/1e6, 'f', 1, 64)) + "M"
	default:
		return trimZero(strconv.FormatFloat(f/1e9, 'f', 2, 64)) + "B"
	}
}

func trimZero(s string) string { return strings.TrimSuffix(s, ".0") }

// formatUSD shows cents, or four decimals under a cent so small threads are not $0.00.
func formatUSD(v float64) string {
	if v > 0 && v < 0.01 {
		return "$" + strconv.FormatFloat(v, 'f', 4, 64)
	}
	return "$" + strconv.FormatFloat(v, 'f', 2, 64)
}

// groupInt formats n with thousands separators.
func groupInt(n int64) string {
	s := strconv.FormatInt(n, 10)
	neg := strings.HasPrefix(s, "-")
	s = strings.TrimPrefix(s, "-")
	var b strings.Builder
	for i, r := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(r)
	}
	if neg {
		return "-" + b.String()
	}
	return b.String()
}

// renderUsage is usage.show's text: a heading, the per-model table with totals, and
// the token buckets in full.
func renderUsage(heading string, rep UsageReport) string {
	var sb strings.Builder
	t := rep.Total
	cost := formatUSD(t.CostUSD)
	if t.Unpriced {
		cost += " + unpriced"
	}
	requests := "requests"
	if t.Requests == 1 {
		requests = "request"
	}
	fmt.Fprintf(&sb, "%s: %s %s · %s tokens · %s\n", heading, groupInt(t.Requests), requests, formatTokens(t.Tokens), cost)
	if len(rep.Models) == 0 {
		sb.WriteString("No usage yet.\n")
		return sb.String()
	}
	sb.WriteString("\n")
	tw := tabwriter.NewWriter(&sb, 0, 4, 2, ' ', 0)
	row := func(m UsageModel) {
		cost, share := formatUSD(m.CostUSD), strconv.FormatFloat(m.Share*100, 'f', 0, 64)+"%"
		if m.Unpriced && m.Model != "TOTAL" {
			cost, share = "—", "—"
		}
		_, _ = fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\n", m.Model, groupInt(m.Requests), formatTokens(m.Tokens), cost, share)
	}
	_, _ = fmt.Fprintln(tw, "MODEL\tREQUESTS\tTOKENS\tCOST\tSHARE")
	for _, m := range rep.Models {
		row(m)
	}
	row(t)
	_ = tw.Flush()
	fmt.Fprintf(&sb, "\nInput %s · Output %s · Cache read %s · Cache write 5m %s · Cache write 1h %s\n",
		groupInt(t.Input), groupInt(t.Output), groupInt(t.CacheRead), groupInt(t.CacheWrite5m), groupInt(t.CacheWrite1h))
	fmt.Fprintf(&sb, "Cache savings %s\n", formatUSD(t.CacheSavingsUSD))
	return sb.String()
}

// RegisterUsage registers usage.show, the CLI's token usage report (`code-foundry
// usage [--thread <id>] [--json]`). The GUI's entry point is view.usage.
func RegisterUsage(r *Registry, b ThreadBackend) error {
	return r.Register(Command{
		Name:     "usage.show",
		ReadOnly: true,
		Title:    "Show Token Usage",
		Description: "Print token usage and its cost at Claude API rates, per model with totals: " +
			"one thread (default inside a thread: that thread), else every thread plus removed ones.",
		Category:     "View",
		NoKeybinding: true,
		Args: []ArgSpec{
			{Name: "thread", Type: String, Context: ContextThread, ID: ThreadID,
				Description: "Thread id (default: the thread this runs in, $CODE_FOUNDRY_THREAD; outside a thread: every thread, plus removed threads)" + IDHelp},
			{Name: "all", Type: Bool, Description: "Every thread plus removed ones, also inside a thread"},
		},
		// CLI only: the palette has view.usage, which opens the Usage page.
		When: func(c Context) bool { return c.ActiveView == "" },
		Run: func(ctx context.Context, _ Context, args Args) (Result, error) {
			if args.Bool("all") && args.Given("thread") {
				return Result{}, InvalidArg("all", "with --thread: pass one or the other")
			}
			if id := args.String("thread"); id != "" && !args.Bool("all") {
				res, err := b.Get(ctx, connect.NewRequest(&v1.GetThreadRequest{Id: id}))
				if err != nil {
					return Result{}, err
				}
				s := res.Msg.GetThread()
				rep := summarizeUsage(s.GetUsage())
				rep.Thread, rep.Threads = s.GetId(), 1
				rep.AgentRuns = usageRuns(s.GetAgentRuns())
				heading := "Thread " + s.GetId()
				if s.GetName() != "" {
					heading += " (" + s.GetName() + ")"
				}
				return Result{Message: strings.TrimRight(renderUsage(heading, rep)+renderRuns(rep.AgentRuns), "\n"), JSON: rep}, nil
			}
			res, err := b.List(ctx, connect.NewRequest(&v1.ListThreadsRequest{}))
			if err != nil {
				return Result{}, err
			}
			var all []*v1.UsageBucket
			for _, s := range res.Msg.GetThreads() {
				all = append(all, s.GetUsage()...)
			}
			retired := res.Msg.GetRetiredUsage()
			all = append(all, retired...)
			rep := summarizeUsage(all)
			rep.Threads, rep.Retired = len(res.Msg.GetThreads()), len(retired) > 0
			heading := fmt.Sprintf("All threads (%d", rep.Threads)
			if rep.Retired {
				heading += " + removed"
			}
			heading += ")"
			return Result{Message: strings.TrimRight(renderUsage(heading, rep), "\n"), JSON: rep}, nil
		},
	})
}
