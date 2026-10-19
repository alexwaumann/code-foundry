// Command hello is the example Code Foundry plugin (plugin.json beside it). It shows
// the SDK end to end: commands with args and context, a host command run on the
// user's behalf (thread.send through host/invoke, allowed by the manifest's
// permissions.commands), the secrets API, logging, surfaces (surface.go: a demo of every
// view node kind, one a context fact makes available, and one gated on a pull request's
// GitHub Actions checks), an event subscription (the thread list), a flag on a thread
// (flag), the session environment (every new thread gets CF_HELLO=1), and a Claude
// thread and a terminal of its own (owned.go: the demo's Assistant and Shell tabs).
//
// Build it with `make plugins`, then link it for development:
//
//	code-foundry plugin dev plugins/examples/hello
//	code-foundry plugin hello greet Ada
//	code-foundry plugin hello send "hi" --context-thread <thread id>
//	code-foundry plugin hello remember swordfish && code-foundry plugin hello recall
//	code-foundry plugin hello flag --context-thread <thread id> --level attention --reason "look here"
//	code-foundry plugin env hello
//	code-foundry plugin logs hello
//	code-foundry plugin surface hello demo --context-thread <thread id>
//	code-foundry plugin act hello demo click --context-thread <thread id>
//	code-foundry plugin hello read-shell
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"sync/atomic"

	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// wordKey is the secret the remember command keeps.
const wordKey = "word"

func main() {
	if err := pluginsdk.Serve(plugin()); err != nil {
		fmt.Fprintln(os.Stderr, "hello:", err)
		os.Exit(1)
	}
}

func plugin() pluginsdk.Plugin {
	var events atomic.Int64
	own := &owned{}
	return pluginsdk.Plugin{
		Init: func(ctx context.Context, h *pluginsdk.Host) error {
			h.Log().Info("hello is up", "host", h.HostVersion(), "data_dir", h.DataDir(), "dev", h.Dev(), "flags", len(h.Flags()))
			// Every new Claude thread gets CF_HELLO=1 while hello is enabled.
			res, err := h.SetEnvironment(ctx, pluginsdk.Environment{Env: map[string]string{"CF_HELLO": "1"}, Scope: &pluginsdk.EnvironmentScope{NoProject: true}})
			if err != nil {
				return fmt.Errorf("session environment: %w", err)
			}
			for _, is := range res.Issues {
				h.Log().Warn("session environment issue", "issue", is)
			}
			sub, err := h.Subscribe(ctx, "threads")
			if err != nil {
				return fmt.Errorf("subscribe: %w", err)
			}
			h.Log().Info("subscribed to the thread list", "subscription", sub)
			return nil
		},
		OnEvent: func(_ context.Context, h *pluginsdk.Host, ev pluginsdk.Event) {
			// The first events, then every 100th: enough to see them in the log.
			if n := events.Add(1); n <= 10 || n%100 == 0 {
				h.Log().Info("event", "n", n, "snapshot", ev.Snapshot, "kind", eventKind(ev.Event))
			}
		},
		Commands: map[string]pluginsdk.CommandFunc{
			"greet":      greet,
			"send":       send,
			"remember":   remember,
			"recall":     recall,
			"forget":     forget,
			"unpin":      unpin,
			"flag":       flag,
			"read-shell": readShell(own),
			"events": func(context.Context, *pluginsdk.Host, pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
				n := events.Load()
				js, _ := json.Marshal(map[string]int64{"events": n})
				return pluginsdk.CommandResult{Message: strconv.FormatInt(n, 10) + " thread list events", JSON: js}, nil
			},
		},
		Surfaces: map[string]pluginsdk.SurfaceFactory{
			"demo":   demoFactory(own),
			"pinned": newPinned,
			"checks": newChecks,
		},
		Shutdown: func(_ context.Context, h *pluginsdk.Host) {
			h.Log().Info("hello is stopping")
		},
	}
}

func greet(_ context.Context, h *pluginsdk.Host, req pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
	name := req.Arg("name")
	h.Log().Debug("greeting", "name", name)
	js, _ := json.Marshal(map[string]string{"greeting": "Hello, " + name + "!"})
	return pluginsdk.CommandResult{Message: "Hello, " + name + "!", JSON: js}, nil
}

// send asks the host to run thread.send in the thread the command was invoked for.
func send(ctx context.Context, h *pluginsdk.Host, req pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
	uctx := req.Context
	if t := req.Arg("thread"); t != "" {
		uctx.ThreadID = t
	}
	if uctx.ThreadID == "" {
		return pluginsdk.CommandResult{}, errors.New("no thread: run it from a thread, or pass --context-thread <id>")
	}
	res, err := h.Invoke(ctx, "thread.send", map[string]string{"text": req.Arg("text")}, uctx)
	if err != nil {
		return pluginsdk.CommandResult{}, fmt.Errorf("thread.send: %w", err)
	}
	h.Log().Info("sent a message", "thread", uctx.ThreadID)
	return pluginsdk.CommandResult{Message: "sent: " + res.Message}, nil
}

func remember(ctx context.Context, h *pluginsdk.Host, req pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
	if err := h.Secrets().Set(ctx, wordKey, req.Arg("word")); err != nil {
		return pluginsdk.CommandResult{}, err
	}
	h.Log().Info("remembered a word") // never the value
	return pluginsdk.CommandResult{Message: "remembered (in the Keychain)"}, nil
}

func recall(ctx context.Context, h *pluginsdk.Host, _ pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
	word, ok, err := h.Secrets().Get(ctx, wordKey)
	switch {
	case err != nil:
		return pluginsdk.CommandResult{}, err
	case !ok:
		return pluginsdk.CommandResult{Message: "nothing remembered yet (code-foundry plugin hello remember <word>)"}, nil
	}
	return pluginsdk.CommandResult{Message: "the word is " + word}, nil
}

// unpin withdraws the pinned surface from a thread (the hello.pinned context fact).
func unpin(_ context.Context, h *pluginsdk.Host, req pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
	id := req.Arg("thread")
	if id == "" {
		id = req.Context.ThreadID
	}
	if err := h.SetContext(pluginsdk.ContextParams{Key: "pinned", Value: nil, ThreadID: id}); err != nil {
		return pluginsdk.CommandResult{}, err
	}
	return pluginsdk.CommandResult{Message: "unpinned from " + id}, nil
}

func forget(ctx context.Context, h *pluginsdk.Host, _ pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
	if err := h.Secrets().Delete(ctx, wordKey); err != nil {
		return pluginsdk.CommandResult{}, err
	}
	return pluginsdk.CommandResult{Message: "forgotten"}, nil
}

// flag raises, or with level none clears, hello's flag on the thread.
func flag(ctx context.Context, h *pluginsdk.Host, req pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
	id := req.Context.ThreadID
	if t := req.Arg("thread"); t != "" {
		id = t
	}
	if id == "" {
		return pluginsdk.CommandResult{}, errors.New("no thread: run it from a thread, or pass --context-thread <id>")
	}
	level := req.Arg("level")
	if err := h.SetFlag(ctx, pluginsdk.Flag{ThreadID: id, Level: level, Reason: req.Arg("reason"), UntilSeen: req.Arg("until-seen") == "true"}); err != nil {
		return pluginsdk.CommandResult{}, fmt.Errorf("flag: %w", err)
	}
	if level == pluginsdk.FlagNone {
		return pluginsdk.CommandResult{Message: "cleared the flag on " + id}, nil
	}
	return pluginsdk.CommandResult{Message: level + " flag on " + id + ": " + req.Arg("reason")}, nil
}

// eventKind names an event by its source and change ("threadList.updated"), from the
// protojson's first keys.
func eventKind(raw json.RawMessage) string {
	var ev map[string]json.RawMessage
	if json.Unmarshal(raw, &ev) != nil {
		return "?"
	}
	for k, v := range ev {
		if k == "seq" || k == "epoch" {
			continue
		}
		var inner map[string]json.RawMessage
		if json.Unmarshal(v, &inner) == nil {
			for ik := range inner {
				return k + "." + ik
			}
		}
		return k
	}
	return "?"
}
