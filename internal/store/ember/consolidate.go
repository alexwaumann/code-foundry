package ember

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"time"

	"github.com/alexwaumann/code-foundry/internal/claudestream"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// Consolidation rewrites MEMORY.md at an epoch boundary with a one-shot claude -p call
// that never runs inside Ember's context: the current file, the task changes and the
// visible conversation since the last consolidation go in on stdin, the new file comes
// out. An answer that fails validation (ValidMemory) keeps the old file.
//
// The call keeps no session, so no transcript feeds the usage page: it answers with
// --output-format json, and the result's usage and cost are recorded on the status
// (ConsolidationUsage: the last call, and the total since state.json began).

// Runner runs one consolidation call with model and returns its output: claude's JSON
// result (consolidationResult), or the answer as plain text.
type Runner func(ctx context.Context, model, prompt string) (string, error)

// maxConsolidationInput caps a consolidation's input; the oldest messages go first.
const maxConsolidationInput = 300 << 10

// keepConsolidations is how many consolidations' input and output files are kept.
const keepConsolidations = 5

// consolidationArgs is the call's command for model m: like the naming call
// (thread.ClaudeNamer) at low effort, no session persistence, no customizations and no
// tools, the prompt on stdin, a JSON result (its usage); the minimal variant drops the
// flags managed settings may refuse.
func consolidationArgs(m string, minimal bool) []string {
	args := []string{"-p", "--model", m, "--effort", "low", "--no-session-persistence", "--output-format", "json"}
	if !minimal {
		args = append(args, "--safe-mode", "--tools", "")
	}
	return args
}

// ClaudeRunner runs consolidations as `claude -p ...` (consolidationArgs) in cwd, with
// the prompt on stdin. When Claude refuses a flag of the hardened command
// (thread.IsFlagRefused) it retries once with the minimal one, and uses that for the
// rest of the daemon run.
func ClaudeRunner(claude, cwd string, log *slog.Logger) Runner {
	var minimal atomic.Bool
	return func(ctx context.Context, m, prompt string) (string, error) {
		out, err := runClaude(ctx, claude, cwd, consolidationArgs(m, minimal.Load()), prompt)
		if err != nil && !minimal.Load() && thread.IsFlagRefused(err) {
			log.Warn("ember: claude refused a consolidation flag; using the minimal command from now on", "err", err)
			minimal.Store(true)
			out, err = runClaude(ctx, claude, cwd, consolidationArgs(m, true), prompt)
		}
		return out, err
	}
}

// runClaude runs claude with args in cwd, prompt on stdin, and returns its stdout.
func runClaude(ctx context.Context, claude, cwd string, args []string, prompt string) (string, error) {
	cmd := exec.CommandContext(ctx, claude, args...)
	cmd.Dir = cwd
	cmd.Stdin = strings.NewReader(prompt)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		detail := strings.TrimSpace(strings.TrimSpace(stderr.String()) + "\n" + strings.TrimSpace(string(out)))
		return "", fmt.Errorf("claude -p: %w: %s", err, truncate(detail, 4096, "…"))
	}
	return string(out), nil
}

// ConsolidationUsage is what consolidation calls cost: the last one (Calls 1), or the
// sum over every call since state.json began. InputTokens counts every prompt token
// (uncached, cache reads and cache writes).
type ConsolidationUsage struct {
	At           time.Time `json:"at"`
	Calls        int       `json:"calls"`
	InputTokens  int64     `json:"input_tokens"`
	OutputTokens int64     `json:"output_tokens"`
	CostUSD      float64   `json:"cost_usd"`
}

// add sums u into a total, stamped with u's time.
func (t ConsolidationUsage) add(u ConsolidationUsage) ConsolidationUsage {
	return ConsolidationUsage{At: u.At, Calls: t.Calls + u.Calls, InputTokens: t.InputTokens + u.InputTokens,
		OutputTokens: t.OutputTokens + u.OutputTokens, CostUSD: t.CostUSD + u.CostUSD}
}

// consolidationResult reads a Runner's output: claude's JSON result gives the answer,
// its usage and cost (ok); anything else is the answer itself. A result claude marked an
// error is one.
func consolidationResult(out string) (answer string, u ConsolidationUsage, ok bool, err error) {
	var r claudestream.Result
	trimmed := strings.TrimSpace(out)
	if !strings.HasPrefix(trimmed, "{") || json.Unmarshal([]byte(trimmed), &r) != nil || r.Type != "result" {
		return out, ConsolidationUsage{}, false, nil
	}
	u = ConsolidationUsage{Calls: 1, CostUSD: r.TotalCostUSD}
	for _, m := range r.ModelUsage {
		u.InputTokens += m.InputTokens + m.CacheReadInputTokens + m.CacheCreationInputTokens
		u.OutputTokens += m.OutputTokens
	}
	if len(r.ModelUsage) == 0 && r.Usage != nil {
		u.InputTokens = r.Usage.InputTokens + r.Usage.CacheReadInputTokens + r.Usage.CacheCreationInputTokens
		u.OutputTokens = r.Usage.OutputTokens
	}
	if r.IsError {
		return "", u, true, fmt.Errorf("claude -p: %s: %s", cmp.Or(r.Subtype, "error"), truncate(cmp.Or(r.Result, strings.Join(r.Errors, "; ")), 4096, "…"))
	}
	return r.Result, u, true, nil
}

// recordConsolidationUsage keeps u as the last consolidation's usage and adds it to
// the total (state.json).
func (s *Store) recordConsolidationUsage(u ConsolidationUsage) {
	s.mu.Lock()
	defer s.mu.Unlock()
	u.At = s.opts.Now()
	s.st.LastConsolidationUsage = &u
	s.st.ConsolidationUsageTotal = s.st.ConsolidationUsageTotal.add(u)
	s.saveStateLocked()
	s.publishLocked(s.opts.Threads.Snapshot())
}

// ConsolidationInput is a consolidation's prompt: the instructions, then the current
// MEMORY.md, the task changes and the conversation since since, cut (oldest messages
// first) to maxConsolidationInput.
func ConsolidationInput(memory string, changes []Task, msgs []Message, since time.Time, loc *time.Location) string {
	when := "the start"
	if !since.IsZero() {
		when = since.In(loc).Format("2006-01-02 15:04")
	}
	var head strings.Builder
	head.WriteString(strings.TrimSpace(consolidatePrompt) + "\n")
	fmt.Fprintf(&head, "\n=== CURRENT MEMORY.md ===\n%s\n", strings.TrimSpace(memory))
	fmt.Fprintf(&head, "\n=== TASK CHANGES since %s ===\n", when)
	if len(changes) == 0 {
		head.WriteString("None.\n")
	}
	for _, t := range changes {
		line := fmt.Sprintf("- %s [%s] %s", t.ID, t.State, oneLine(t.Title, 200))
		if t.Outcome != "" {
			line += " — " + oneLine(t.Outcome, 500)
		}
		head.WriteString(line + "\n")
	}
	fmt.Fprintf(&head, "\n=== CONVERSATION since %s ===\n", when)
	tail := "\n=== end ===\n"
	entries := make([]string, len(msgs))
	for i, m := range msgs {
		who := "Ember"
		if m.User {
			who = "user"
		}
		entries[i] = fmt.Sprintf("### %s · %s\n%s\n", m.At.In(loc).Format("2006-01-02 15:04"), who, strings.TrimSpace(m.Text))
	}
	for {
		body := strings.Join(entries, "\n")
		if len(entries) == 0 {
			body = "None.\n"
		}
		if out := head.String() + body + tail; len(out) <= maxConsolidationInput || len(entries) == 0 {
			return truncate(out, maxConsolidationInput, tail)
		}
		entries = entries[1:]
	}
}

// ValidMemory checks a consolidation's output and returns the file to write: trimmed,
// a code fence around it removed, starting with "# ", at most maxMemory bytes.
func ValidMemory(out string) (string, error) {
	out = strings.TrimSpace(out)
	if strings.HasPrefix(out, "```") {
		lines := strings.Split(out, "\n")
		if len(lines) >= 2 && strings.HasPrefix(strings.TrimSpace(lines[len(lines)-1]), "```") {
			out = strings.TrimSpace(strings.Join(lines[1:len(lines)-1], "\n"))
		}
	}
	switch {
	case out == "":
		return "", errors.New("the consolidation answered nothing")
	case !strings.HasPrefix(out, "# "):
		return "", fmt.Errorf("the consolidation's answer does not start with a \"# \" heading: %q", truncate(out, 80, "…"))
	case len(out) > maxMemory:
		return "", fmt.Errorf("the consolidation's answer has %d bytes (at most %d)", len(out), maxMemory)
	}
	return out + "\n", nil
}

// consolidate rewrites MEMORY.md from resident id's conversation and task changes since
// the last consolidation (nothing to do when there were none). The input and the output
// are kept in consolidation/. A failure keeps the file and is returned.
func (s *Store) consolidate(ctx context.Context, id string) error {
	s.mu.Lock()
	since, model := s.st.LastConsolidatedAt, s.cfg.Model
	var changes []Task
	for _, t := range s.tasks {
		if t.UpdatedAt.After(since) {
			changes = append(changes, t)
		}
	}
	s.mu.Unlock()
	msgs, err := s.messages(ctx, id, since)
	if err != nil {
		return fmt.Errorf("ember: consolidation: read the messages: %w", err)
	}
	if len(msgs) == 0 && len(changes) == 0 {
		s.log.Info("ember: nothing to consolidate", "since", since)
		return nil
	}
	s.memMu.Lock()
	before := s.readFile(memoryFile)
	s.memMu.Unlock()
	input := ConsolidationInput(before, changes, msgs, since, s.opts.Location)
	stamp := s.opts.Now().UTC().Format("20060102T150405Z")
	s.keepConsolidation(stamp+"-input.md", input)
	cctx, cancel := context.WithTimeout(ctx, s.opts.ConsolidateTimeout)
	start := time.Now()
	out, err := s.opts.Consolidate(cctx, model, input)
	cancel()
	if err == nil {
		var u ConsolidationUsage
		var ok bool
		if out, u, ok, err = consolidationResult(out); ok {
			s.recordConsolidationUsage(u)
			s.log.Info("ember: consolidation usage", "cost_usd", u.CostUSD, "input_tokens", u.InputTokens, "output_tokens", u.OutputTokens)
		}
	}
	if err != nil {
		s.keepConsolidation(stamp+"-output.md", "ERROR: "+err.Error()+"\n")
		s.log.Warn("ember: consolidation failed; MEMORY.md kept", "err", err, "took", time.Since(start).Round(time.Millisecond))
		return fmt.Errorf("consolidation: %w", err)
	}
	s.keepConsolidation(stamp+"-output.md", out)
	mem, err := ValidMemory(out)
	if err != nil {
		s.log.Warn("ember: consolidation's answer refused; MEMORY.md kept", "err", err)
		return err
	}
	s.memMu.Lock()
	defer s.memMu.Unlock()
	// Notes remembered while the call ran are kept.
	mem = keepNewNotes(mem, before, s.readFile(memoryFile))
	if err := writeAtomic(filepath.Join(s.opts.Dir, memoryFile), []byte(mem)); err != nil {
		return err
	}
	s.log.Info("ember: memory consolidated", "input_bytes", len(input), "memory_bytes", len(mem), "messages", len(msgs),
		"task_changes", len(changes), "took", time.Since(start).Round(time.Millisecond))
	s.pruneConsolidations()
	return nil
}

// keepConsolidation writes one file of a consolidation to consolidation/ (logged on
// failure).
func (s *Store) keepConsolidation(name, body string) {
	dir := filepath.Join(s.opts.Dir, consolDir)
	err := os.MkdirAll(dir, 0o700)
	if err == nil {
		err = writeAtomic(filepath.Join(dir, name), []byte(body))
	}
	if err != nil {
		s.log.Warn("ember: keep a consolidation file", "file", name, "err", err)
	}
}

// pruneConsolidations keeps the files of the last keepConsolidations consolidations.
func (s *Store) pruneConsolidations() {
	dir := filepath.Join(s.opts.Dir, consolDir)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	var stamps []string
	for _, e := range entries {
		if stamp, _, ok := strings.Cut(e.Name(), "-"); ok && !slices.Contains(stamps, stamp) {
			stamps = append(stamps, stamp)
		}
	}
	slices.Sort(stamps)
	for _, old := range stamps[:max(0, len(stamps)-keepConsolidations)] {
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), old+"-") {
				_ = os.Remove(filepath.Join(dir, e.Name()))
			}
		}
	}
}
