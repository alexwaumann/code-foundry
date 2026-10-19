package main

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/plugintest"
)

// read-shell starts the clock, then reads it with the scrollback and prints every line.
func TestReadShell(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	h := plugintest.Start(t, plugin(), plugintest.Options{Name: "hello",
		Granted:      pluginsdk.Permissions{Secrets: true, Events: []string{"threads"}, ThreadStatus: true, SessionEnv: true, Terminals: true},
		Capabilities: []string{"terminals", "terminal.scrollback"},
	})
	res, err := h.Command(ctx, "read-shell", nil, pluginsdk.UiContext{})
	if err != nil || res.Message != "Clock pterm-1: 0 lines with the scrollback, 0 on the screen" {
		t.Fatalf("first read-shell = %+v, %v", res, err)
	}
	h.SetTerminalScrollback("pterm-1", "Sat Oct 18 12:00:00\nSat Oct 18 12:00:02\nSat Oct 18 12:00:04")
	h.SetTerminalText("pterm-1", "Sat Oct 18 12:00:04")
	res, err = h.Command(ctx, "read-shell", nil, pluginsdk.UiContext{})
	if err != nil || !strings.HasPrefix(res.Message, "Clock pterm-1: 3 lines with the scrollback, 1 on the screen\nSat Oct 18 12:00:00\n") {
		t.Errorf("read-shell = %+v, %v", res, err)
	}
	if reads := h.TerminalReads(); len(reads) != 4 || !reads[2].Scrollback || reads[3].Scrollback {
		t.Errorf("reads = %+v", reads)
	}
	if n := len(h.CreatedTerminals()); n != 1 {
		t.Errorf("created %d terminals, want the one clock", n)
	}
}

// Without the host capability it says so instead of reading the screen alone.
func TestReadShellOldHost(t *testing.T) {
	h := plugintest.Start(t, plugin(), plugintest.Options{Name: "hello",
		Granted:      pluginsdk.Permissions{Secrets: true, Events: []string{"threads"}, ThreadStatus: true, SessionEnv: true, Terminals: true},
		Capabilities: []string{"terminals"},
	})
	if _, err := h.Command(context.Background(), "read-shell", nil, pluginsdk.UiContext{}); err == nil || !strings.Contains(err.Error(), "scrollback") {
		t.Errorf("err = %v", err)
	}
}
