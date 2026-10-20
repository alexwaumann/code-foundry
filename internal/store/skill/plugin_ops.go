package skill

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
)

// Marketplace plugins: Claude Code installs, enables, disables, updates and uninstalls
// them (`claude plugin <op> <name>@<marketplace> ... --json`); the store only runs it and
// reads its result line.

// pluginResult is the one line `claude plugin <op> --json` prints on stdout, on success
// and on failure (Claude Code 2.1.304):
//
//	{"command":"install","outcome":"ok","pluginId":"x@m","scope":"user","message":"Successfully installed plugin: x@m (scope: user)"}
//	{"command":"disable","outcome":"failed","message":"Plugin \"x@m\" is already disabled","failureCode":"already_in_goal_state","alreadyInGoalState":true}
//	{"command":"update","outcome":"ok","message":"x is already at the latest version (dbd4588f9e10).","updateOutcome":"up_to_date","oldVersion":"dbd4588f9e10","newVersion":"dbd4588f9e10"}
type pluginResult struct {
	Command            string `json:"command"`
	Outcome            string `json:"outcome"` // ok | failed
	PluginID           string `json:"pluginId"`
	Scope              string `json:"scope"`
	Message            string `json:"message"`
	FailureCode        string `json:"failureCode"` // not_found, not_installed, already_in_goal_state, …
	AlreadyInGoalState bool   `json:"alreadyInGoalState"`
	InstalledVersion   string `json:"installedVersion"`
	AvailableVersion   string `json:"availableVersion"`
	UpdateOutcome      string `json:"updateOutcome"` // updated | up_to_date
	OldVersion         string `json:"oldVersion"`
	NewVersion         string `json:"newVersion"`
}

// PluginError is a `claude plugin` operation Claude Code refused or failed: its message
// (Msg) and failure code (Code). It wraps the *ClaudeError (or the run's error), and is
// ErrNotFound for not_found and not_installed.
type PluginError struct {
	Op, ID string
	Code   string
	Msg    string
	Err    error
}

func (e *PluginError) Error() string {
	if e.Msg != "" {
		return e.Msg
	}
	return fmt.Sprintf("claude plugin %s %s failed", e.Op, e.ID)
}

func (e *PluginError) Unwrap() error { return e.Err }

// Is reports ErrNotFound for a plugin or marketplace Claude Code does not know.
func (e *PluginError) Is(target error) bool {
	return target == ErrNotFound && (e.Code == "not_found" || e.Code == "not_installed")
}

// runPluginOp runs `claude plugin <op> <id> <extra...> --json` and reads its result line.
// A failure whose result says the plugin is already in the asked-for state (enable an
// enabled plugin) is a result, not an error.
func runPluginOp(ctx context.Context, c Claude, op, id string, extra ...string) (pluginResult, error) {
	args := append([]string{"plugin", op, id}, extra...)
	args = append(args, "--json")
	out, err := c.Run(ctx, args...)
	var ce *ClaudeError
	if err != nil && errors.As(err, &ce) {
		out = ce.Stdout
	}
	res, perr := parsePluginResult(out)
	switch {
	case err == nil && perr == nil && res.Outcome != "failed":
		return res, nil
	case perr == nil && res.AlreadyInGoalState:
		return res, nil
	case err == nil && perr != nil:
		return pluginResult{}, &PluginError{Op: op, ID: id, Msg: fmt.Sprintf("claude plugin %s %s: %v", op, id, perr), Err: perr}
	case err == nil:
		err = fmt.Errorf("claude plugin %s %s: outcome %q", op, id, res.Outcome)
	}
	pe := &PluginError{Op: op, ID: id, Err: err}
	if perr == nil {
		pe.Code, pe.Msg = res.FailureCode, res.Message
	}
	if pe.Msg == "" {
		pe.Msg = err.Error()
	}
	return pluginResult{}, pe
}

// parsePluginResult reads the last JSON object line of out.
func parsePluginResult(out []byte) (pluginResult, error) {
	lines := bytes.Split(bytes.TrimSpace(out), []byte("\n"))
	for i := len(lines) - 1; i >= 0; i-- {
		l := bytes.TrimSpace(lines[i])
		if len(l) == 0 || l[0] != '{' {
			continue
		}
		var r pluginResult
		if err := json.Unmarshal(l, &r); err != nil {
			return pluginResult{}, fmt.Errorf("read the result: %w", err)
		}
		return r, nil
	}
	return pluginResult{}, errors.New("no result line")
}
