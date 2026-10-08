package session

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Folder trust.
//
// Claude records an accepted trust dialog in its global config (~/.claude.json) as
// projects[<cwd, symlinks resolved>].hasTrustDialogAccepted = true (observed by
// accepting the dialog once in /tmp/cf2a-trust1; Claude's own error text says "set
// projects[<path>].hasTrustDialogAccepted"). A minimal entry {"hasTrustDialogAccepted":
// true} is enough: Claude started in /tmp/cf2a-trust2 with no dialog and filled in the
// rest of the entry itself. The check also walks up to trusted parent directories.
//
// Claude rewrites the file often from every running instance. It bundles
// proper-lockfile, whose convention is a "<file>.lock" directory considered stale
// after 10s; trustWorktree takes the same lock, re-reads, edits only the one entry,
// and replaces the file atomically. If anything goes wrong, the runner's dialog
// fallback (parseTrustDialog) still accepts the dialog.

const (
	trustLockStale = 10 * time.Second
	trustLockWait  = 3 * time.Second
)

// trustWorktree marks dir (symlinks resolved) as trusted in Claude's config file. It
// reports whether the file was changed.
func trustWorktree(configPath, dir string) (bool, error) {
	key := realPath(dir)
	unlock, err := lockFile(configPath)
	if err != nil {
		return false, err
	}
	defer unlock()

	data, err := os.ReadFile(configPath)
	mode := fs.FileMode(0o600)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		data = []byte("{}")
	case err != nil:
		return false, fmt.Errorf("trust: read %s: %w", configPath, err)
	default:
		if fi, err := os.Stat(configPath); err == nil {
			mode = fi.Mode().Perm()
		}
	}
	out, changed, err := setTrusted(data, key)
	if err != nil || !changed {
		return false, err
	}
	tmp, err := os.CreateTemp(filepath.Dir(configPath), filepath.Base(configPath)+".code-foundry-*")
	if err != nil {
		return false, fmt.Errorf("trust: %w", err)
	}
	defer func() { _ = os.Remove(tmp.Name()) }()
	if _, err := tmp.Write(out); err != nil {
		_ = tmp.Close()
		return false, fmt.Errorf("trust: write: %w", err)
	}
	if err := tmp.Chmod(mode); err != nil {
		_ = tmp.Close()
		return false, fmt.Errorf("trust: chmod: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return false, fmt.Errorf("trust: close: %w", err)
	}
	if err := os.Rename(tmp.Name(), configPath); err != nil {
		return false, fmt.Errorf("trust: replace %s: %w", configPath, err)
	}
	return true, nil
}

// setTrusted sets projects[key].hasTrustDialogAccepted = true in a Claude config
// document, leaving every other value as it was (object keys come out sorted).
func setTrusted(data []byte, key string) ([]byte, bool, error) {
	var root map[string]json.RawMessage
	if err := json.Unmarshal(data, &root); err != nil {
		return nil, false, fmt.Errorf("trust: parse config: %w", err)
	}
	if root == nil {
		root = map[string]json.RawMessage{}
	}
	projects := map[string]json.RawMessage{}
	if raw, ok := root["projects"]; ok && string(raw) != "null" {
		if err := json.Unmarshal(raw, &projects); err != nil {
			return nil, false, fmt.Errorf("trust: parse projects: %w", err)
		}
	}
	entry := map[string]json.RawMessage{}
	if raw, ok := projects[key]; ok && string(raw) != "null" {
		if err := json.Unmarshal(raw, &entry); err != nil {
			return nil, false, fmt.Errorf("trust: parse project %s: %w", key, err)
		}
	}
	if string(entry["hasTrustDialogAccepted"]) == "true" {
		return data, false, nil
	}
	entry["hasTrustDialogAccepted"] = json.RawMessage("true")
	var err error
	if projects[key], err = marshalRaw(entry); err != nil {
		return nil, false, err
	}
	if root["projects"], err = marshalRaw(projects); err != nil {
		return nil, false, err
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(root); err != nil {
		return nil, false, fmt.Errorf("trust: encode config: %w", err)
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), true, nil
}

func marshalRaw(v any) (json.RawMessage, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, fmt.Errorf("trust: encode: %w", err)
	}
	return json.RawMessage(bytes.TrimRight(buf.Bytes(), "\n")), nil
}

// lockFile takes a proper-lockfile compatible lock on path (a "<path>.lock"
// directory). A lock older than trustLockStale is taken over.
func lockFile(path string) (func(), error) {
	dir := path + ".lock"
	deadline := time.Now().Add(trustLockWait)
	for {
		err := os.Mkdir(dir, 0o700)
		if err == nil {
			return func() { _ = os.Remove(dir) }, nil
		}
		if !errors.Is(err, fs.ErrExist) {
			return nil, fmt.Errorf("trust: lock %s: %w", dir, err)
		}
		if fi, serr := os.Stat(dir); serr == nil && time.Since(fi.ModTime()) > trustLockStale {
			_ = os.Remove(dir)
			continue
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("trust: lock %s: held by another process", dir)
		}
		time.Sleep(25 * time.Millisecond)
	}
}

// trustDialog is what parseTrustDialog found on a screen.
type trustDialog struct {
	Visible bool
	// YesSelected: the "Yes, I trust this folder" option has the ❯ cursor. Claude
	// selects "No, exit" by default, so the answer is Down, then Enter.
	YesSelected bool
}

// trustYes is the accepting option's label in Claude Code 2.1.294's trust dialog:
//
//	Quick safety check: Is this a project you created or one you trust? ...
//	❯ No, exit
//	  Yes, I trust this folder
//	Enter to confirm · Esc to cancel
const trustYes = "Yes, I trust this folder"

// parseTrustDialog finds Claude's folder-trust dialog on a plain-text screen. It
// must be the rendered screen (terminal.Store.ScreenText): Ink positions words with
// cursor moves, so the raw byte stream never contains the phrase.
func parseTrustDialog(screen string) trustDialog {
	if !strings.Contains(screen, trustYes) {
		return trustDialog{}
	}
	if !strings.Contains(screen, "trust") || !(strings.Contains(screen, "Quick safety check") ||
		strings.Contains(screen, "Enter to confirm") || strings.Contains(screen, "No, exit")) {
		return trustDialog{}
	}
	d := trustDialog{Visible: true}
	for _, line := range strings.Split(screen, "\n") {
		if strings.Contains(line, trustYes) {
			before, _, _ := strings.Cut(line, trustYes)
			d.YesSelected = strings.ContainsAny(before, "❯›>")
		}
	}
	return d
}

// Keys sent to answer the dialog.
const (
	keyDown  = "\x1b[B"
	keyEnter = "\r"
)
