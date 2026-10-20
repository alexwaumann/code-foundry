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
// OnUpdate (when set) and fails for an unknown name. Errs fails the calls whose argv
// (joined with spaces) starts with a key. Anything else fails as an unknown command.
type Claude struct {
	mu           sync.Mutex
	Marketplaces []Marketplace
	Plugins      []Plugin
	// OnUpdate runs on `plugin marketplace update <name>` (to change the checkout).
	OnUpdate func(name string) error
	// Errs fails the calls whose joined argv starts with a key.
	Errs  map[string]error
	calls [][]string
}

var _ skill.Claude = (*Claude)(nil)

// New returns a fake with no marketplaces and no plugins.
func New() *Claude { return &Claude{Errs: map[string]error{}} }

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
