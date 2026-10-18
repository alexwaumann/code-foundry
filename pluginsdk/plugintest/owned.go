package plugintest

import (
	"context"
	"encoding/json"
	"slices"
	"strconv"
	"time"

	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// The plugin's own threads and terminals (thread/* with permissions.threads, terminal/*
// with permissions.terminals), kept in memory. Nothing runs: a created thread is
// "disconnected" and "idle" and a terminal "running" until the test changes them
// (SetThread, ExitTerminal). Like the real host, a plugin reaches only its own: another
// id answers CodeNotFound.

// owned is the fake's state for plugin threads and terminals. Guarded by Host.mu.
type owned struct {
	threads   []pluginsdk.PluginThread
	creates   []pluginsdk.ThreadCreateParams
	sends     []pluginsdk.ThreadSendParams
	terminals []pluginsdk.PluginTerminal
	termSpecs []pluginsdk.TerminalCreateParams
	termText  map[string]string
}

func (h *Host) handleOwned(_ context.Context, method string, params json.RawMessage) (any, bool, error) {
	g := h.opts.Granted
	switch method {
	case pluginsdk.MethodThreadCreate, pluginsdk.MethodThreadSend, pluginsdk.MethodThreadArchive, pluginsdk.MethodThreadList:
		if !g.Threads {
			return nil, true, denied("threads")
		}
	case pluginsdk.MethodTerminalCreate, pluginsdk.MethodTerminalClose, pluginsdk.MethodTerminalList, pluginsdk.MethodTerminalRead:
		if !g.Terminals {
			return nil, true, denied("terminals")
		}
	default:
		return nil, false, nil
	}
	switch method {
	case pluginsdk.MethodThreadCreate:
		p, err := decode[pluginsdk.ThreadCreateParams](params)
		if err != nil {
			return nil, true, err
		}
		if p.Title == "" {
			return nil, true, pluginsdk.NewError(pluginsdk.CodeInvalidParams, "thread/create: title is required")
		}
		var id string
		h.record(func() {
			h.own.creates = append(h.own.creates, p)
			id = "pt-" + strconv.Itoa(len(h.own.creates))
			cwd := p.Cwd
			if cwd == "" {
				cwd = h.opts.DataDir
			}
			model := p.Model
			if model == "" {
				model = "default"
			}
			h.own.threads = append(h.own.threads, pluginsdk.PluginThread{
				ThreadID: id, Title: p.Title, Cwd: cwd, ProjectID: p.ProjectID, Model: model, Effort: p.Effort,
				State: "disconnected", Status: "idle", CreatedAt: time.Now(),
			})
		})
		return pluginsdk.ThreadCreateResult{ThreadID: id}, true, nil
	case pluginsdk.MethodThreadSend:
		p, err := decode[pluginsdk.ThreadSendParams](params)
		if err != nil {
			return nil, true, err
		}
		if p.Text == "" {
			return nil, true, pluginsdk.NewError(pluginsdk.CodeInvalidParams, "thread/send: text is required")
		}
		if !h.ownsThread(p.ThreadID) {
			return nil, true, pluginsdk.NewError(pluginsdk.CodeNotFound, "thread %s is not one of the plugin's threads", p.ThreadID)
		}
		h.record(func() {
			h.own.sends = append(h.own.sends, p)
			h.editThread(p.ThreadID, func(t *pluginsdk.PluginThread) { t.Archived = false })
		})
		return struct{}{}, true, nil
	case pluginsdk.MethodThreadArchive:
		p, err := decode[pluginsdk.ThreadRef](params)
		if err != nil {
			return nil, true, err
		}
		if !h.ownsThread(p.ThreadID) {
			return nil, true, pluginsdk.NewError(pluginsdk.CodeNotFound, "thread %s is not one of the plugin's threads", p.ThreadID)
		}
		h.record(func() { h.editThread(p.ThreadID, func(t *pluginsdk.PluginThread) { t.Archived = true }) })
		return struct{}{}, true, nil
	case pluginsdk.MethodThreadList:
		return pluginsdk.ThreadListResult{Threads: h.PluginThreads()}, true, nil
	case pluginsdk.MethodTerminalCreate:
		p, err := decode[pluginsdk.TerminalCreateParams](params)
		if err != nil {
			return nil, true, err
		}
		if len(p.Argv) == 0 || p.Argv[0] == "" {
			return nil, true, pluginsdk.NewError(pluginsdk.CodeInvalidParams, "terminal/create: argv is required")
		}
		var id string
		h.record(func() {
			h.own.termSpecs = append(h.own.termSpecs, p)
			id = "pterm-" + strconv.Itoa(len(h.own.termSpecs))
			cwd := p.Cwd
			if cwd == "" {
				cwd = h.opts.DataDir
			}
			title := p.Title
			if title == "" {
				title = p.Argv[0]
			}
			h.own.terminals = append(h.own.terminals, pluginsdk.PluginTerminal{
				TerminalID: id, Title: title, Argv: slices.Clone(p.Argv), Cwd: cwd, State: "running", StartedAt: time.Now(),
			})
		})
		return pluginsdk.TerminalCreateResult{TerminalID: id}, true, nil
	case pluginsdk.MethodTerminalClose:
		p, err := decode[pluginsdk.TerminalRef](params)
		if err != nil {
			return nil, true, err
		}
		found := false
		h.record(func() {
			i := slices.IndexFunc(h.own.terminals, func(t pluginsdk.PluginTerminal) bool { return t.TerminalID == p.TerminalID })
			if found = i >= 0; found {
				h.own.terminals = slices.Delete(h.own.terminals, i, i+1)
			}
		})
		if !found {
			return nil, true, pluginsdk.NewError(pluginsdk.CodeNotFound, "terminal %s is not one of the plugin's terminals", p.TerminalID)
		}
		return struct{}{}, true, nil
	case pluginsdk.MethodTerminalRead:
		p, err := decode[pluginsdk.TerminalReadParams](params)
		if err != nil {
			return nil, true, err
		}
		h.mu.Lock()
		own := slices.ContainsFunc(h.own.terminals, func(t pluginsdk.PluginTerminal) bool { return t.TerminalID == p.TerminalID })
		text := h.own.termText[p.TerminalID]
		h.mu.Unlock()
		if !own {
			return nil, true, pluginsdk.NewError(pluginsdk.CodeNotFound, "terminal %s is not one of the plugin's terminals", p.TerminalID)
		}
		max := p.MaxBytes
		if max <= 0 {
			max = 64 << 10
		}
		res := pluginsdk.TerminalReadResult{Text: text}
		if len(text) > max {
			res.Text, res.Truncated = text[len(text)-max:], true
		}
		return res, true, nil
	default: // MethodTerminalList
		return pluginsdk.TerminalListResult{Terminals: h.PluginTerminals()}, true, nil
	}
}

func (h *Host) ownsThread(id string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return slices.ContainsFunc(h.own.threads, func(t pluginsdk.PluginThread) bool { return t.ThreadID == id })
}

// editThread changes one thread in place. h.mu held.
func (h *Host) editThread(id string, fn func(t *pluginsdk.PluginThread)) {
	for i := range h.own.threads {
		if h.own.threads[i].ThreadID == id {
			fn(&h.own.threads[i])
		}
	}
}

// PluginThreads returns the plugin's threads (thread/create, oldest first).
func (h *Host) PluginThreads() []pluginsdk.PluginThread {
	h.mu.Lock()
	defer h.mu.Unlock()
	return slices.Clone(h.own.threads)
}

// CreatedThreads returns the thread/create calls the host accepted.
func (h *Host) CreatedThreads() []pluginsdk.ThreadCreateParams {
	h.mu.Lock()
	defer h.mu.Unlock()
	return slices.Clone(h.own.creates)
}

// ThreadSends returns the thread/send calls the host accepted.
func (h *Host) ThreadSends() []pluginsdk.ThreadSendParams {
	h.mu.Lock()
	defer h.mu.Unlock()
	return slices.Clone(h.own.sends)
}

// SetThread changes one of the plugin's threads as the real host would (a status after
// a turn, say).
func (h *Host) SetThread(id string, fn func(t *pluginsdk.PluginThread)) {
	h.record(func() { h.editThread(id, fn) })
}

// PluginTerminals returns the plugin's open terminals.
func (h *Host) PluginTerminals() []pluginsdk.PluginTerminal {
	h.mu.Lock()
	defer h.mu.Unlock()
	return slices.Clone(h.own.terminals)
}

// CreatedTerminals returns the terminal/create calls the host accepted.
func (h *Host) CreatedTerminals() []pluginsdk.TerminalCreateParams {
	h.mu.Lock()
	defer h.mu.Unlock()
	return slices.Clone(h.own.termSpecs)
}

// ExitTerminal marks one of the plugin's terminals exited with code and sends the plugin
// terminal/exited (Plugin.OnTerminalExit), as the real host does.
func (h *Host) ExitTerminal(id string, code int) {
	h.record(func() {
		for i := range h.own.terminals {
			if h.own.terminals[i].TerminalID == id {
				h.own.terminals[i].State, h.own.terminals[i].ExitCode = "exited", code
			}
		}
	})
	_ = h.conn.Notify(pluginsdk.MethodTerminalExited, pluginsdk.TerminalExited{TerminalID: id, ExitCode: code})
}

// SetTerminalText sets what terminal/read answers for one of the plugin's terminals (its
// screen as plain text).
func (h *Host) SetTerminalText(id, text string) {
	h.record(func() {
		if h.own.termText == nil {
			h.own.termText = map[string]string{}
		}
		h.own.termText[id] = text
	})
}
