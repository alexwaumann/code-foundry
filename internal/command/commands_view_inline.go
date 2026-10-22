package command

import (
	"context"
	"fmt"

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
}

// inlineCommand is view.inline.
func (d ViewDeps) inlineCommand() Command {
	return Command{
		Name:  "view.inline",
		Title: "Show HTML Page Inline",
		Description: "Show an HTML page inline in a thread's conversation (from a thread: its own): a sandboxed frame at the " +
			"thread's current place, scripts and network on, rendered from the file each time it shows. A page that links " +
			"/cf/theme.css follows the app's theme; it may post {type: \"cf:resize\", height} to set its height.",
		Category:     "Thread",
		NoKeybinding: true,
		When:         hasThread,
		Args: []ArgSpec{
			{Name: "path", Type: Path, Required: true, Positional: true,
				Description: "The .html or .htm file: absolute, ~/…, or relative to the current directory; under the home directory"},
			{Name: "title", Type: String, Description: "What the page is, shown on its row (default: the file name)"},
			{Name: "panel", Type: Bool, Description: "Also open the file in the thread's side panel (view.panel.file)"},
			{Name: "thread", Type: String, Context: ContextThread, ID: ThreadID,
				Description: "Thread whose conversation it shows in (default: the thread this runs in, $CODE_FOUNDRY_THREAD; in the app: the selected thread)" + IDHelp},
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
	return Result{JSON: out, Message: msg}, nil
}

func nonEmptyStr(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}
