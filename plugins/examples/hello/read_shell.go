package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// readShell is the read-shell command: the clock terminal's whole output (its
// scrollback and its screen, terminal/read with scrollback), with how many of those lines
// the screen alone shows. It starts the clock when it is not running.
func readShell(own *owned) pluginsdk.CommandFunc {
	return func(ctx context.Context, h *pluginsdk.Host, _ pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
		if !h.HasCapability("terminal.scrollback") {
			return pluginsdk.CommandResult{}, errors.New("this Code Foundry cannot read a terminal's scrollback")
		}
		id, err := own.shell(ctx, h)
		if err != nil {
			return pluginsdk.CommandResult{}, err
		}
		all, err := h.ReadTerminalWith(ctx, id, pluginsdk.ReadTerminalOptions{Scrollback: true})
		if err != nil {
			return pluginsdk.CommandResult{}, err
		}
		screen, err := h.ReadTerminal(ctx, id, 0)
		if err != nil {
			return pluginsdk.CommandResult{}, err
		}
		screenLines := 0
		if screen.Text != "" {
			screenLines = strings.Count(screen.Text, "\n") + 1
		}
		js, _ := json.Marshal(map[string]any{
			"terminalId": id, "lines": all.Lines, "screenLines": screenLines, "truncated": all.Truncated, "text": all.Text,
		})
		msg := fmt.Sprintf("%s %s: %d lines with the scrollback, %d on the screen", shellTitle, id, all.Lines, screenLines)
		if all.Text != "" {
			msg += "\n" + all.Text
		}
		return pluginsdk.CommandResult{Message: msg, JSON: js}, nil
	}
}
