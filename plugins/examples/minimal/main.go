// Command minimal is the smallest complete Code Foundry plugin: one command
// (`code-foundry plugin minimal hello Ada`) and one surface, a side-panel tab per
// thread with a counter. plugin.json beside it declares both. Copy this directory to
// start a plugin, then replace "minimal" everywhere with the plugin's name.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

func main() {
	if err := pluginsdk.Serve(plugin()); err != nil {
		fmt.Fprintln(os.Stderr, "minimal:", err)
		os.Exit(1)
	}
}

// plugin serves everything plugin.json declares: its commands by name and its surfaces
// by id.
func plugin() pluginsdk.Plugin {
	return pluginsdk.Plugin{
		Init: func(_ context.Context, h *pluginsdk.Host) error {
			h.Log().Info("minimal is up", "host", h.HostVersion(), "dev", h.Dev())
			return nil
		},
		Commands: map[string]pluginsdk.CommandFunc{"hello": hello},
		Surfaces: map[string]pluginsdk.SurfaceFactory{"status": newStatus},
	}
}

// hello answers with a greeting: Message for people, JSON for --json.
func hello(_ context.Context, h *pluginsdk.Host, req pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
	greeting := "Hello, " + req.Arg("name") + "!"
	h.Log().Debug("greeting", "name", req.Arg("name"))
	js, err := json.Marshal(map[string]string{"greeting": greeting})
	if err != nil {
		return pluginsdk.CommandResult{}, err
	}
	return pluginsdk.CommandResult{Message: greeting, JSON: js}, nil
}

// status is one open instance of the status surface: the tab of one thread. The host
// opens it when someone first looks and closes it a minute after the last one left.
type status struct {
	h      *pluginsdk.Host
	open   pluginsdk.SurfaceOpen
	opened time.Time

	mu    sync.Mutex
	count int
}

func newStatus(_ context.Context, h *pluginsdk.Host, open pluginsdk.SurfaceOpen) (pluginsdk.Surface, error) {
	s := &status{h: h, open: open, opened: time.Now()}
	return s, s.render()
}

// render sends the whole view; the host replaces the previous one.
func (s *status) render() error {
	s.mu.Lock()
	count := s.count
	s.mu.Unlock()
	thread := s.open.Context.ThreadID
	return s.h.UpdateView(s.open.Instance, ui.View{
		Header: &ui.Header{Title: "Minimal", Subline: ui.Spans(ui.T("thread "), ui.T(thread).AsMono())},
		Nodes: []ui.Node{
			ui.NewPairs("facts",
				ui.Pair{Key: "thread", Label: "Thread", Value: ui.Spans(ui.T(thread).AsMono()), Copyable: true},
				ui.NewPair("opened", "Opened", ui.Spans(ui.At(s.opened, ui.TimeRelative))),
				ui.NewPair("count", "Count", ui.Plain(strconv.Itoa(count))),
			),
			ui.NewActions("actions",
				ui.EventButton("add", "Count", "count").WithStyle(ui.ButtonAttention),
				ui.EventButton("reset", "Reset", "reset"),
				ui.CommandButton("greet", "Say hello", "plugin.minimal.hello", map[string]string{"name": "panel"}),
			),
		},
	})
}

// Act handles the view's events: the buttons' event names.
func (s *status) Act(_ context.Context, act pluginsdk.SurfaceAct) error {
	s.mu.Lock()
	switch act.Action {
	case "count":
		s.count++
	case "reset":
		s.count = 0
	default:
		s.mu.Unlock()
		return fmt.Errorf("unknown action %q", act.Action)
	}
	s.mu.Unlock()
	return s.render()
}

// Visibility says whether anyone is looking; a plugin that polls pauses while hidden.
func (s *status) Visibility(bool) {}

// Close ends the instance: stop its goroutines here.
func (s *status) Close() {}
