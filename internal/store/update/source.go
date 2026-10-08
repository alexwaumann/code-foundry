package update

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/gh"
)

// ErrNoRelease means the repository has no published release. A check that gets it is
// successful and finds nothing to install.
var ErrNoRelease = errors.New("no published release")

// Source reports the latest release tag.
type Source interface {
	// Latest returns the tag of the latest release, e.g. "v0.2.0", as published (it is
	// validated by the caller).
	Latest(ctx context.Context) (string, error)
	// NotesURL returns the release page for tag.
	NotesURL(tag string) string
}

// sourceTimeout bounds one latest-release lookup.
const sourceTimeout = 30 * time.Second

// GhSource asks GitHub through the user's authenticated gh:
// `gh api repos/<repo>/releases/latest --jq .tag_name`. Works for private repositories
// the user can read.
type GhSource struct {
	// Repo is "owner/name".
	Repo string
	// Gh is the gh executable; gh.LookPath() when empty.
	Gh string
}

// Latest implements Source.
func (s GhSource) Latest(ctx context.Context) (string, error) {
	path := s.Gh
	if path == "" {
		var err error
		if path, err = gh.LookPath(); err != nil {
			return "", err
		}
	}
	ctx, cancel := context.WithTimeout(ctx, sourceTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "api", "repos/"+s.Repo+"/releases/latest", "--jq", ".tag_name")
	cmd.Env = append(os.Environ(), "GH_PROMPT_DISABLED=1", "GH_NO_UPDATE_NOTIFIER=1", "NO_COLOR=1", "GH_PAGER=")
	cmd.WaitDelay = 2 * time.Second
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return "", fmt.Errorf("gh api releases/latest: %w", ctxErr)
		}
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			msg := firstLine(stderr.String())
			if strings.Contains(msg, "HTTP 404") {
				// No published release yet (GitHub also says 404 for a repository the
				// user cannot see).
				return "", fmt.Errorf("%w in %s (or no access)", ErrNoRelease, s.Repo)
			}
			if msg == "" {
				msg = firstLine(stdout.String())
			}
			return "", fmt.Errorf("gh api repos/%s/releases/latest: %s", s.Repo, strings.TrimPrefix(msg, "gh: "))
		}
		return "", fmt.Errorf("run gh: %w", err)
	}
	return strings.TrimSpace(stdout.String()), nil
}

// NotesURL implements Source.
func (s GhSource) NotesURL(tag string) string {
	return "https://github.com/" + s.Repo + "/releases/tag/" + tag
}

// DirSource reads a local release directory (see version.EnvReleaseDir): the latest tag
// is the content of <Dir>/latest.
type DirSource struct {
	Dir string
}

// Latest implements Source.
func (s DirSource) Latest(context.Context) (string, error) {
	b, err := os.ReadFile(filepath.Join(s.Dir, "latest"))
	if errors.Is(err, os.ErrNotExist) {
		return "", fmt.Errorf("%w in %s", ErrNoRelease, s.Dir)
	}
	if err != nil {
		return "", fmt.Errorf("read latest release: %w", err)
	}
	return strings.TrimSpace(string(b)), nil
}

// NotesURL implements Source.
func (s DirSource) NotesURL(tag string) string {
	return "file://" + filepath.Join(s.Dir, tag) + "/"
}

func firstLine(s string) string {
	line, _, _ := strings.Cut(strings.TrimSpace(s), "\n")
	return strings.TrimSpace(line)
}
