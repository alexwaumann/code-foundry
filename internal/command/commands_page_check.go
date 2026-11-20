package command

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/shot"
)

// page.check (docs/notes/page-self-check.md): the author of a page learns what happened
// when it really ran. The daemon has no browser, so the app's host renders the page once in
// its hidden shot window, as a card of the thread it acts for would, and the GUI's frame
// reports what it saw (PageService.CheckPage). The CLI writes --shot's PNG itself
// (cmd/code-foundry, cliOutputs), as plugin surface --shot does.

// PageChecker is PageService.CheckPage, in the generated Connect signature.
type PageChecker interface {
	CheckPage(context.Context, *connect.Request[v1.CheckPageRequest]) (*connect.Response[v1.CheckPageResponse], error)
}

var (
	_ PageChecker = codefoundryv1connect.PageServiceHandler(nil)
	_ PageChecker = codefoundryv1connect.PageServiceClient(nil)
)

// PageCheckVerb is the check's verb, which view.inline's and view.open.page's results name
// as the next step.
const PageCheckVerb = "page.check"

// Bounds of page.check's --width and --settle; the daemon's PageService keeps the same
// (internal/api page_check.go).
const (
	pageCheckWidth     = 720
	pageCheckSettle    = "5s"
	pageCheckSettleMax = 10 * time.Second
)

// NextCheckLine is the line view.inline and view.open.page end with: their static checks
// ran, with how many warnings, and the check that runs the page comes next (K in the pages
// trial: a bare "shown" told the author nothing).
func NextCheckLine(path string, warnings int) string {
	w := "no warnings"
	if warnings == 1 {
		w = "1 warning"
	} else if warnings > 1 {
		w = strconv.Itoa(warnings) + " warnings"
	}
	return fmt.Sprintf("static checks: %s; next: code-foundry %s %s to see what it does when it runs", w, PageCheckVerb, path)
}

// RegisterPageCheck registers page.check. A nil backend registers it failing with Unimplemented.
func RegisterPageCheck(r *Registry, b PageChecker) error {
	return r.Register(Command{
		Name:      PageCheckVerb,
		NoPalette: true,
		ReadOnly:  true,
		Title:     "Check Page",
		Description: "Render an HTML page once in the app, off screen and unseen, as its thread's card would show it, and say " +
			"what that render saw: whether it loaded, script, compile and import errors with where, files that did not " +
			"load, cf.run / cf.fetch / cf.storage / cf.on calls the app refused or that failed, what the frame cannot do " +
			"(alert, confirm, downloads), the card's height and how long the page took to settle. Run it after showing a " +
			"page and after each edit, and fix what it reports. Only what the page does as it loads runs: nothing that needs " +
			"a click, no question to the user, and cf.storage writes are not saved. Needs the app open. Exits 1 when it " +
			"found a problem. --shot out.png also writes a PNG of the card (CLI).",
		Category:     pageCategory,
		NoKeybinding: true,
		Args: []ArgSpec{
			{Name: "path", Type: Path, Required: true, Positional: true,
				Description: "The page: an .html or .htm file under the home directory"},
			{Name: "thread", Type: String, Context: ContextThread, ID: ThreadID,
				Description: "The thread the page acts for (default: yours when it owns the page, else its first owner)" + IDHelp},
			withDefault(ArgSpec{Name: "width", Type: Int, Description: fmt.Sprintf("The card's width in CSS pixels (%d to %d)", shot.MinWidth, shot.MaxWidth)}, strconv.Itoa(pageCheckWidth)),
			withDefault(ArgSpec{Name: "settle", Type: String,
				Description: "The most to wait for the page to settle, as a Go duration (at most 10s); it returns as soon as nothing more happens"}, pageCheckSettle),
			{Name: "shot", Type: Path, Description: "CLI: also write a PNG of the card as the app drew it to this file"},
		},
		Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
			if b == nil {
				return Result{}, connect.NewError(connect.CodeUnimplemented, errors.New("this daemon checks no pages"))
			}
			// A page checking a page (itself, most likely) would render it again and again.
			if uctx.Untrusted() {
				return Result{}, connect.NewError(connect.CodePermissionDenied, errors.New("a page cannot check a page: run page.check from the CLI"))
			}
			width := a.Int("width")
			if width < shot.MinWidth || width > shot.MaxWidth {
				return Result{}, InvalidArg("width", "--width %d is out of bounds (%d to %d)", width, shot.MinWidth, shot.MaxWidth)
			}
			settle, err := time.ParseDuration(a.String("settle"))
			if err != nil || settle <= 0 || settle > pageCheckSettleMax {
				return Result{}, InvalidArg("settle", "%q is not a duration up to %v (2s, 500ms)", a.String("settle"), pageCheckSettleMax)
			}
			shotPath := a.Path("shot")
			res, err := b.CheckPage(ctx, connect.NewRequest(&v1.CheckPageRequest{
				Path: a.Path("path"), ThreadId: a.String("thread"), Width: int32(width), SettleMs: int32(settle.Milliseconds()), Png: shotPath != "",
			}))
			if err != nil {
				// No window, a page nobody may run, no answer in time: a state, not a usage
				// mistake (exit 1, its words). A bad path stays the caller's.
				var ce *connect.Error
				if errors.As(err, &ce) && (ce.Code() == connect.CodeFailedPrecondition || ce.Code() == connect.CodeDeadlineExceeded || ce.Code() == connect.CodeUnavailable) {
					return Result{}, Failed(errors.New(ce.Message()))
				}
				return Result{}, err
			}
			out := Result{Message: FormatPageCheck(res.Msg, shotPath), JSON: res.Msg}
			if PageCheckFailed(res.Msg.GetReport()) {
				out.ExitCode = 1
			}
			return out, nil
		},
	})
}

// PageCheckFailed reports whether a check found something to fix: the page did not render
// or load, or a problem.
func PageCheckFailed(r *v1.PageCheckReport) bool {
	return r == nil || r.GetFailure() != "" || !r.GetLoaded() || len(r.GetProblems()) > 0
}

// problemMax bounds one problem's text: a loader error carries a code frame, a stack can
// be long.
const (
	problemMaxLines = 8
	problemMaxChars = 600
)

// FormatPageCheck is page.check's text: a summary line, each problem, then what else the
// author should know. shotPath is where the CLI writes the PNG ("" for none asked).
func FormatPageCheck(res *v1.CheckPageResponse, shotPath string) string {
	r := res.GetReport()
	var b strings.Builder
	path := res.GetPath()
	if r == nil {
		return "checked " + path + ": the app sent no report"
	}
	settle := fmt.Sprintf("%.1f s", float64(r.GetSettleMs())/1000)
	shape := fmt.Sprintf("%d px wide, card %d px tall", res.GetWidth(), r.GetHeight())
	n := 0
	for _, p := range r.GetProblems() {
		n += int(max(p.GetCount(), 1))
	}
	switch {
	case r.GetFailure() != "":
		fmt.Fprintf(&b, "checked %s: not rendered: %s", path, r.GetFailure())
	case !r.GetLoaded():
		fmt.Fprintf(&b, "checked %s: the page did not load in %s", path, settle)
	case n == 0:
		fmt.Fprintf(&b, "checked %s: loaded, no errors (settled in %s; %s)", path, settle, shape)
	default:
		fmt.Fprintf(&b, "checked %s: %s (settled in %s; %s)", path, plural(n, "problem"), settle, shape)
	}
	for _, p := range r.GetProblems() {
		b.WriteString("\n- ")
		b.WriteString(indentMore(clip(problemText(p))))
		if p.GetCount() > 1 {
			fmt.Fprintf(&b, " (%d times)", p.GetCount())
		}
	}
	if r.GetLoader() == "running" {
		b.WriteString("\nthe TSX loader (/cf/jsx.js) had not finished its scripts")
	}
	if !r.GetSettled() && r.GetFailure() == "" {
		fmt.Fprintf(&b, "\nstill busy when the check stopped at %s", settle)
		if r.GetBusy() > 0 {
			fmt.Fprintf(&b, ": %s waiting", plural(int(r.GetBusy()), "call"))
		}
	}
	if ph := r.GetPageHeight(); r.GetLoaded() && ph > r.GetHeight()+1 {
		if r.GetResized() {
			fmt.Fprintf(&b, "\nthe page is %d px tall; the card shows %d px of it and scrolls", ph, r.GetHeight())
		} else {
			fmt.Fprintf(&b, "\nthe page is %d px tall but its card stays %d px: load /cf/bridge.js and the card follows the page", ph, r.GetHeight())
		}
	}
	if w := r.GetStorageWrites(); w > 0 {
		fmt.Fprintf(&b, "\n%s on load (kept in the check, not saved)", plural(int(w), "cf.storage write"))
	}
	if t := res.GetThreadId(); t != "" {
		fmt.Fprintf(&b, "\nacted for thread %s", t)
	}
	switch {
	case shotPath == "":
	case len(res.GetPng()) > 0:
		fmt.Fprintf(&b, "\nscreenshot: %s (%d by %d CSS px)", shotPath, res.GetWidth(), r.GetHeight())
	case r.GetShotError() != "":
		fmt.Fprintf(&b, "\nno screenshot: %s", r.GetShotError())
	default:
		b.WriteString("\nno screenshot: the page was not drawn")
	}
	if r.GetLoaded() {
		b.WriteString("\nonly what the page does as it loads ran: clicks and what they start were not tried")
	}
	return b.String()
}

// problemText is one problem as a line.
func problemText(p *v1.PageCheckProblem) string {
	msg := p.GetMessage()
	at := ""
	if w := p.GetWhere(); w != "" {
		at = " at " + w
	}
	switch p.GetKind() {
	case "script":
		return "error" + at + ": " + msg
	case "rejection":
		return "unhandled rejection" + at + ": " + msg
	case "loader":
		return msg
	case "resource":
		return "did not load: " + p.GetWhere()
	case "bridge":
		return p.GetCall() + ": " + p.GetCode() + ": " + strings.TrimPrefix(msg, p.GetCall()+": ")
	case "unsupported":
		return p.GetCall() + ": " + msg
	}
	return msg + at
}

// clip bounds a problem's text to problemMaxLines lines and problemMaxChars characters.
func clip(s string) string {
	s = strings.TrimSpace(s)
	cut := false
	if lines := strings.Split(s, "\n"); len(lines) > problemMaxLines {
		s, cut = strings.Join(lines[:problemMaxLines], "\n"), true
	}
	if r := []rune(s); len(r) > problemMaxChars {
		s, cut = string(r[:problemMaxChars]), true
	}
	if cut {
		s += " …"
	}
	return s
}

// indentMore indents a problem's later lines under its dash.
func indentMore(s string) string { return strings.ReplaceAll(s, "\n", "\n  ") }
