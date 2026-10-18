package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

// The demo's Assistant and Shell tabs: a Claude thread and a terminal the plugin owns
// (permissions threads and terminals). Both are made the first time a tab needs them and
// found again with thread/list and terminal/list after a restart, so every demo instance
// (one per thread) shows the same two.

const (
	assistantTitle = "Hello assistant"
	shellTitle     = "Clock"
	// helloPrompt is what Send hello sends to the assistant.
	helloPrompt = "say hello in one line"
	// askMainPrompt is what Ask the main thread sends to the thread the panel shows.
	askMainPrompt = "The hello plugin says hi from its Assistant tab. Answer in one short line."
)

// clockArgv prints the date every two seconds.
var clockArgv = []string{"sh", "-c", "while true; do date; sleep 2; done"}

// greetingSkill is the tiny skill the assistant gets through --add-dir.
const greetingSkill = `---
name: hello-greeting
description: How the hello plugin's assistant greets. Use it whenever you are asked to say hello.
---

# Greeting

Answer in one line that starts with "Hello from the hello plugin" and says you run in
its data directory. Do not use any tools.
`

// owned keeps the plugin's assistant thread and clock terminal.
type owned struct {
	mu       sync.Mutex
	threadID string
	termID   string
}

// assistant returns the assistant thread's id, making the thread (and its skill dir) the
// first time.
func (o *owned) assistant(ctx context.Context, h *pluginsdk.Host) (string, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.threadID != "" {
		return o.threadID, nil
	}
	if !h.HasCapability("threads") {
		return "", errors.New("this Code Foundry has no plugin threads")
	}
	list, err := h.Threads(ctx)
	if err != nil {
		return "", err
	}
	for _, t := range list {
		if t.Title == assistantTitle && (o.threadID == "" || !t.Archived) {
			o.threadID = t.ThreadID
		}
	}
	if o.threadID != "" {
		return o.threadID, nil
	}
	skills := filepath.Join(h.DataDir(), "assistant")
	file := filepath.Join(skills, ".claude", "skills", "hello-greeting", "SKILL.md")
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(file, []byte(greetingSkill), 0o644); err != nil {
		return "", err
	}
	id, err := h.CreateThread(ctx, pluginsdk.ThreadCreateParams{
		Title: assistantTitle, AddDirs: []string{skills}, Env: map[string]string{"CF_HELLO_THREAD": "1"}, Effort: "low",
	})
	if err != nil {
		return "", err
	}
	h.Log().Info("assistant thread created", "thread", id)
	o.threadID = id
	return id, nil
}

// shell returns the clock terminal's id, starting it when it is not running.
func (o *owned) shell(ctx context.Context, h *pluginsdk.Host) (string, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if !h.HasCapability("terminals") {
		return "", errors.New("this Code Foundry has no plugin terminals")
	}
	list, err := h.Terminals(ctx)
	if err != nil {
		return "", err
	}
	for _, t := range list {
		if t.TerminalID == o.termID || (o.termID == "" && t.Title == shellTitle && t.State == "running") {
			o.termID = t.TerminalID
			return o.termID, nil
		}
	}
	id, err := h.CreateTerminal(ctx, pluginsdk.TerminalCreateParams{Argv: clockArgv, Title: shellTitle})
	if err != nil {
		return "", err
	}
	o.termID = id
	return id, nil
}

// restartShell closes the clock terminal and starts a new one.
func (o *owned) restartShell(ctx context.Context, h *pluginsdk.Host) error {
	o.mu.Lock()
	old := o.termID
	o.termID = ""
	o.mu.Unlock()
	if old != "" {
		if err := h.CloseTerminal(ctx, old); err != nil {
			h.Log().Warn("close the clock", "err", err.Error())
		}
	}
	_, err := o.shell(ctx, h)
	return err
}

func (o *owned) ids() (thread, term string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.threadID, o.termID
}

// assistantNodes is the Assistant tab: the thread inline with its composer, and two
// buttons: one sends to the assistant, one (through host/invoke of thread.send) to the
// thread the panel shows, which the act's context names.
func assistantNodes(threadID string, err error) []ui.Node {
	intro := ui.NewText("assistant-intro", ui.Spans(
		ui.T("A Claude thread the plugin owns, in its data directory with a small skill and "),
		ui.T("CF_HELLO_THREAD=1").AsMono(), ui.T(". It is not in the sidebar: "), ui.T("code-foundry plugin threads hello").AsMono(), ui.T(" lists it."),
	))
	if err != nil {
		return []ui.Node{intro, ui.NewNotice("assistant-error", ui.ToneError, "No assistant", ui.Plain(err.Error()))}
	}
	bar := ui.Node{Key: "assistant-actions", Actions: &ui.Actions{Buttons: []ui.Button{
		ui.EventButton("send-hello", "Send hello", "send-hello").WithStyle(ui.ButtonAttention).WithIcon("send"),
		ui.EventButton("ask-main", "Ask the main thread", "ask-main").WithIcon("message-square"),
	}}}
	return []ui.Node{intro, bar, {Key: "assistant-thread", Thread: &ui.Thread{
		ThreadID: threadID, Placeholder: "Message the assistant…", Height: ui.HeightFill,
	}}}
}

// shellNodes is the Shell tab: the clock terminal with a Restart button.
func shellNodes(termID string, err error) []ui.Node {
	intro := ui.NewText("shell-intro", ui.Plain("A terminal the plugin owns, printing the date every two seconds. Open it in the bottom panel to keep it in view while you work."))
	if err != nil {
		return []ui.Node{intro, ui.NewNotice("shell-error", ui.ToneError, "No terminal", ui.Plain(err.Error()))}
	}
	return []ui.Node{intro, {Key: "clock", Terminal: &ui.Terminal{
		TerminalID: termID, Title: shellTitle, Height: ui.HeightPx(320),
		Actions: []ui.Button{ui.EventButton("restart-shell", "Restart", "restart-shell").WithIcon("rotate-ccw")},
	}}}
}

// sendHello sends the assistant its prompt.
func (o *owned) sendHello(ctx context.Context, h *pluginsdk.Host) error {
	id, err := o.assistant(ctx, h)
	if err != nil {
		return err
	}
	return h.SendThread(ctx, id, helloPrompt)
}

// askMain sends a message to the thread the acting panel shows (act.Context), through
// the host's thread.send.
func askMain(ctx context.Context, h *pluginsdk.Host, act pluginsdk.SurfaceAct, fallback string) error {
	target := act.Context.ThreadID
	if target == "" {
		target = fallback
	}
	if target == "" {
		return errors.New("no thread: open the panel on a thread")
	}
	if _, err := h.Invoke(ctx, "thread.send", map[string]string{"text": askMainPrompt}, pluginsdk.UiContext{ThreadID: target}); err != nil {
		return fmt.Errorf("thread.send: %w", err)
	}
	return nil
}
