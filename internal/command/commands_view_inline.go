package command

import (
	"cmp"
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
// tab's. --panel also opens the file as a tab beside the thread (view.open.file's tab).

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
	// Panel is the --panel result: view.open.file's result.
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
	WarnPolling = "page polls the app with cf.run on a timer (setInterval or setTimeout): use cf.on(source, fn) for live data " +
		"(thread-list, thread, gh, settings, …) and re-run a read only inside its callback; a timer that only redraws " +
		"(a clock, relative times) or refreshes a cf.fetch is fine"
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

// timerReach is how far pollsCfRun reads a timer's arguments, or a function's head, when
// its brackets do not close.
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

// pageListCheck is a check that says what it found: its warning is a format with one %s,
// filled with the names, when there are any. They print after pageChecks'.
type pageListCheck struct {
	warning string
	names   func(p page) []string
}

// pageListChecks are added by the files that define them (commands_view_inline_classes.go).
var pageListChecks []pageListCheck

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

// pollsCfRun reports whether a page re-runs cf.run on a timer: a setInterval or setTimeout
// whose own callback calls cf.run, inline or through a function the page defines (two
// calls deep). A timer that only redraws (a clock, "5m ago" labels) or refreshes a
// cf.fetch is fine, though the page calls cf.run elsewhere (docs/notes/pages-skill-trial.md).
func pollsCfRun(text string) bool {
	if !strings.Contains(text, "cf.run(") {
		return false
	}
	for _, m := range timerCall.FindAllStringIndex(text, -1) {
		open := m[1] - 1
		end := closeOf(text, open)
		if end < 0 {
			end = min(len(text), m[1]+timerReach)
		}
		args := text[open+1 : end]
		// setInterval(load, 5000): the callback is a function the page names.
		if name := timerCallbackName(args); name != "" {
			args = definitionOf(text, name)
		}
		if callsCfRun(text, args, 2) {
			return true
		}
	}
	return false
}

// timerCallbackName is the callback's name when a timer's first argument is a bare
// identifier (setInterval(load, 5000)), else "".
func timerCallbackName(args string) string {
	args = strings.TrimSpace(args)
	i := 0
	for i < len(args) && isIdentByte(args[i]) {
		i++
	}
	if i == 0 || args[0] >= '0' && args[0] <= '9' {
		return ""
	}
	if rest := strings.TrimSpace(args[i:]); rest == "" || rest[0] == ',' {
		return args[:i]
	}
	return ""
}

// callsCfRun reports whether code calls cf.run, or calls a function text defines that does,
// following such calls depth more levels.
func callsCfRun(text, code string, depth int) bool {
	if strings.Contains(code, "cf.run(") {
		return true
	}
	if depth == 0 {
		return false
	}
	for _, m := range plainCall.FindAllStringSubmatchIndex(code, -1) {
		if m[2] > 0 && code[m[2]-1] == '.' {
			continue // a method (Date.now(), list.map()): not the page's function
		}
		if def := definitionOf(text, code[m[2]:m[3]]); def != "" && callsCfRun(text, def, depth-1) {
			return true
		}
	}
	return false
}

// plainCall is a call by a bare name: load(…), refresh (…).
var plainCall = regexp.MustCompile(`\b([A-Za-z_$][\w$]*)\s*\(`)

// definitionOf returns a function's definition in text, from its name to the end of its
// body (function load() {…}), or of the statement that assigns it (const load = async () =>
// {…}; load = useCallback(() => {…}, [])), or "" when text defines nothing by that name.
func definitionOf(text, name string) string {
	q := regexp.QuoteMeta(name)
	re := regexp.MustCompile(`\bfunction\s*\*?\s*` + q + `\s*\(|(?:^|[^\w$.])` + q + `\s*=[^=>]`)
	loc := re.FindStringIndex(text)
	if loc == nil {
		return ""
	}
	if strings.HasSuffix(text[loc[0]:loc[1]], "(") {
		// function load(…) {…}: the block after the parameters.
		params := closeOf(text, loc[1]-1)
		if params < 0 {
			return ""
		}
		if open := strings.IndexByte(text[params:], '{'); open >= 0 {
			if end := closeOf(text, params+open); end >= 0 {
				return text[loc[0] : end+1]
			}
		}
		return text[loc[0]:min(len(text), params+timerReach)]
	}
	// An assignment: to its first block, or to the statement's end.
	for i := loc[1] - 1; i < len(text); {
		if j := skipJS(text, i); j != i {
			i = j
			continue
		}
		switch text[i] {
		case '(', '[':
			end := closeOf(text, i)
			if end < 0 {
				return text[loc[0]:min(len(text), i+timerReach)]
			}
			i = end + 1
			continue
		case '{':
			if end := closeOf(text, i); end >= 0 {
				return text[loc[0] : end+1]
			}
			return text[loc[0]:min(len(text), i+timerReach)]
		case ';', '<':
			return text[loc[0]:i]
		case '\n':
			if prev := strings.TrimRight(text[loc[0]:i], " \t"); !strings.HasSuffix(prev, "=>") && !strings.HasSuffix(prev, "=") {
				return text[loc[0]:i]
			}
		}
		i++
	}
	return text[loc[0]:]
}

// pageWarnings reads the page shown (through Files, as view.open.file's check does) and
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
	for _, c := range pageListChecks {
		if names := c.names(p); len(names) > 0 {
			out = append(out, fmt.Sprintf(c.warning, strings.Join(names, ", ")))
		}
	}
	return out
}

// inlineCommand is view.inline.
func (d ViewDeps) inlineCommand() Command {
	return Command{
		Name:         "view.inline",
		Page:         PageState,
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
			{Name: "panel", Type: Bool, Description: "Also open it as a tab beside the thread (view.open.page)"},
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
		id = cmp.Or(res.Msg.GetThread().GetId(), id)
		name = cmp.Or(res.Msg.GetThread().GetName(), id)
	}
	res, err := d.Inline.ShowHtml(ctx, connect.NewRequest(&v1.ShowThreadHtmlRequest{ThreadId: id, Path: a.Path("path"), Title: a.String("title"),
		Again: a.Bool("again"), Panel: a.Bool("panel")}))
	if err != nil {
		return Result{}, err
	}
	it := res.Msg.GetItem()
	out := InlineResult{Thread: id, Item: it.GetId(), Path: cmp.Or(it.GetHtml().GetPath(), a.Path("path")), Reused: res.Msg.GetReused()}
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
		pr, err := d.showItem(ctx, uctx, a, id, tabFile, d.fileCheck)
		if err != nil {
			return Result{}, fmt.Errorf("shown inline, but not in a tab: %w", err)
		}
		if p, ok := pr.JSON.(PanelResult); ok {
			out.Panel = &p
			if out.Reused {
				msg = fmt.Sprintf("opened %s in tab %s beside thread %s; it was shown inline before, so no card was added", out.Path, p.Tab, name)
			} else {
				msg += fmt.Sprintf(" and in tab %s beside it", p.Tab)
			}
			if p.Windows == 0 {
				msg += "; no app window is open"
			}
		}
	}
	return Result{JSON: out, Message: msg, Warnings: out.Warnings}, nil
}
