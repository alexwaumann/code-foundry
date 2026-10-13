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

// Channel is the release channel the updater follows (the update.channel setting).
type Channel string

// Channels. Stable is a release promoted on purpose (a full GitHub release); tip is the
// newest build of main (a prerelease vX.Y.Z-tip.N published on every push).
const (
	ChannelStable Channel = "stable"
	ChannelTip    Channel = "tip"
)

// ParseChannel maps a setting value to a Channel; anything but "tip" is stable.
func ParseChannel(s string) Channel {
	if Channel(s) == ChannelTip {
		return ChannelTip
	}
	return ChannelStable
}

// Source reports the latest release tag of a channel.
type Source interface {
	// Latest returns the tag of the channel's latest release, e.g. "v0.2.0" or
	// "v0.3.0-tip.4", as published (it is validated by the caller). Stable is the
	// newest full release; tip is the highest version of any published release,
	// prerelease or not, so it is never below stable.
	Latest(ctx context.Context, ch Channel) (string, error)
	// NotesURL returns the release page for tag.
	NotesURL(tag string) string
}

// sourceTimeout bounds one latest-release lookup.
const sourceTimeout = 30 * time.Second

// GhSource asks GitHub through the user's authenticated gh. Stable:
// `gh api repos/<repo>/releases/latest --jq .tag_name` (GitHub's newest non-prerelease,
// non-draft release). Tip: every non-draft release's tag, `gh api --paginate
// repos/<repo>/releases?per_page=100`, of which the highest semver wins. Works for
// private repositories the user can read.
type GhSource struct {
	// Repo is "owner/name".
	Repo string
	// Gh is the gh executable; gh.LookPath() when empty.
	Gh string
}

// Latest implements Source.
func (s GhSource) Latest(ctx context.Context, ch Channel) (string, error) {
	if ch == ChannelTip {
		out, err := s.api(ctx, "releases", "--paginate", "repos/"+s.Repo+"/releases?per_page=100",
			"--jq", ".[] | select(.draft | not) | .tag_name")
		if err != nil {
			return "", err
		}
		tag, ok := HighestTag(strings.Fields(out))
		if !ok {
			return "", fmt.Errorf("%w in %s", ErrNoRelease, s.Repo)
		}
		return tag, nil
	}
	out, err := s.api(ctx, "releases/latest", "repos/"+s.Repo+"/releases/latest", "--jq", ".tag_name")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out), nil
}

// api runs `gh api args...` and returns its stdout. what names the endpoint in errors.
func (s GhSource) api(ctx context.Context, what string, args ...string) (string, error) {
	path := s.Gh
	if path == "" {
		var err error
		if path, err = gh.LookPath(); err != nil {
			return "", err
		}
	}
	ctx, cancel := context.WithTimeout(ctx, sourceTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, append([]string{"api"}, args...)...)
	cmd.Env = append(os.Environ(), "GH_PROMPT_DISABLED=1", "GH_NO_UPDATE_NOTIFIER=1", "NO_COLOR=1", "GH_PAGER=")
	cmd.WaitDelay = 2 * time.Second
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return "", fmt.Errorf("gh api %s: %w", what, ctxErr)
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
			return "", fmt.Errorf("gh api repos/%s/%s: %s", s.Repo, what, strings.TrimPrefix(msg, "gh: "))
		}
		return "", fmt.Errorf("run gh: %w", err)
	}
	return stdout.String(), nil
}

// HighestTag returns the highest version among tags by semver precedence, skipping
// tags that are not versions. ok is false when none is.
func HighestTag(tags []string) (tag string, ok bool) {
	var best Version
	for _, t := range tags {
		v, err := ParseVersion(t)
		if err != nil {
			continue
		}
		if !ok || v.Compare(best) > 0 {
			tag, best, ok = t, v, true
		}
	}
	return tag, ok
}

// NotesURL implements Source.
func (s GhSource) NotesURL(tag string) string {
	return "https://github.com/" + s.Repo + "/releases/tag/" + tag
}

// DirSource reads a local release directory (see version.EnvReleaseDir): the latest
// stable tag is the content of <Dir>/latest, the latest tip tag that of
// <Dir>/latest-tip (scripts/release.sh --local writes both). Like GhSource (and
// install.sh --channel tip), tip is the higher semver of the two, so a stable promoted
// after the last tip wins; a missing file is skipped, and only a directory with
// neither has no tip release.
type DirSource struct {
	Dir string
}

// Latest implements Source.
func (s DirSource) Latest(_ context.Context, ch Channel) (string, error) {
	if ch != ChannelTip {
		return s.read("latest")
	}
	tip, tipErr := s.read("latest-tip")
	stable, stableErr := s.read("latest")
	switch {
	case tipErr != nil && !errors.Is(tipErr, ErrNoRelease):
		return "", tipErr
	case stableErr != nil && !errors.Is(stableErr, ErrNoRelease):
		return "", stableErr
	case tipErr != nil && stableErr != nil:
		return "", fmt.Errorf("%w in %s (no latest-tip or latest)", ErrNoRelease, s.Dir)
	case tipErr != nil:
		return stable, nil
	case stableErr != nil:
		return tip, nil
	}
	if Newer(stable, tip) {
		return stable, nil
	}
	return tip, nil
}

// read returns the tag in <Dir>/name; ErrNoRelease when the file does not exist.
func (s DirSource) read(name string) (string, error) {
	b, err := os.ReadFile(filepath.Join(s.Dir, name))
	if errors.Is(err, os.ErrNotExist) {
		return "", fmt.Errorf("%w in %s (no %s)", ErrNoRelease, s.Dir, name)
	}
	if err != nil {
		return "", fmt.Errorf("read %s: %w", name, err)
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
