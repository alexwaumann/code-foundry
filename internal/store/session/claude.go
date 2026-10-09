package session

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

// Claude CLI facts, verified against `claude --help` of Claude Code 2.1.294:
//
//	--model <model>      alias ("fable", "opus", "sonnet"; "haiku" also works) or full name
//	--effort <level>     low, medium, high, xhigh, max
//	--session-id <uuid>  use this session id (the transcript is <uuid>.jsonl)
//	-r, --resume <id>    resume a conversation by session id
//	--fork-session       with --resume: continue under a new session id
//	-p, --print          non-interactive; skips the trust dialog
//	--no-session-persistence, --tools "", --strict-mcp-config (with -p, for naming)
//
// and Claude Code 2.1.295:
//
//	--permission-mode <mode>  acceptEdits, auto, bypassPermissions, manual, dontAsk, plan
//	[prompt]                  positional first prompt; interactive mode submits it once
//	                          the UI is up (also after the trust dialog is answered)
//	--add-dir <dir>           also allow tool access to dir; without it, Read of a staged
//	                          attachment outside the worktree asks for permission even
//	                          in auto mode ("Allow this read outside the working
//	                          directories?")
//	--                        ends options: `claude -- "-hello"` sends "-hello", while
//	                          `claude "-hello"` fails with "unknown option"

// Efforts are the valid --effort levels.
var Efforts = []string{"low", "medium", "high", "xhigh", "max"}

// ModelAliases are the --model aliases offered in pickers. Full model names are also
// accepted by the store.
var ModelAliases = []string{"fable", "opus", "sonnet", "haiku"}

// modelPattern guards --model values (aliases or full names like
// "claude-opus-5-5[1m]") so nothing that looks like a flag reaches argv.
var modelPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._\-\[\]]{0,79}$`)

func validateModelEffort(model, effort string) error {
	if model != "" && !modelPattern.MatchString(model) {
		return fmt.Errorf("%w: model %q", ErrInvalidArgument, model)
	}
	if effort != "" && !slices.Contains(Efforts, effort) {
		return fmt.Errorf("%w: effort %q (want one of %s)", ErrInvalidArgument, effort, strings.Join(Efforts, ", "))
	}
	return nil
}

// launch describes how to start claude for a session.
type launch struct {
	// resume is the Claude session id to resume; empty starts a new conversation.
	resume string
	// fork continues resume under newID instead of reusing it.
	fork bool
	// newID is passed as --session-id for new conversations and forks.
	newID string
}

// claudeID is the Claude session id the process will run under.
func (l launch) claudeID() string {
	if l.resume != "" && !l.fork {
		return l.resume
	}
	return l.newID
}

// spawnArgs are the per-spawn claude options besides the conversation (launch).
type spawnArgs struct {
	model, effort string
	perm          PermissionMode
	addDirs       []string
	prompt        string
}

// argv builds the claude command line. A non-empty prompt goes last, after "--".
func (l launch) argv(claude string, a spawnArgs) []string {
	argv := []string{claude}
	if l.resume != "" {
		argv = append(argv, "--resume", l.resume)
		if l.fork {
			argv = append(argv, "--fork-session")
		}
	}
	if l.newID != "" && (l.resume == "" || l.fork) {
		argv = append(argv, "--session-id", l.newID)
	}
	if a.model != "" {
		argv = append(argv, "--model", a.model)
	}
	if a.effort != "" {
		argv = append(argv, "--effort", a.effort)
	}
	if f := a.perm.Flag(); f != "" {
		argv = append(argv, "--permission-mode", f)
	}
	for _, d := range a.addDirs {
		argv = append(argv, "--add-dir", d)
	}
	if a.prompt != "" {
		argv = append(argv, "--", a.prompt)
	}
	return argv
}

// buildPrompt is the first prompt claude gets: the user's text, then, after a blank
// line, one "Attached image: <path>" line per attachment. A prompt of only whitespace
// counts as none.
func buildPrompt(text string, attachments []string) string {
	text = strings.TrimSpace(text)
	if len(attachments) == 0 {
		return text
	}
	lines := make([]string, len(attachments))
	for i, a := range attachments {
		lines[i] = "Attached image: " + a
	}
	if text == "" {
		return strings.Join(lines, "\n")
	}
	return text + "\n\n" + strings.Join(lines, "\n")
}

// newUUID returns a random (version 4) UUID string.
func newUUID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("uuid: %w", err)
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:], nil
}

// newSessionID returns our own session id ("s-" + 12 hex digits).
func newSessionID() (string, error) {
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("session id: %w", err)
	}
	return "s-" + hex.EncodeToString(b[:]), nil
}

var nonAlnum = regexp.MustCompile(`[^A-Za-z0-9]`)

// projectSlug is the directory name Claude uses under ~/.claude/projects for a cwd:
// the cwd with symlinks resolved (/tmp -> /private/tmp), every character that is not
// an ASCII letter or digit replaced by '-'. Verified: /Users/alex/.t3/projects/x ->
// -Users-alex--t3-projects-x, "/tmp/cf2a_slug test.v2" -> -private-tmp-cf2a-slug-test-v2.
// Very long paths may be shortened by Claude; transcriptPath falls back to a glob.
func projectSlug(realCwd string) string {
	return nonAlnum.ReplaceAllString(realCwd, "-")
}

// realPath resolves symlinks, returning the cleaned input if that fails.
func realPath(p string) string {
	if r, err := filepath.EvalSymlinks(p); err == nil {
		return r
	}
	return filepath.Clean(p)
}

// ClaudePaths locates Claude's files.
type ClaudePaths struct {
	// Dir is Claude's config dir: $CLAUDE_CONFIG_DIR, else ~/.claude. It holds
	// projects/<slug>/<session-id>.jsonl and sessions/<pid>.json.
	Dir string
	// Config is the global config file holding per-project trust: ~/.claude.json, or
	// $CLAUDE_CONFIG_DIR/.claude.json.
	Config string
}

// DefaultClaudePaths resolves ClaudePaths from the environment.
func DefaultClaudePaths() (ClaudePaths, error) {
	if d := os.Getenv("CLAUDE_CONFIG_DIR"); d != "" {
		return ClaudePaths{Dir: d, Config: filepath.Join(d, ".claude.json")}, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ClaudePaths{}, fmt.Errorf("claude paths: %w", err)
	}
	return ClaudePaths{Dir: filepath.Join(home, ".claude"), Config: filepath.Join(home, ".claude.json")}, nil
}

// projectDir is where transcripts for cwd live.
func (p ClaudePaths) projectDir(cwd string) string {
	return filepath.Join(p.Dir, "projects", projectSlug(realPath(cwd)))
}

// transcriptPath returns the transcript path for a Claude session id in cwd, and
// whether it exists. If it is not in the computed project dir, any project dir is
// searched (Claude shortens very long slugs).
func (p ClaudePaths) transcriptPath(cwd, claudeID string) (string, bool) {
	want := filepath.Join(p.projectDir(cwd), claudeID+".jsonl")
	if _, err := os.Stat(want); err == nil {
		return want, true
	}
	if matches, _ := filepath.Glob(filepath.Join(p.Dir, "projects", "*", claudeID+".jsonl")); len(matches) > 0 {
		return matches[0], true
	}
	return want, false
}

// pidFile is Claude's per-process session record: {"pid":..,"sessionId":..,"cwd":..}.
// It is rewritten when the session id changes (/clear) and removed on exit.
func (p ClaudePaths) pidFile(pid int) string {
	return filepath.Join(p.Dir, "sessions", fmt.Sprintf("%d.json", pid))
}
