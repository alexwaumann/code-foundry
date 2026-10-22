package command

import (
	"context"
	"fmt"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
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
	// Warnings say what the page misses to look and fit right (pageWarnings); the CLI
	// prints them as warning lines too.
	Warnings []string `json:"warnings,omitempty"`
}

// Page warnings (docs/notes/inline-html-2-fixes.md): what a page the model wrote misses,
// told back to the model at once so it fixes the page in the same turn.
const (
	WarnNoThemeCSS = "page does not link /cf/theme.css, so it will not follow the user's theme; add " +
		`<link rel="stylesheet" href="/cf/theme.css"> and use --cf-* variables (--cf-surface, --cf-text, ` +
		"--cf-text-muted, --cf-accent, --cf-border, …), not fixed colours or prefers-color-scheme"
	WarnNoResize = "page does not post cf:resize, so its card keeps the default height; on load, post " +
		`{type: "cf:resize", height: document.body.scrollHeight} to parent`
)

// pageReadMax is how much of a page pageWarnings reads.
const pageReadMax = 256 << 10

// pageWarnings reads the page shown (through Files, as view.panel.file's check does) and
// says what it misses: the theme stylesheet, the resize message. A plain substring test:
// a page that names them only in a comment passes, which is fine for a hint. Nothing when
// the page cannot be read (it was shown; the GUI says what is wrong).
func (d ViewDeps) pageWarnings(ctx context.Context, base, path string) []string {
	if d.Files == nil {
		return nil
	}
	res, err := d.Files.ReadFile(ctx, connect.NewRequest(&v1.ReadFileRequest{BaseDir: base, Path: path, MaxBytes: pageReadMax}))
	if err != nil || res.Msg.GetNotFound() || res.Msg.GetIsDir() {
		return nil
	}
	text := string(res.Msg.GetContents())
	var out []string
	if !strings.Contains(text, "/cf/theme.css") {
		out = append(out, WarnNoThemeCSS)
	}
	if !strings.Contains(text, "cf:resize") {
		out = append(out, WarnNoResize)
	}
	return out
}

// inlineCommand is view.inline.
func (d ViewDeps) inlineCommand() Command {
	return Command{
		Name:         "view.inline",
		Title:        "Show HTML Page Inline",
		Description:  "Show an HTML page inline in a thread's conversation.",
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
	res, err := d.Inline.ShowHtml(ctx, connect.NewRequest(&v1.ShowThreadHtmlRequest{ThreadId: id, Path: a.Path("path"), Title: a.String("title")}))
	if err != nil {
		return Result{}, err
	}
	it := res.Msg.GetItem()
	out := InlineResult{Thread: id, Item: it.GetId(), Path: nonEmptyStr(it.GetHtml().GetPath(), a.Path("path"))}
	out.Warnings = d.pageWarnings(ctx, it.GetHtml().GetBaseDir(), a.Path("path"))
	msg := fmt.Sprintf("shown %s in thread %s", out.Path, name)
	if a.Bool("panel") {
		pr, err := showScoped(ctx, d.Thread, d.Emitter, uctx, a, id, ViewPanelFile, d.fileCheck)
		if err != nil {
			return Result{}, fmt.Errorf("shown inline, but not in the side panel: %w", err)
		}
		if p, ok := pr.JSON.(PanelResult); ok {
			out.Panel = &p
			if p.Windows == 0 {
				msg += " (" + NoWindowMessage + ")"
			} else {
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
