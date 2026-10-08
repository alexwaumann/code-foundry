package gitops

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// PathPlaceholder in an editor command is replaced by the worktree path. Without it the
// path is appended as the last argument.
const PathPlaceholder = "{path}"

// guiEditors are $VISUAL/$EDITOR values worth using from a daemon with no terminal.
// Terminal editors (vim, nano, ...) would start with no tty and exit or hang.
var guiEditors = map[string]bool{
	"code": true, "code-insiders": true, "cursor": true, "zed": true, "subl": true,
	"mate": true, "windsurf": true, "idea": true, "goland": true, "fleet": true,
	"nova": true, "bbedit": true, "open": true,
}

// detectOrder is tried on PATH (plus Homebrew's bin dirs) when nothing is configured.
var detectOrder = []string{"cursor", "code", "zed", "subl", "windsurf"}

// appBundles are the fallback when no CLI is installed: `open -a <app> <path>`.
var appBundles = []string{"Cursor", "Visual Studio Code", "Zed", "Sublime Text"}

// extraBinDirs are searched after PATH: an app-launched daemon inherits launchd's
// minimal PATH, which has neither Homebrew prefix.
var extraBinDirs = []string{"/opt/homebrew/bin", "/usr/local/bin"}

// editorEnv is what editor resolution reads from the system; tests fake it.
type editorEnv struct {
	getenv   func(string) string
	lookPath func(string) (string, error)
	exists   func(string) bool
}

func systemEditorEnv() editorEnv {
	return editorEnv{
		getenv: os.Getenv,
		lookPath: func(name string) (string, error) {
			if p, err := exec.LookPath(name); err == nil {
				return p, nil
			}
			for _, d := range extraBinDirs {
				p := filepath.Join(d, name)
				if fi, err := os.Stat(p); err == nil && !fi.IsDir() && fi.Mode()&0o111 != 0 {
					return p, nil
				}
			}
			return "", exec.ErrNotFound
		},
		exists: func(p string) bool { _, err := os.Stat(p); return err == nil },
	}
}

// errNoEditor means nothing was configured and nothing was detected.
var errNoEditor = errors.New(`no editor found: set the editor command (for example "code" or "open -a Zed")`)

// resolveEditor returns the argv that opens path. configured is the editor setting
// (shell-style words, may contain PathPlaceholder); empty means detect: $VISUAL or
// $EDITOR when it names a GUI editor, then the first of detectOrder found, then an
// installed app bundle.
func resolveEditor(configured, path string, env editorEnv) ([]string, error) {
	if strings.TrimSpace(configured) != "" {
		argv, err := splitWords(configured)
		if err != nil {
			return nil, fmt.Errorf("%w: editor command: %v", ErrInvalidArgument, err)
		}
		if len(argv) == 0 {
			return nil, errNoEditor
		}
		// "code" may be in Homebrew's bin, which an app-launched daemon's PATH lacks.
		if !strings.Contains(argv[0], "/") {
			if p, err := env.lookPath(argv[0]); err == nil {
				argv[0] = p
			}
		}
		return withPath(argv, path), nil
	}
	for _, v := range []string{"VISUAL", "EDITOR"} {
		argv, err := splitWords(env.getenv(v))
		if err != nil || len(argv) == 0 || !guiEditors[filepath.Base(argv[0])] {
			continue
		}
		if p, err := env.lookPath(argv[0]); err == nil {
			argv[0] = p
			return withPath(argv, path), nil
		}
	}
	for _, name := range detectOrder {
		if p, err := env.lookPath(name); err == nil {
			return []string{p, path}, nil
		}
	}
	for _, app := range appBundles {
		if env.exists("/Applications/" + app + ".app") {
			return []string{"/usr/bin/open", "-a", app, path}, nil
		}
	}
	return nil, errNoEditor
}

// withPath substitutes PathPlaceholder in argv, or appends path when absent.
func withPath(argv []string, path string) []string {
	out := make([]string, 0, len(argv)+1)
	found := false
	for _, a := range argv {
		if strings.Contains(a, PathPlaceholder) {
			found = true
			a = strings.ReplaceAll(a, PathPlaceholder, path)
		}
		out = append(out, a)
	}
	if !found {
		out = append(out, path)
	}
	return out
}

// splitWords splits s into words like a POSIX shell without expansion: whitespace
// separates, single quotes are literal, double quotes allow \" and \\, and a backslash
// outside quotes escapes the next character.
func splitWords(s string) ([]string, error) {
	var words []string
	var cur strings.Builder
	inWord := false
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n':
			if inWord {
				words = append(words, cur.String())
				cur.Reset()
				inWord = false
			}
		case c == '\'':
			j := strings.IndexByte(s[i+1:], '\'')
			if j < 0 {
				return nil, errors.New("unterminated single quote")
			}
			cur.WriteString(s[i+1 : i+1+j])
			i += j + 1
			inWord = true
		case c == '"':
			i++
			for ; i < len(s) && s[i] != '"'; i++ {
				if s[i] == '\\' && i+1 < len(s) && (s[i+1] == '"' || s[i+1] == '\\') {
					i++
				}
				cur.WriteByte(s[i])
			}
			if i >= len(s) {
				return nil, errors.New("unterminated double quote")
			}
			inWord = true
		case c == '\\':
			if i+1 < len(s) {
				i++
				cur.WriteByte(s[i])
			}
			inWord = true
		default:
			cur.WriteByte(c)
			inWord = true
		}
	}
	if inWord {
		words = append(words, cur.String())
	}
	return words, nil
}
