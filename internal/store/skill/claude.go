package skill

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

// Claude runs the claude CLI. ExecClaude runs the real one; skilltest.Claude is a fake,
// so tests never run the real binary.
type Claude interface {
	// Run runs `claude args...` and returns its stdout. A non-zero exit is a
	// *ClaudeError.
	Run(ctx context.Context, args ...string) ([]byte, error)
}

// ClaudeError is claude exiting non-zero.
type ClaudeError struct {
	Args []string
	// Msg is the first line claude printed on stderr (else stdout).
	Msg string
	// Stdout is what claude printed on stdout: a `--json` command's result line, which
	// it prints on failure too.
	Stdout []byte
}

func (e *ClaudeError) Error() string {
	return "claude " + strings.Join(e.Args, " ") + ": " + cmp.Or(e.Msg, "failed")
}

// ExecClaude runs the claude executable Path returns: advanced.claude_path, else
// "claude" from PATH, read on every call so the setting applies live.
type ExecClaude struct {
	Path func() string
	// Timeout bounds one call (DefaultClaudeTimeout when 0): `marketplace update` clones
	// or pulls a repository.
	Timeout time.Duration
}

// DefaultClaudeTimeout bounds one claude call. Claude Code's own git operations time
// out at 120 s.
const DefaultClaudeTimeout = 3 * time.Minute

// Run implements Claude.
func (c ExecClaude) Run(ctx context.Context, args ...string) ([]byte, error) {
	bin := "claude"
	if c.Path != nil {
		bin = cmp.Or(c.Path(), bin)
	}
	ctx, cancel := context.WithTimeout(ctx, cmp.Or(c.Timeout, DefaultClaudeTimeout))
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Env = append(os.Environ(), "NO_COLOR=1", "GIT_TERMINAL_PROMPT=0")
	cmd.WaitDelay = 2 * time.Second
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, fmt.Errorf("claude %s: %w", strings.Join(args, " "), ctxErr)
		}
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			msg := firstLine(stderr.String())
			if msg == "" {
				msg = firstLine(stdout.String())
			}
			return nil, &ClaudeError{Args: args, Msg: msg, Stdout: stdout.Bytes()}
		}
		return nil, fmt.Errorf("run claude: %w", err)
	}
	return stdout.Bytes(), nil
}

func firstLine(s string) string {
	line, _, _ := strings.Cut(strings.TrimSpace(s), "\n")
	return strings.TrimSpace(line)
}

// marketplaceInfo is one row of `claude plugin marketplace list --json`.
type marketplaceInfo struct {
	Name            string `json:"name"`
	Source          string `json:"source"` // github, git, url, directory, …
	Repo            string `json:"repo"`   // owner/repo for github sources
	URL             string `json:"url"`
	Ref             string `json:"ref"`
	InstallLocation string `json:"installLocation"`
}

// listMarketplaces runs `claude plugin marketplace list --json`.
func listMarketplaces(ctx context.Context, c Claude) ([]marketplaceInfo, error) {
	out, err := c.Run(ctx, "plugin", "marketplace", "list", "--json")
	if err != nil {
		return nil, err
	}
	var l []marketplaceInfo
	if err := json.Unmarshal(out, &l); err != nil {
		return nil, fmt.Errorf("claude plugin marketplace list: %w", err)
	}
	return l, nil
}

// pluginInfo is one row of `claude plugin list --json`.
type pluginInfo struct {
	ID          string `json:"id"` // name@marketplace
	Version     string `json:"version"`
	Scope       string `json:"scope"`
	Enabled     bool   `json:"enabled"`
	InstallPath string `json:"installPath"`
	InstalledAt string `json:"installedAt"` // RFC 3339; read leniently
	LastUpdated string `json:"lastUpdated"`
}

// listPlugins runs `claude plugin list --json`.
func listPlugins(ctx context.Context, c Claude) ([]pluginInfo, error) {
	out, err := c.Run(ctx, "plugin", "list", "--json")
	if err != nil {
		return nil, err
	}
	var l []pluginInfo
	if err := json.Unmarshal(out, &l); err != nil {
		return nil, fmt.Errorf("claude plugin list: %w", err)
	}
	return l, nil
}

// PluginID is the id Claude Code knows a marketplace plugin by: name@marketplace.
func PluginID(name, marketplace string) string { return name + "@" + marketplace }

// splitPluginID splits name@marketplace (marketplace "" when there is no @).
func splitPluginID(id string) (name, marketplace string) {
	i := strings.LastIndex(id, "@")
	if i < 0 {
		return id, ""
	}
	return id[:i], id[i+1:]
}
