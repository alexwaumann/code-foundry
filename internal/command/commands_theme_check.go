package command

import (
	"context"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/alexwaumann/code-foundry/internal/theme"
)

// The contrast report on a user theme (docs/notes/theme-followups.md). The daemon derives
// no colour, so the GUI resolves each user theme when its file changes and publishes the
// pairs that fall short and the stale pins (UiService.PublishThemeReport, theme.Reports),
// keyed by the file's version. theme save waits briefly for the report on the file it
// wrote and prints it; theme check prints the latest, so a thread can read it after an
// edit.

// ThemeReports is the GUI's contrast reports on the user's themes. *theme.Reports
// implements it.
type ThemeReports interface {
	Get(id string) (theme.Report, bool)
	Wait(ctx context.Context, id, version string) (theme.Report, bool)
}

var _ ThemeReports = (*theme.Reports)(nil)

// DefaultThemeReportWait is how long theme save and theme check wait for the app's report
// on a file it has not reported on yet: the GUI hears of the write on its events stream,
// resolves the theme and publishes after a 150 ms debounce, well inside it.
const DefaultThemeReportWait = 1500 * time.Millisecond

// themeReportInline is how many failing pairs theme save lists on its contrast line.
const themeReportInline = 6

// ThemeCheck is theme.check's JSON result, and theme save's contrast.
type ThemeCheck struct {
	ID string `json:"id"`
	// Version is the file's (theme.File.Version) the report is on.
	Version string `json:"version"`
	// Checked is false when the app has not reported on this version; Reason says why.
	Checked bool                  `json:"checked"`
	Reason  string                `json:"reason,omitempty"`
	Issues  []theme.ContrastIssue `json:"issues,omitempty"`
	Stale   []theme.StalePin      `json:"stale,omitempty"`
}

// Why a file was not checked.
const (
	themeNotOpen    = "the app is not open"
	themeNotYet     = "the app has not reported on this version yet"
	themeNoReports  = "this daemon keeps no contrast reports"
	themeFromTheApp = "saved from the app, whose editor shows it"
)

// themeCheck is the app's report on f as written: at once when it is there; else, when an
// app window is connected and wait is set, the report as it arrives, up to d's wait.
func themeCheck(ctx context.Context, d ThemeDeps, f theme.File, wait bool) ThemeCheck {
	out := ThemeCheck{ID: f.ID, Version: f.Version()}
	if d.Reports == nil {
		out.Reason = themeNoReports
		return out
	}
	rep, ok := d.Reports.Get(f.ID)
	if !(ok && rep.Version == out.Version) {
		windows := 0
		if d.Emitter != nil {
			windows = d.Emitter.Windows()
		}
		switch {
		case !wait:
			out.Reason = themeFromTheApp
			return out
		case windows == 0:
			out.Reason = themeNotOpen
			return out
		}
		w := d.ReportWait
		if w <= 0 {
			w = DefaultThemeReportWait
		}
		wctx, cancel := context.WithTimeout(ctx, w)
		defer cancel()
		if rep, ok = d.Reports.Wait(wctx, f.ID, out.Version); !ok {
			out.Reason = themeNotYet
			return out
		}
	}
	out.Checked, out.Issues, out.Stale = true, rep.Issues, rep.Stale
	return out
}

// lines is the report in words. full lists every failing pair on a line of its own
// (theme check); otherwise the first few go on the contrast line (theme save).
func (c ThemeCheck) lines(full bool) []string {
	if !c.Checked {
		switch c.Reason {
		case themeNotYet:
			return []string{fmt.Sprintf("contrast: not checked yet (%s; theme check %s in a moment)", c.Reason, c.ID)}
		case themeFromTheApp:
			return []string{"contrast: shown in the Themes page's editor"}
		}
		return []string{fmt.Sprintf("contrast: not checked (%s)", c.Reason)}
	}
	var out []string
	switch n := len(c.Issues); {
	case n == 0:
		out = append(out, "contrast: ok")
	case full:
		out = append(out, fmt.Sprintf("contrast: %s", plural(n, "issue")))
		for _, is := range c.Issues {
			out = append(out, "  "+issueText(is))
		}
	default:
		parts := make([]string, 0, themeReportInline+1)
		for _, is := range c.Issues[:min(n, themeReportInline)] {
			parts = append(parts, issueText(is))
		}
		if n > themeReportInline {
			parts = append(parts, fmt.Sprintf("and %d more (theme check %s lists every one)", n-themeReportInline, c.ID))
		}
		out = append(out, fmt.Sprintf("contrast: %s — %s", plural(n, "issue"), strings.Join(parts, ", ")))
	}
	if len(c.Stale) == 0 {
		return append(out, "stale pins: 0")
	}
	parts := make([]string, len(c.Stale))
	for i, p := range c.Stale {
		parts[i] = fmt.Sprintf("%s (pinned %s when its rule gave %s; it gives %s now)", slotText(p.Slot), p.Pinned, p.Basis, p.Derived)
	}
	return append(out, fmt.Sprintf("stale pins: %d — %s", len(c.Stale), strings.Join(parts, ", ")))
}

// issueText is "warning-text on warning-surface over surface 3.9:1 (needs 4.5)".
func issueText(is theme.ContrastIssue) string {
	label := is.Label
	if label == "" {
		label = is.Slot + " on " + is.Against
	}
	return fmt.Sprintf("%s %s (needs %s)", slotText(label), ratioText(is.Ratio), strconv.FormatFloat(is.Required, 'g', -1, 64))
}

// slotText drops the --cf- prefix, as the editor's rows do.
func slotText(s string) string { return strings.ReplaceAll(s, "--cf-", "") }

// ratioText is the editor's (components/themes/editor/model.ts): rounded down, two
// decimals under 2:1, so a 4.48 never reads as 4.5.
func ratioText(r float64) string {
	if r < 2 {
		return fmt.Sprintf("%.2f:1", math.Floor(r*100)/100)
	}
	return fmt.Sprintf("%.1f:1", math.Floor(r*10)/10)
}

// themeCheckCommand is theme.check: the latest report on one of the user's themes.
func themeCheckCommand(d ThemeDeps, userIDs func() []string, needThemes func() error) Command {
	return Command{
		Name:     "theme.check",
		ReadOnly: true,
		Title:    "Check Theme Contrast",
		Description: "Print the app's contrast check of one of your themes: each pair of colours that falls short (the ratio it has and needs) " +
			"and each pin whose rule the base has moved. The app checks a theme when its file changes; with the app closed nothing is checked.",
		Category:     "Settings",
		NoKeybinding: true,
		Args: []ArgSpec{{Name: "theme", Type: Enum, EnumFunc: userIDs, Required: true, Positional: true,
			Description: "One of your themes' ids (theme list marks them)"}},
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			if err := needThemes(); err != nil {
				return Result{}, err
			}
			f, ok := d.Themes.Snapshot().Get(a.String("theme"))
			if !ok {
				return Result{}, InvalidArg("theme", "%q is not one of your themes", a.String("theme"))
			}
			c := themeCheck(ctx, d, f, true)
			lines := append([]string{fmt.Sprintf("%s (%s), a %s theme", f.Name, f.ID, f.Scheme)}, c.lines(true)...)
			return Result{Message: strings.Join(lines, "\n"), JSON: c}, nil
		},
	}
}
