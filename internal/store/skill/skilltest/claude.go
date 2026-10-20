// Package skilltest has fakes for the skill store: a scripted claude CLI.
package skilltest

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"sync"

	"github.com/alexwaumann/code-foundry/internal/store/skill"
)

// Marketplace is one row of the fake's `plugin marketplace list --json`.
type Marketplace struct {
	Name            string `json:"name"`
	Source          string `json:"source,omitempty"`
	Repo            string `json:"repo,omitempty"`
	InstallLocation string `json:"installLocation"`
}

// Plugin is one row of the fake's `plugin list --json`.
type Plugin struct {
	ID          string `json:"id"`
	Version     string `json:"version"`
	Scope       string `json:"scope"`
	Enabled     bool   `json:"enabled"`
	InstallPath string `json:"installPath"`
	LastUpdated string `json:"lastUpdated,omitempty"`
}

// Claude is a fake claude CLI. `plugin marketplace list --json` answers Marketplaces,
// `plugin list --json` answers Plugins, `plugin marketplace update <name>` calls
// OnUpdate (when set) and fails for an unknown name. `plugin install|enable|disable|
// update|uninstall <name>@<marketplace> ... --json` change Plugins the way Claude Code
// 2.1.304 does and answer its result line (on failure: exit 1, the line on stdout);
// install takes what Available lists. Errs fails the calls whose argv (joined with
// spaces) starts with a key. Anything else fails as an unknown command.
type Claude struct {
	mu           sync.Mutex
	Marketplaces []Marketplace
	Plugins      []Plugin
	// Available is what the marketplaces offer: plugin id (name@marketplace) → version.
	Available map[string]string
	// OnUpdate runs on `plugin marketplace update <name>` (to change the checkout).
	OnUpdate func(name string) error
	// Errs fails the calls whose joined argv starts with a key.
	Errs  map[string]error
	calls [][]string
}

var _ skill.Claude = (*Claude)(nil)

// New returns a fake with no marketplaces and no plugins.
func New() *Claude { return &Claude{Errs: map[string]error{}, Available: map[string]string{}} }

// SetAvailable sets the version the marketplaces offer of plugin id.
func (c *Claude) SetAvailable(id, version string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.Available[id] = version
}

// InstalledPlugins returns Plugins under the fake's lock.
func (c *Claude) InstalledPlugins() []Plugin {
	c.mu.Lock()
	defer c.mu.Unlock()
	return slices.Clone(c.Plugins)
}

// Set replaces the marketplaces and plugins under the fake's lock.
func (c *Claude) Set(markets []Marketplace, plugins []Plugin) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.Marketplaces, c.Plugins = markets, plugins
}

// Fail makes the calls whose joined argv starts with prefix fail with err (nil clears).
func (c *Claude) Fail(prefix string, err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err == nil {
		delete(c.Errs, prefix)
		return
	}
	c.Errs[prefix] = err
}

// Calls returns the argv of every call so far.
func (c *Claude) Calls() [][]string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return slices.Clone(c.calls)
}

// CallCount is how many calls so far start with prefix (argv joined with spaces).
func (c *Claude) CallCount(prefix string) int {
	n := 0
	for _, a := range c.Calls() {
		if strings.HasPrefix(strings.Join(a, " "), prefix) {
			n++
		}
	}
	return n
}

// Run implements skill.Claude.
func (c *Claude) Run(_ context.Context, args ...string) ([]byte, error) {
	c.mu.Lock()
	c.calls = append(c.calls, slices.Clone(args))
	joined := strings.Join(args, " ")
	for prefix, err := range c.Errs {
		if strings.HasPrefix(joined, prefix) {
			c.mu.Unlock()
			return nil, err
		}
	}
	if len(args) >= 3 && args[0] == "plugin" && slices.Contains(pluginOps, args[1]) && args[len(args)-1] == "--json" {
		defer c.mu.Unlock()
		return c.pluginOp(args)
	}
	markets, plugins, onUpdate := slices.Clone(c.Marketplaces), slices.Clone(c.Plugins), c.OnUpdate
	c.mu.Unlock()
	switch {
	case joined == "plugin marketplace list --json":
		return marshal(markets)
	case joined == "plugin list --json":
		return marshal(plugins)
	case len(args) == 4 && strings.HasPrefix(joined, "plugin marketplace update "):
		if !slices.ContainsFunc(markets, func(m Marketplace) bool { return m.Name == args[3] }) {
			return nil, &skill.ClaudeError{Args: args, Msg: fmt.Sprintf("Marketplace '%s' not found", args[3])}
		}
		if onUpdate != nil {
			if err := onUpdate(args[3]); err != nil {
				return nil, err
			}
		}
		return []byte("✔ Successfully updated marketplace: " + args[3] + "\n"), nil
	}
	return nil, &skill.ClaudeError{Args: args, Msg: "error: unknown command"}
}

func marshal(v any) ([]byte, error) {
	if b, err := json.Marshal(v); err != nil || string(b) != "null" {
		return b, err
	}
	return []byte("[]"), nil
}

var pluginOps = []string{"install", "enable", "disable", "update", "uninstall"}

// result is Claude Code's --json result line.
type result struct {
	Command            string `json:"command"`
	Outcome            string `json:"outcome"`
	Plugin             string `json:"plugin"`
	PluginID           string `json:"pluginId,omitempty"`
	Scope              string `json:"scope,omitempty"`
	Message            string `json:"message"`
	FailureCode        string `json:"failureCode,omitempty"`
	AlreadyInGoalState bool   `json:"alreadyInGoalState,omitempty"`
	InstalledVersion   string `json:"installedVersion,omitempty"`
	AvailableVersion   string `json:"availableVersion,omitempty"`
	UpdateOutcome      string `json:"updateOutcome,omitempty"`
	OldVersion         string `json:"oldVersion,omitempty"`
	NewVersion         string `json:"newVersion,omitempty"`
}

// pluginOp runs `plugin <op> <id> ... --json` under c.mu.
func (c *Claude) pluginOp(args []string) ([]byte, error) {
	op, id := args[1], args[2]
	name, market, _ := strings.Cut(id, "@")
	i := slices.IndexFunc(c.Plugins, func(p Plugin) bool { return p.ID == id })
	ok := func(r result) ([]byte, error) {
		r.Command, r.Outcome, r.Plugin, r.PluginID, r.Scope = op, "ok", id, id, "user"
		b, err := json.Marshal(r)
		return append(b, '\n'), err
	}
	fail := func(code, msg string, already bool) ([]byte, error) {
		b, err := json.Marshal(result{Command: op, Outcome: "failed", Plugin: id, Message: msg, FailureCode: code, AlreadyInGoalState: already})
		if err != nil {
			return nil, err
		}
		return nil, &skill.ClaudeError{Args: args, Msg: fmt.Sprintf("✘ Failed to %s plugin %q: %s", op, id, msg), Stdout: append(b, '\n')}
	}
	if i < 0 && op != "install" {
		code := "not_installed"
		if op == "update" {
			code = "not_found"
		}
		return fail(code, fmt.Sprintf("Plugin %q not found in installed plugins", id), false)
	}
	switch op {
	case "install":
		if !slices.ContainsFunc(c.Marketplaces, func(m Marketplace) bool { return m.Name == market }) {
			return fail("not_found", fmt.Sprintf("Marketplace %q not found", market), false)
		}
		v, avail := c.Available[id]
		if !avail {
			return fail("not_found", fmt.Sprintf("Plugin %q not found in marketplace %q", name, market), false)
		}
		if i >= 0 {
			return ok(result{Message: fmt.Sprintf("Plugin %q is already installed (scope: user)", id), InstalledVersion: c.Plugins[i].Version, AvailableVersion: v})
		}
		c.Plugins = append(c.Plugins, Plugin{ID: id, Version: v, Scope: "user", Enabled: true, InstallPath: "/fake/plugins/cache/" + market + "/" + name + "/" + v})
		return ok(result{Message: fmt.Sprintf("Successfully installed plugin: %s (scope: user)", id)})
	case "enable", "disable":
		want := op == "enable"
		if c.Plugins[i].Enabled == want {
			return fail("already_in_goal_state", fmt.Sprintf("Plugin %q is already %sd", id, op), true)
		}
		c.Plugins[i].Enabled = want
		return ok(result{Message: fmt.Sprintf("Successfully %sd plugin: %s (scope: user)", op, name)})
	case "update":
		old, v := c.Plugins[i].Version, c.Available[id]
		if v == "" || v == old {
			return ok(result{Message: fmt.Sprintf("%s is already at the latest version (%s).", name, old), UpdateOutcome: "up_to_date", OldVersion: old, NewVersion: old})
		}
		c.Plugins[i].Version = v
		return ok(result{Message: fmt.Sprintf("Plugin %q updated from %s to %s for scope user. Restart to apply changes.", name, old, v), UpdateOutcome: "updated", OldVersion: old, NewVersion: v})
	default: // uninstall
		c.Plugins = slices.Delete(c.Plugins, i, i+1)
		return ok(result{Message: fmt.Sprintf("Successfully uninstalled plugin: %s (scope: user)", name)})
	}
}
