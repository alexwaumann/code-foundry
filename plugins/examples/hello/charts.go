package main

import (
	"fmt"
	"slices"

	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

// The Overview tab's figures: a stats row over a bar chart of the last 30 builds' times.
// The Failing card is a toggle that narrows the chart to the failed builds; a bar's click
// toasts the build it is (docs/notes/plugin-stats-bars.md).

// demoBuild is one of the chart's builds.
type demoBuild struct {
	n      int
	secs   int
	status ui.Status
	branch string
	ago    string
}

// demoBuilds are builds #1259..#1288, oldest first: 4 failed, 1 aborted, the last running.
func demoBuilds() []demoBuild {
	out := make([]demoBuild, 30)
	for i := range out {
		b := demoBuild{n: 1259 + i, secs: 229 + (i*37)%41, status: ui.StatusOK, branch: "main"}
		switch i {
		case 5, 14, 21, 26:
			b.status, b.secs = ui.StatusFailed, 330+(i*13)%31
		case 11:
			b.status, b.secs = ui.StatusOff, 48
		case 29:
			b.status, b.secs = ui.StatusRunning, 130
		}
		if i%7 == 3 {
			b.branch = "cf/sidebar"
		}
		hours := 29 - i
		b.ago = fmt.Sprintf("%dh ago", hours)
		if hours == 0 {
			b.ago = "now"
		}
		out[i] = b
	}
	return out
}

// clock formats seconds as "4m 12s".
func clock(secs int) string { return fmt.Sprintf("%dm %02ds", secs/60, secs%60) }

// percentile is the p-th percentile (0..1) of the finished builds' times.
func percentile(bs []demoBuild, p float64) int {
	var secs []int
	for _, b := range bs {
		if b.status == ui.StatusOK || b.status == ui.StatusFailed {
			secs = append(secs, b.secs)
		}
	}
	if len(secs) == 0 {
		return 0
	}
	slices.Sort(secs)
	return secs[int(p*float64(len(secs)-1)+0.5)]
}

// chartNodes are the stats row and the build-time chart; failedOnly is the Failing card's
// toggle.
func chartNodes(failedOnly bool) []ui.Node {
	builds := demoBuilds()
	passed, failed := 0, 0
	for _, b := range builds {
		switch b.status {
		case ui.StatusOK:
			passed++
		case ui.StatusFailed:
			failed++
		}
	}
	median := percentile(builds, 0.5)
	failing := ui.NewStat("stat-failing", "Failing", fmt.Sprint(failed)).WithTone(ui.ToneError).
		WithSubtitle(ui.Plain("integration · e2e")).WithAction(ui.EventAction("stat-filter", "failed"))
	if failedOnly {
		failing = failing.AsPressed()
	}
	stats := ui.NewStats("build-stats",
		ui.NewStat("stat-pass", "Pass rate", fmt.Sprintf("%d%%", (100*passed+(passed+failed)/2)/(passed+failed))).WithTone(ui.ToneOK).
			WithSubtitle(ui.Plain("last 30 builds")),
		ui.NewStat("stat-median", "Median time", clock(median)).WithSubtitle(ui.Plain("p90 "+clock(percentile(builds, 0.9)))),
		failing,
		ui.NewStat("stat-queue", "Queue", "1").WithSubtitle(ui.Plain("waiting for a runner")),
	)
	shown, sub := builds, "last 30 builds"
	if failedOnly {
		shown, sub = slices.DeleteFunc(slices.Clone(builds), func(b demoBuild) bool { return b.status != ui.StatusFailed }), "failed builds"
	}
	bars := make([]ui.Bar, len(shown))
	for i, b := range shown {
		title := fmt.Sprintf("#%d · %s", b.n, clock(b.secs))
		switch b.status {
		case ui.StatusOff:
			title = fmt.Sprintf("#%d · aborted", b.n)
		case ui.StatusRunning:
			title = fmt.Sprintf("#%d · running %s", b.n, clock(b.secs))
		}
		bars[i] = ui.NewBar(fmt.Sprintf("build-%d", b.n), title, float64(b.secs)).WithStatus(b.status).
			WithMeta(ui.Plain(b.branch + " · " + b.ago)).WithAction(ui.EventAction("open-build", fmt.Sprint(b.n)))
	}
	chart := ui.NewBars("build-times", "Build time", bars...)
	chart.Bars.Subtitle = ui.Plain(sub)
	chart.Bars.Reference = &ui.BarsReference{Value: float64(median), Label: "median " + clock(median)}
	if len(shown) > 0 {
		chart.Bars.StartLabel, chart.Bars.EndLabel = fmt.Sprintf("#%d", shown[0].n), fmt.Sprintf("#%d", shown[len(shown)-1].n)
	}
	return []ui.Node{stats, chart}
}
