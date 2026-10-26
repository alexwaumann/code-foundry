package command

import (
	"context"
	"fmt"
	"regexp"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bridge"
	"github.com/alexwaumann/code-foundry/internal/pagelib"
	"github.com/alexwaumann/code-foundry/internal/theme"
)

// view.inline: an HTML page shown inline in a thread's conversation
// (docs/notes/inline-html.md). The daemon appends an html item at the thread's current
// position (ThreadService.ShowHtml); the GUI renders it as a sandboxed frame, the File
// tab's. --panel also opens the file in the thread's side panel (view.panel.file).

// HTMLShower appends an html item to a thread (ThreadService.ShowHtml).
type HTMLShower interface {
	ShowHtml(context.Context, *connect.Request[v1.ShowThreadHtmlRequest]) (*connect.Response[v1.ShowThreadHtmlResponse], error)
}

var _ HTMLShower = codefoundryv1connect.ThreadServiceHandler(nil)

// InlineResult is view.inline's JSON result.
type InlineResult struct {
	Thread string `json:"thread"`
	// Item is the html item's id; Path the path it holds (relative to the thread's cwd
	// when inside it, else absolute).
	Item string `json:"item"`
	Path string `json:"path"`
	// Panel is the --panel result: the File tab's ShowView (view.panel.file's result).
	Panel *PanelResult `json:"panel,omitempty"`
	// Reused is set when the page's card was still live (shown since the thread's last
	// user message, or ever with --panel), so no card was added: Item is that card.
	Reused bool `json:"reused,omitempty"`
	// Warnings say what the page misses to look and fit right (pageWarnings); the CLI
	// prints them as warning lines too.
	Warnings []string `json:"warnings,omitempty"`
}

// Page warnings (docs/notes/inline-html-2-fixes.md): what a page the model wrote misses,
// told back to the model at once so it fixes the page in the same turn.
const (
	// WarnNoThemeCSS is for an app page only (appPage): a mockup of another product paints
	// itself (docs/notes/page-library.md).
	WarnNoThemeCSS = "page does not link /cf/theme.css, so it will not follow the user's theme; add " +
		`<link rel="stylesheet" href="/cf/theme.css"> and use --cf-* variables (--cf-surface, --cf-text, ` +
		"--cf-text-muted, --cf-accent, --cf-border, …), not fixed colours or prefers-color-scheme"
	// WarnNoResize points at the bridge, not a hand-posted cf:resize: models that read the
	// old wording wrote the pre-bridge workaround (docs/notes/page-library-fixes-b.md).
	WarnNoResize = "page does not load /cf/bridge.js, so its card keeps the default height; add " +
		`<script src="/cf/bridge.js"></script>` + " (it sizes the card); the code-foundry-pages skill says how pages are made"
	// WarnNoBridge: the page calls window.cf without the script that defines it
	// (docs/notes/bridge-3-skill.md). It replaces WarnNoResize: the script sizes the card.
	WarnNoBridge = "page uses cf.* but does not load /cf/bridge.js, so window.cf is undefined; add " +
		`<script src="/cf/bridge.js"></script> before your own scripts`
	// The bridge's misuses a test round found (docs/notes/bridge-fix-c-daemon.md).
	WarnPolling = "page runs cf.run on a timer (setInterval or setTimeout): use cf.on(source, fn) for live data " +
		"(thread-list, thread, gh, settings, …) and re-run a read only inside its callback"
	WarnConfirm = "page calls confirm(): the app asks the user in its own dialog before a verb that needs it " +
		"(merging a PR, archiving a busy thread); remove it"
	WarnReservedArg = "page passes yes or force to cf.run: leave them out; the app's dialog asks the user when a " +
		"verb needs it (yes is refused)"
	// The page library's (docs/notes/page-library.md).
	WarnNoJSXLoader = "page has text/tsx, text/jsx or text/babel scripts, or imports react, @cf/ui or @cf/icons, " +
		"but does not load /cf/jsx.js, so none of it runs; add " + `<script src="/cf/jsx.js"></script>` + " in <head>, " +
		"before any module script, and put the code in <script type=\"text/tsx\">"
	WarnNoUICSS = "page imports @cf/ui but does not link /cf/ui.css, so the components are unstyled; add " +
		`<link rel="stylesheet" href="/cf/ui.css">` + " after /cf/theme.css"
	WarnCDN = "page loads React, Babel or Tailwind from the internet: use the app's own, /cf/jsx.js (React, @cf/ui, " +
		"@cf/icons, TSX) and /cf/tailwind.js, which work offline and match the app"
	// WarnShownBefore takes the earlier card's item id.
	WarnShownBefore = "this page was already shown in this thread (%s), and that card reloaded with your edit: " +
		"this second card runs the page again; after an edit, do not run view.inline for the same file"
)

var (
	// bridgeCall is how a page uses the bridge's window.cf.
	bridgeCall = regexp.MustCompile(`\bcf\.(run|on|ready|storage|thread)\b`)
	// confirmCall is window.confirm, called bare or through window.
	confirmCall = regexp.MustCompile(`(?:^|[^\w.$]|window\.)confirm\s*\(`)
	// reservedArg is yes or force as a key of a cf.run args object.
	reservedArg = regexp.MustCompile(`cf\.run\(\s*[^,)]+,\s*\{(?:[^}]*?[,\s])?(?:"(?:yes|force)"|'(?:yes|force)'|yes|force)\s*:`)
	// timerCall is the start of a setInterval or setTimeout call.
	timerCall = regexp.MustCompile(`\bset(Interval|Timeout)\s*\(`)
	// jsxScript is a script the TSX loader runs; libImport an import of what its map names.
	jsxScript = regexp.MustCompile(`(?i)<script[^>]*\btype\s*=\s*["']?text/(tsx|jsx|babel)\b`)
	libImport = regexp.MustCompile(`\bfrom\s*["'](react|react-dom|react-dom/client|@cf/ui|@cf/icons)["']`)
	// uiImport is an import of @cf/ui (or its file); cdnLib a CDN's React, Babel or Tailwind.
	uiImport = regexp.MustCompile(`["'](@cf/ui|/cf/ui\.js)["']`)
	cdnLib   = regexp.MustCompile(`(?i)src\s*=\s*["']https?://[^"']*(react|babel|tailwind)`)
)

// pageReadMax is how much of a page pageWarnings reads.
const pageReadMax = 256 << 10

// timerReach is how far after a setTimeout pageWarnings looks for a cf.run in its
// callback.
const timerReach = 400

// page is what pageWarnings knows of a page: its text, whether it loads /cf/bridge.js,
// and whether it is an app page, one that uses Code Foundry (cf.*), its components or its
// theme's variables, rather than a mockup of another product with its own styles.
type page struct {
	text      string
	hasBridge bool
	app       bool
}

// pageCheck is one thing a page may miss or get wrong: warn, when it says so.
type pageCheck struct {
	warning string
	warn    func(p page) bool
}

// pageChecks are pageWarnings' checks, in the order the warnings print. Plain text
// tests: a page that names them only in a comment passes, or warns, which is fine for a
// hint.
var pageChecks = []pageCheck{
	{WarnNoThemeCSS, func(p page) bool { return p.app && !strings.Contains(p.text, theme.FrameCSSPath) }},
	// The bridge posts cf:resize itself; a page that uses cf.* without it gets
	// WarnNoBridge instead, which fixes both (hand-written resize code is what the
	// bridge replaced).
	{WarnNoResize, func(p page) bool {
		return !p.hasBridge && !strings.Contains(p.text, "cf:resize") && !bridgeCall.MatchString(p.text)
	}},
	{WarnNoBridge, func(p page) bool { return !p.hasBridge && bridgeCall.MatchString(p.text) }},
	{WarnNoJSXLoader, func(p page) bool {
		// A page with an import map of its own may import the libraries from plain modules.
		return !strings.Contains(p.text, pagelib.JSXPath) &&
			(jsxScript.MatchString(p.text) || libImport.MatchString(p.text) && !strings.Contains(p.text, `type="importmap"`))
	}},
	{WarnNoUICSS, func(p page) bool { return uiImport.MatchString(p.text) && !strings.Contains(p.text, pagelib.UICSSPath) }},
	{WarnCDN, func(p page) bool { return cdnLib.MatchString(p.text) }},
	{WarnPolling, func(p page) bool { return pollsCfRun(p.text) }},
	{WarnConfirm, func(p page) bool { return confirmCall.MatchString(p.text) }},
	{WarnReservedArg, func(p page) bool { return reservedArg.MatchString(p.text) }},
}

// appPage reports whether a page uses Code Foundry's look or calls: cf.*, @cf/ui or its
// stylesheet, or the theme's --cf-* variables. A page that loads the bridge only so its
// card follows its height is not one by that alone.
func appPage(text string) bool {
	return bridgeCall.MatchString(text) || uiImport.MatchString(text) || strings.Contains(text, pagelib.UICSSPath) ||
		strings.Contains(text, "var(--cf-")
}

// pollsCfRun reports whether a page re-runs cf.run on a timer: any setInterval in a page
// that calls cf.run, or a setTimeout whose callback (the next timerReach bytes) does.
func pollsCfRun(text string) bool {
	if !strings.Contains(text, "cf.run(") {
		return false
	}
	for _, m := range timerCall.FindAllStringSubmatchIndex(text, -1) {
		if text[m[2]:m[3]] == "Interval" {
			return true
		}
		if end := min(len(text), m[1]+timerReach); strings.Contains(text[m[1]:end], "cf.run(") {
			return true
		}
	}
	return false
}

// pageWarnings reads the page shown (through Files, as view.panel.file's check does) and
// says what it misses or gets wrong (pageChecks). Nothing when the page cannot be read
// (it was shown; the GUI says what is wrong).
func (d ViewDeps) pageWarnings(ctx context.Context, base, path string) []string {
	if d.Files == nil {
		return nil
	}
	res, err := d.Files.ReadFile(ctx, connect.NewRequest(&v1.ReadFileRequest{BaseDir: base, Path: path, MaxBytes: pageReadMax}))
	if err != nil || res.Msg.GetNotFound() || res.Msg.GetIsDir() {
		return nil
	}
	text := string(res.Msg.GetContents())
	p := page{text: text, hasBridge: strings.Contains(text, bridge.Path), app: appPage(text)}
	var out []string
	for _, c := range pageChecks {
		if c.warn(p) {
			out = append(out, c.warning)
		}
	}
	return out
}

// inlineCommand is view.inline.
func (d ViewDeps) inlineCommand() Command {
	return Command{
		Name:         "view.inline",
		NoPalette:    true,
		Title:        "Show HTML Page Inline",
		Description:  "Show an HTML page inline in a thread's conversation; with /cf/bridge.js it can call Code Foundry.",
		Category:     "Thread",
		NoKeybinding: true,
		// The CLI outside a thread too, so it reaches runInline's "needs a thread" (and
		// works there with --thread) rather than "not available in this context".
		When: hasThreadOrCLI,
		Args: []ArgSpec{
			{Name: "path", Type: Path, Required: true, Positional: true,
				Description: "The .html or .htm file, under the home directory"},
			{Name: "title", Type: String, Description: "Shown on its row"},
			{Name: "panel", Type: Bool, Description: "Also open it in the thread's side panel"},
			{Name: "again", Type: Bool, Description: "A second card though one is live (if the user asked)"},
			{Name: "thread", Type: String, Context: ContextThread, ID: ThreadID,
				Description: "Thread to show it in (default: yours)"},
		},
		Run: d.runInline,
	}
}

func (d ViewDeps) runInline(ctx context.Context, uctx Context, a Args) (Result, error) {
	id := a.String("thread")
	if id == "" {
		return Result{}, InvalidArg("thread", "needs a thread to show it in (--thread, or run it inside a thread)")
	}
	name := id
	if d.Thread != nil {
		res, err := d.Thread.Get(ctx, connect.NewRequest(&v1.GetThreadRequest{Id: id}))
		if err != nil {
			return Result{}, err
		}
		id = nonEmptyStr(res.Msg.GetThread().GetId(), id)
		name = nonEmptyStr(res.Msg.GetThread().GetName(), id)
	}
	res, err := d.Inline.ShowHtml(ctx, connect.NewRequest(&v1.ShowThreadHtmlRequest{ThreadId: id, Path: a.Path("path"), Title: a.String("title"),
		Again: a.Bool("again"), Panel: a.Bool("panel")}))
	if err != nil {
		return Result{}, err
	}
	it := res.Msg.GetItem()
	out := InlineResult{Thread: id, Item: it.GetId(), Path: nonEmptyStr(it.GetHtml().GetPath(), a.Path("path")), Reused: res.Msg.GetReused()}
	out.Warnings = d.pageWarnings(ctx, it.GetHtml().GetBaseDir(), a.Path("path"))
	if e := res.Msg.GetEarlierItemId(); e != "" && !a.Bool("again") {
		// Shown in an earlier turn: that card reloaded with the edit too, and both run the
		// page now (docs/notes/bridge-fix-c-daemon.md).
		out.Warnings = append(out.Warnings, fmt.Sprintf(WarnShownBefore, e))
	}
	msg := fmt.Sprintf("shown %s in thread %s", out.Path, name)
	if out.Reused {
		// The edit already reloaded that card (docs/notes/bridge-fix-c-daemon.md).
		msg = fmt.Sprintf("updated the page already shown in thread %s (%s): its card reloads after every edit, so the user sees "+
			"the change there and no card was added; run view.inline only for a new file", name, out.Path)
	}
	if a.Bool("panel") {
		pr, err := showScoped(ctx, d.Thread, d.Emitter, uctx, a, id, ViewPanelFile, d.fileCheck)
		if err != nil {
			return Result{}, fmt.Errorf("shown inline, but not in the side panel: %w", err)
		}
		if p, ok := pr.JSON.(PanelResult); ok {
			out.Panel = &p
			switch {
			case out.Reused && p.Windows == 0:
				msg = fmt.Sprintf("%s is already shown inline in thread %s, so no card was added; not opened in its side panel (%s)",
					out.Path, name, NoWindowMessage)
			case out.Reused:
				msg = fmt.Sprintf("opened %s in thread %s's side panel; it was shown inline before, so no card was added", out.Path, name)
			case p.Windows == 0:
				msg += " (" + NoWindowMessage + ")"
			default:
				msg += " and in its side panel"
			}
		}
	}
	return Result{JSON: out, Message: msg, Warnings: out.Warnings}, nil
}

func nonEmptyStr(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}
