package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

// The demo surface shows every v1 node kind across six tabs (Overview, Form, Log,
// Assistant and Shell with the plugin's own thread and terminal, owned.go, and Layout
// with columns and panes, layout.go):
// what the GUI's renderer and the mock daemon's fixtures are built against
// (internal/store/plugin/testdata/hello-demo/). The pinned surface appears only on the
// threads the demo's Pin button marked (a context fact, hello.pinned). The checks
// surface appears on a thread whose pull request has GitHub Actions checks and lists
// them through the host's pr.checks command.

// demo is one open instance of the demo surface.
type demo struct {
	h    *pluginsdk.Host
	open pluginsdk.SurfaceOpen
	ctx  context.Context
	stop context.CancelFunc
	own  *owned // the plugin's thread and terminal, shared by every instance

	mu      sync.Mutex
	tab     string
	clicks  int
	saved   map[string]any
	pinned  bool
	visible bool
	running bool // the log tab's simulated build
	started time.Time
	build   int
	ownErr  error // why the Assistant or Shell tab has nothing to show
}

// demoFactory opens demo instances sharing own.
func demoFactory(own *owned) pluginsdk.SurfaceFactory {
	return func(_ context.Context, h *pluginsdk.Host, open pluginsdk.SurfaceOpen) (pluginsdk.Surface, error) {
		ctx, stop := context.WithCancel(context.Background())
		d := &demo{h: h, open: open, ctx: ctx, stop: stop, own: own, tab: "overview", started: time.Now()}
		h.Log().Debug("demo opened", "instance", open.Instance, "thread", open.Context.ThreadID)
		return d, d.render()
	}
}

// prepare makes what tab shows (the assistant thread, the clock terminal) before it
// renders; outside d.mu, since it calls the host.
func (d *demo) prepare(ctx context.Context, tab string) {
	var err error
	switch tab {
	case "assistant", "layout":
		_, err = d.own.assistant(ctx, d.h)
	case "shell":
		_, err = d.own.shell(ctx, d.h)
	default:
		return
	}
	if err != nil {
		d.h.Log().Warn("demo tab", "tab", tab, "err", err.Error())
	}
	d.mu.Lock()
	d.ownErr = err
	d.mu.Unlock()
}

// render sends the current tab's view.
func (d *demo) render() error {
	d.mu.Lock()
	v := d.viewLocked()
	d.mu.Unlock()
	return d.h.UpdateView(d.open.Instance, v)
}

func (d *demo) viewLocked() ui.View {
	thread := d.open.Context.ThreadID
	pin := "Pin to this thread"
	if d.pinned {
		pin = "Unpin"
	}
	header := &ui.Header{
		Icon: "sparkles", Title: "Hello demo", TabTitle: "Hello",
		Pill:     ui.NewPill("demo", ui.ToneOK),
		Subline:  ui.Spans(ui.T("opened "), ui.At(d.started, ui.TimeRelative), ui.T(" · thread "), ui.T(thread).AsMono()),
		Trailing: ui.Spans(ui.T(fmt.Sprintf("%d clicks", d.clicks)).WithTone(ui.ToneMuted)),
		Actions: []ui.Button{
			ui.EventButton("hdr-refresh", "Refresh", "refresh").WithIcon("refresh-cw").AsIconOnly(),
			ui.URLButton("hdr-docs", "Open the plugin docs", "https://github.com/alexwaumann/code-foundry").WithIcon("external-link").AsIconOnly(),
		},
	}
	tabs := ui.NewTabs(d.tab, ui.NewTab("overview", "Overview"), ui.NewTab("form", "Form"), ui.NewTab("log", "Log"),
		ui.NewTab("assistant", "Assistant"), ui.NewTab("shell", "Shell"), ui.NewTab("layout", "Layout"))
	tabs.Items[2].Badge = ui.NewPill("live", ui.ToneAttention)
	if !d.running {
		tabs.Items[2].Badge = nil
	}
	var nodes []ui.Node
	switch d.tab {
	case "form":
		nodes = d.formNodes()
	case "log":
		nodes = d.logNodes()
	case "assistant":
		id, _ := d.own.ids()
		nodes = assistantNodes(id, d.ownErr)
	case "shell":
		_, id := d.own.ids()
		nodes = shellNodes(id, d.ownErr)
	case "layout":
		id, _ := d.own.ids()
		nodes = layoutNodes(id, d.ownErr)
	default:
		nodes = d.overviewNodes(pin)
	}
	return ui.View{Header: header, Tabs: tabs, Nodes: nodes}
}

func (d *demo) overviewNodes(pin string) []ui.Node {
	now := time.Now()
	text := ui.NewText("intro", ui.Spans(
		ui.T("Every "), ui.T("v1").AsStrong(), ui.T(" node kind, rendered by "), ui.T("Code Foundry").Link("https://github.com/alexwaumann/code-foundry"),
		ui.T(". A build took "), ui.For(100*time.Second), ui.T(", the next starts "), ui.At(now.Add(3*time.Minute), ui.TimeCountdown),
		ui.T(" · warning").WithTone(ui.ToneAttention), ui.T(" · error").WithTone(ui.ToneError), ui.T(" · ").WithTone(ui.ToneMuted), ui.T("mono").AsMono(),
	))
	small := ui.Node{Key: "code", Text: &ui.Text{Content: ui.Plain("HELLO-4821"), Size: ui.TextLg, Copyable: true}}
	md := ui.NewMarkdown("about", "**Markdown** with `code`, a [link](https://example.com) and a list:\n\n- one\n- two\n")
	pairs := ui.NewPairs("facts",
		ui.Pair{Key: "p-thread", Label: "Thread", Value: ui.Spans(ui.T(d.open.Context.ThreadID).AsMono()), Copyable: true},
		ui.Pair{Key: "p-status", Label: "Status", Pill: ui.NewPill("passing", ui.ToneOK)},
		ui.Pair{Key: "p-elapsed", Label: "Running for", Value: ui.Spans(ui.At(d.started, ui.TimeElapsed))},
	)
	list := ui.Node{Key: "runs", List: &ui.List{GlyphStyle: ui.GlyphDot, EmptyText: "No runs", Rows: []ui.Row{
		{Key: "run-3", Glyph: ui.StatusGlyph(ui.StatusRunning), Title: "Build #3", TitleMeta: ui.Plain("main"),
			Line2: ui.Spans(ui.T("started "), ui.At(now.Add(-42*time.Second), ui.TimeElapsed)), Trailing: ui.Spans(ui.For(42 * time.Second)),
			Action:  ui.EventAction("open-run", "3"),
			Actions: []ui.Button{ui.EventButton("run-3-cancel", "Cancel", "cancel-run").WithIcon("square").AsIconOnly()}},
		{Key: "run-2", Glyph: ui.StatusGlyph(ui.StatusFailed), Title: "Build #2", Pill: ui.NewPill("failed", ui.ToneError),
			Line2: ui.Spans(ui.T("deploy failed").WithTone(ui.ToneError)), Trailing: ui.Spans(ui.For(95 * time.Second)), Action: ui.EventAction("open-run", "2")},
		{Key: "run-1", Glyph: ui.IconGlyph("check", ui.ToneNeutral), Title: "Build #1", Trailing: ui.Spans(ui.At(now.Add(-time.Hour), ui.TimeRelative)), Selected: true},
	}}}
	chips := ui.NewChips("stages",
		ui.Chip{Key: "st-build", Label: "Build", Status: ui.StatusOK, Meta: ui.Spans(ui.For(31 * time.Second))},
		ui.Chip{Key: "st-test", Label: "Test", Status: ui.StatusRunning, Meta: ui.Spans(ui.At(now.Add(-12*time.Second), ui.TimeElapsed)), Selected: true, Action: ui.EventAction("stage", "test")},
		ui.Chip{Key: "st-deploy", Label: "Deploy", Status: ui.StatusPending},
		ui.Chip{Key: "st-lint", Label: "Lint", Status: ui.StatusSkipped},
		ui.Chip{Key: "st-old", Label: "Old", Status: ui.StatusOff},
		ui.Chip{Key: "st-gate", Label: "Gate", Status: ui.StatusAttention},
		ui.Chip{Key: "st-e2e", Label: "E2E", Status: ui.StatusFailed},
	)
	progress := ui.Node{Key: "upload", Progress: &ui.Progress{Value: ui.Fraction(0.62), Label: "Uploading artifacts", Meta: ui.Plain("62 of 100 MB")}}
	spinner := ui.Node{Key: "waiting", Progress: &ui.Progress{Label: "Waiting for a runner"}}
	notice := ui.Node{Key: "auth", Notice: &ui.Notice{Tone: ui.ToneAttention, Title: "Sign in needed", Icon: "key-round",
		Body: ui.Plain("The demo backend wants a token (Form tab)."), Detail: "HTTP 401 from https://example.com/api",
		Actions: []ui.Button{ui.EventButton("auth-form", "Open the form", "goto-form").WithStyle(ui.ButtonAttention)}}}
	section := ui.Node{Key: "more", Section: &ui.Section{Title: "Nested", Meta: ui.Plain("a card that collapses"), Pill: ui.NewPill("2", ui.ToneNeutral),
		Card: true, Collapsible: true, Tone: ui.ToneAttention,
		Actions: []ui.Button{ui.CopyButton("more-copy", "Copy the thread id", d.open.Context.ThreadID).WithIcon("copy").AsIconOnly()},
		Children: []ui.Node{
			ui.NewEmpty("nothing", "Nothing here yet", ui.Plain("An empty state inside a section.")),
			{Key: "stale", Section: &ui.Section{Title: "Last known", Stale: true, Children: []ui.Node{
				ui.NewText("stale-text", ui.Plain("Dimmed: the backend is unreachable.")),
			}}},
		}}}
	empty := ui.Node{Key: "no-artifacts", Empty: &ui.Empty{Glyph: ui.IconGlyph("package", ui.ToneMuted), Title: "No artifacts",
		Body: ui.Plain("Builds that upload artifacts list them here."), Actions: []ui.Button{ui.EventButton("empty-build", "Start a build", "start-log")}}}
	bar := ui.Node{Key: "bar", Actions: &ui.Actions{Align: ui.AlignEnd, Buttons: []ui.Button{
		ui.EventButton("click", fmt.Sprintf("Click (%d)", d.clicks), "click").WithStyle(ui.ButtonAttention),
		ui.EventButton("pin", pin, "pin").WithStyle(ui.ButtonOutline).WithIcon("pin"),
		ui.CommandButton("greet", "Greet via command", "plugin.hello.greet", map[string]string{"name": "panel"}),
		ui.CommandButton("forget", "Forget the word", "plugin.hello.forget", nil).WithStyle(ui.ButtonDestructive),
		ui.URLButton("docs", "Docs", "https://github.com/alexwaumann/code-foundry").WithStyle(ui.ButtonLink),
		ui.CopyButton("copy", "Copy greeting", "Hello from the demo surface"),
	}}}
	return []ui.Node{text, small, md, pairs, list, chips, progress, spinner, notice, section, empty, bar}
}

func (d *demo) formNodes() []ui.Node {
	saved := "Nothing saved yet."
	if d.saved != nil {
		b, _ := json.Marshal(d.saved)
		saved = "Saved: " + string(b)
	}
	name := ui.TextField("f-name", "name", "Name")
	name.Input.Placeholder, name.Input.Pattern, name.Input.PatternMessage, name.Input.MaxLength = "Ada", `^[A-Za-z ]*$`, "Letters and spaces only", 40
	name.Required = true
	name.Description = ui.Plain("Who the greeting is for.")
	if v, ok := d.saved["name"].(string); ok {
		name.Input.Value = v
	}
	token := ui.SecretField("f-token", "token", "API token", "token")
	token.Description = ui.Plain("Stored in your Keychain by Code Foundry; the plugin reads it with secret/get.")
	_, token.Input.HasValue = d.saved["token"]
	project := ui.Field{Key: "f-project", Name: "project", Label: "Project", Select: &ui.Select{OptionsSource: ui.OptionsProjects, Placeholder: "Pick a project"},
		Change: ui.EventAction("project-changed", "")}
	env := ui.SelectField("f-env", "env", "Environment", ui.Opt("o-dev", "dev", "Development"), ui.Opt("o-prod", "prod", "Production"))
	env.Select.Style, env.Select.Value = ui.SelectList, []string{"dev"}
	env.Select.Options[1].Description = ui.Plain("Careful: real users.")
	tags := ui.SelectField("f-tags", "tags", "Tags", ui.Opt("o-a", "a", "Alpha"), ui.Opt("o-b", "b", "Beta"), ui.Opt("o-c", "c", "Gamma"))
	tags.Select.Multiple, tags.Select.Value = true, []string{"a"}
	notify := ui.NewFieldset("f-notify", "Notify me",
		ui.ToggleField("f-notify-fail", "notifyFail", "When a build fails", true),
		ui.ToggleField("f-notify-done", "notifyDone", "When a build finishes", false),
	)
	notify.Fieldset.Hint = ui.Plain("A fieldset groups related inputs.")
	submit := ui.EventButton("f-save", "Save", "save").WithStyle(ui.ButtonAttention)
	form := ui.NewForm("settings", &submit, name, token, project, env, tags, notify)
	form.Form.Secondary = []ui.Button{ui.EventButton("f-reset", "Reset", "reset")}
	form.Form.ResetToken = fmt.Sprint(len(d.saved))
	return []ui.Node{ui.NewText("form-intro", ui.Plain(saved)), form}
}

func (d *demo) logNodes() []ui.Node {
	state := "Idle. Start a build to stream its log."
	if d.running {
		state = fmt.Sprintf("Build %d running.", d.build)
	}
	start := ui.EventButton("log-start", "Start build", "start-log").WithStyle(ui.ButtonAttention)
	if d.running {
		start.Busy = true
	}
	return []ui.Node{
		ui.NewText("log-state", ui.Plain(state)),
		ui.NewActions("log-actions", start, ui.EventButton("log-clear", "Clear", "clear-log")),
		{Key: "build-log", Log: &ui.Log{Title: fmt.Sprintf("build %d", d.build), Rows: 12, Wrap: true}},
		{Key: "lint-log", Log: &ui.Log{Title: "lint", Rows: 6, Lines: []ui.LogLine{
			{Text: "checking 42 files"}, {Text: "warning: unused variable x", Tone: ui.ToneAttention}, {Text: "error: missing return", Tone: ui.ToneError},
		}}},
	}
}

// Act handles the demo's events.
func (d *demo) Act(ctx context.Context, act pluginsdk.SurfaceAct) error {
	switch act.Kind + ":" + act.Action {
	case "tab:tab":
		d.prepare(ctx, act.Key)
	case "click:send-hello":
		if err := d.own.sendHello(ctx, d.h); err != nil {
			return err
		}
		_ = d.h.ToastIn(act.Instance, pluginsdk.ToastInfo, "sent to the assistant")
		return nil
	case "click:ask-main":
		if err := askMain(ctx, d.h, act, d.open.Context.ThreadID); err != nil {
			return err
		}
		_ = d.h.ToastIn(act.Instance, pluginsdk.ToastInfo, "sent to the thread")
		return nil
	case "click:restart-shell":
		if err := d.own.restartShell(ctx, d.h); err != nil {
			return err
		}
		return d.render()
	}
	d.mu.Lock()
	switch act.Kind + ":" + act.Action {
	case "tab:tab":
		d.tab = act.Key
	case "click:click", "click:refresh":
		d.clicks++
	case "click:goto-form":
		d.tab = "form"
	case "click:pin":
		d.pinned = !d.pinned
		var v any
		if d.pinned {
			v = true
		}
		_ = d.h.SetContext(pluginsdk.ContextParams{Key: "pinned", Value: v, ThreadID: d.open.Context.ThreadID})
	case "submit:save":
		if name, _ := act.Values["name"].(string); strings.TrimSpace(name) == "" {
			d.mu.Unlock()
			return errors.New("a name is required")
		}
		d.saved = act.Values
		d.mu.Unlock()
		_ = d.h.ToastIn(act.Instance, pluginsdk.ToastInfo, "saved")
		return d.render()
	case "click:reset":
		d.saved = nil
	case "click:start-log":
		if !d.running {
			d.running, d.build, d.tab = true, d.build+1, "log"
			go d.stream(d.build)
		}
	case "click:clear-log":
		d.mu.Unlock()
		return d.render()
	case "change:project-changed", "click:stage", "click:open-run", "click:cancel-run":
		d.h.Log().Info("demo event", "kind", act.Kind, "action", act.Action, "data", act.Data, "value", fmt.Sprint(act.Value))
	default:
		d.mu.Unlock()
		return fmt.Errorf("the demo does not know %s %q", act.Kind, act.Action)
	}
	d.mu.Unlock()
	return d.render()
}

// stream appends a simulated build's output to the log tab, a line every 300 ms.
func (d *demo) stream(build int) {
	steps := []string{"fetching sources", "compiling 12 packages", "running 48 tests", "ok: 48 passed", "uploading artifacts", "done"}
	for i, s := range steps {
		select {
		case <-d.ctx.Done():
			return
		case <-time.After(300 * time.Millisecond):
		}
		if err := d.h.AppendLog(d.open.Instance, "build-log", fmt.Sprintf("[%d/%d] %s\n", i+1, len(steps), s)); err != nil {
			d.h.Log().Debug("append", "err", err.Error())
		}
	}
	d.mu.Lock()
	if d.build == build {
		d.running = false
	}
	d.mu.Unlock()
	_ = d.render()
}

// Visibility notes whether anyone looks; a real plugin would pause its polling.
func (d *demo) Visibility(visible bool) {
	d.mu.Lock()
	d.visible = visible
	d.mu.Unlock()
}

// Close ends the instance.
func (d *demo) Close(pluginsdk.CloseReason) { d.stop() }

// pinned is the surface the demo's Pin button makes available on a thread.
type pinned struct{ h *pluginsdk.Host }

func newPinned(_ context.Context, h *pluginsdk.Host, open pluginsdk.SurfaceOpen) (pluginsdk.Surface, error) {
	p := &pinned{h: h}
	return p, h.UpdateView(open.Instance, ui.View{Nodes: []ui.Node{
		ui.NewText("pinned", ui.Spans(ui.T("Pinned to thread "), ui.T(open.Context.ThreadID).AsMono(), ui.T(" by the demo's Pin button."))),
	}})
}

func (*pinned) Act(context.Context, pluginsdk.SurfaceAct) error {
	return errors.New("nothing to do here")
}
func (*pinned) Visibility(bool)             {}
func (*pinned) Close(pluginsdk.CloseReason) {}

// checks lists a pull request's checks (the host's pr.checks); it is available where
// the thread's pull request has GitHub Actions checks.
type checks struct{}

func newChecks(_ context.Context, h *pluginsdk.Host, open pluginsdk.SurfaceOpen) (pluginsdk.Surface, error) {
	var pr struct {
		Repo   string `json:"repo"`
		Number int    `json:"number"`
	}
	_ = json.Unmarshal(open.Facts["pr"], &pr)
	header := &ui.Header{Title: fmt.Sprintf("Checks of %s#%d", pr.Repo, pr.Number)}
	loading := ui.View{Header: header, Nodes: []ui.Node{{Key: "loading", Progress: &ui.Progress{Label: "Reading the checks"}}}}
	if err := h.UpdateView(open.Instance, loading); err != nil {
		return nil, err
	}
	// surface/open is answered at once; the checks may take a GitHub round trip.
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_ = h.UpdateView(open.Instance, checksView(ctx, h, header, open.Context, pr.Repo, pr.Number))
	}()
	return checks{}, nil
}

func checksView(ctx context.Context, h *pluginsdk.Host, header *ui.Header, uctx pluginsdk.UiContext, repo string, number int) ui.View {
	view := ui.View{Header: header}
	res, err := h.Invoke(ctx, "pr.checks", map[string]string{"repo-slug": repo, "number": fmt.Sprint(number)}, uctx)
	if err != nil {
		view.Nodes = []ui.Node{ui.NewNotice("err", ui.ToneError, "pr.checks failed", ui.Plain(err.Error()))}
		return view
	}
	var out struct {
		Checks []struct {
			Name, Workflow, Status, Conclusion, Provider, URL string
		} `json:"checks"`
	}
	_ = json.Unmarshal(res.JSON, &out)
	rows := []ui.Row{}
	for i, c := range out.Checks {
		if c.Provider != "github-actions" || len(rows) >= 50 {
			continue
		}
		st := ui.StatusRunning
		switch strings.ToLower(c.Conclusion) {
		case "success":
			st = ui.StatusOK
		case "failure", "timed_out", "startup_failure":
			st = ui.StatusFailed
		case "skipped", "neutral", "cancelled":
			st = ui.StatusSkipped
		}
		row := ui.Row{Key: fmt.Sprintf("c%d", i), Glyph: ui.StatusGlyph(st), Title: c.Name, TitleMeta: ui.Plain(c.Workflow)}
		if strings.HasPrefix(c.URL, "https://") {
			row.Action = ui.URLAction(c.URL)
		}
		rows = append(rows, row)
	}
	view.Nodes = []ui.Node{{Key: "checks", List: &ui.List{Rows: rows, EmptyText: "No GitHub Actions checks"}}}
	return view
}

func (checks) Act(context.Context, pluginsdk.SurfaceAct) error {
	return errors.New("nothing to do here")
}
func (checks) Visibility(bool)             {}
func (checks) Close(pluginsdk.CloseReason) {}
