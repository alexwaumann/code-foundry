package registry

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/gh"
)

// Limits on what is fetched.
const (
	// MaxIndexBytes caps an index.json.
	MaxIndexBytes = 8 << 20
	// MaxDownloadBytes caps a release tarball (and a checksums file).
	MaxDownloadBytes = 256 << 20
	// IndexTimeout bounds reading one index.
	IndexTimeout = 30 * time.Second
	// DownloadTimeout bounds one download.
	DownloadTimeout = 10 * time.Minute
)

// ErrNotFound: the registry has no index.json, or the release or asset does not exist
// (GitHub also says so for a repository the user cannot read).
var ErrNotFound = errors.New("not found")

// Gh runs the gh CLI. ExecGh runs the real one; registrytest.Gh is a fake.
type Gh interface {
	// Run runs `gh args...` and returns its stdout. A failure is a *GhError.
	Run(ctx context.Context, args ...string) ([]byte, error)
}

// GhError is gh exiting non-zero.
type GhError struct {
	Args []string
	// Msg is the first line gh printed on stderr (else stdout).
	Msg string
}

func (e *GhError) Error() string {
	return "gh " + strings.Join(e.Args, " ") + ": " + strings.TrimPrefix(e.Msg, "gh: ")
}

// Is reports ErrNotFound for gh's 404s and "release not found".
func (e *GhError) Is(target error) bool {
	if target != ErrNotFound {
		return false
	}
	m := strings.ToLower(e.Msg)
	return strings.Contains(m, "http 404") || strings.Contains(m, "not found") || strings.Contains(m, "no assets match")
}

// ExecGh runs gh non-interactively with the user's login, as the gh store does.
type ExecGh struct {
	// Path is the gh executable; gh.LookPath() when empty.
	Path string
}

// ghEnv keeps gh non-interactive and its output plain.
var ghEnv = []string{"GH_PROMPT_DISABLED=1", "GH_NO_UPDATE_NOTIFIER=1", "GH_SPINNER_DISABLED=1", "NO_COLOR=1", "CLICOLOR=0", "GH_PAGER="}

// Run implements Gh.
func (g ExecGh) Run(ctx context.Context, args ...string) ([]byte, error) {
	path := g.Path
	if path == "" {
		p, err := gh.LookPath()
		if err != nil {
			return nil, err
		}
		path = p
	}
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Env = append(os.Environ(), ghEnv...)
	cmd.WaitDelay = 2 * time.Second
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, fmt.Errorf("gh %s: %w", strings.Join(args, " "), ctxErr)
		}
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			msg := firstLine(stderr.String())
			if msg == "" {
				msg = firstLine(stdout.String())
			}
			return nil, &GhError{Args: args, Msg: msg}
		}
		return nil, fmt.Errorf("run gh: %w", err)
	}
	return stdout.Bytes(), nil
}

func firstLine(s string) string {
	line, _, _ := strings.Cut(strings.TrimSpace(s), "\n")
	return strings.TrimSpace(line)
}

// Fetcher reads indexes and downloads files: github.com through gh, anything else over
// HTTPS.
type Fetcher struct {
	Gh   Gh
	HTTP *http.Client
}

func (f Fetcher) http() *http.Client {
	if f.HTTP != nil {
		return f.HTTP
	}
	return http.DefaultClient
}

// FetchIndex reads a registry's index.json.
func (f Fetcher) FetchIndex(ctx context.Context, loc Location) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, IndexTimeout)
	defer cancel()
	if loc.Repo != "" {
		out, err := f.Gh.Run(ctx, "api", "-H", "Accept: application/vnd.github.raw+json",
			"repos/"+loc.Repo+"/contents/"+IndexFile)
		if errors.Is(err, ErrNotFound) {
			return nil, fmt.Errorf("%w: no %s in %s (or no access with your gh login)", ErrNotFound, IndexFile, loc.Repo)
		}
		if err != nil {
			return nil, err
		}
		if len(out) > MaxIndexBytes {
			return nil, fmt.Errorf("%s of %s is over %d bytes", IndexFile, loc.Repo, MaxIndexBytes)
		}
		return out, nil
	}
	var buf bytes.Buffer
	if err := f.get(ctx, loc.IndexURL, &buf, MaxIndexBytes); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// Download writes the file at url to dst (created or truncated): a GitHub release asset
// with `gh release download`, anything else with a GET. progress, when set, gets the
// bytes written so far (HTTP only; gh reports nothing).
func (f Fetcher) Download(ctx context.Context, rawURL, dst string, progress func(n int64)) error {
	ctx, cancel := context.WithTimeout(ctx, DownloadTimeout)
	defer cancel()
	if _, err := checkDownloadURL(rawURL); err != nil {
		return fmt.Errorf("download %s: %w", rawURL, err)
	}
	if a, ok := ParseReleaseURL(rawURL); ok {
		if _, err := f.Gh.Run(ctx, "release", "download", a.Tag, "-R", a.Repo, "-p", a.Name, "-O", dst, "--clobber"); err != nil {
			if errors.Is(err, ErrNotFound) {
				return fmt.Errorf("%w: %s in release %s of %s (or no access with your gh login)", ErrNotFound, a.Name, a.Tag, a.Repo)
			}
			return err
		}
		fi, err := os.Stat(dst)
		if err != nil {
			return fmt.Errorf("download %s: %w", a.Name, err)
		}
		if fi.Size() > MaxDownloadBytes {
			return fmt.Errorf("download %s: over %d bytes", a.Name, MaxDownloadBytes)
		}
		return nil
	}
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("download: %w", err)
	}
	w := io.Writer(out)
	if progress != nil {
		w = &progressWriter{w: out, fn: progress}
	}
	err = f.get(ctx, rawURL, w, MaxDownloadBytes)
	if cerr := out.Close(); err == nil && cerr != nil {
		err = fmt.Errorf("download: %w", cerr)
	}
	return err
}

// get GETs url into w, at most limit bytes.
func (f Fetcher) get(ctx context.Context, rawURL string, w io.Writer, limit int64) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return fmt.Errorf("get %s: %w", rawURL, err)
	}
	res, err := f.http().Do(req)
	if err != nil {
		return fmt.Errorf("get %s: %w", rawURL, err)
	}
	defer func() { _ = res.Body.Close() }()
	switch {
	case res.StatusCode == http.StatusNotFound:
		return fmt.Errorf("%w: %s (HTTP 404)", ErrNotFound, rawURL)
	case res.StatusCode != http.StatusOK:
		return fmt.Errorf("get %s: HTTP %d", rawURL, res.StatusCode)
	}
	n, err := io.Copy(w, io.LimitReader(res.Body, limit+1))
	if err != nil {
		return fmt.Errorf("get %s: %w", rawURL, err)
	}
	if n > limit {
		return fmt.Errorf("get %s: over %d bytes", rawURL, limit)
	}
	return nil
}

type progressWriter struct {
	w  io.Writer
	n  int64
	fn func(int64)
}

func (p *progressWriter) Write(b []byte) (int, error) {
	n, err := p.w.Write(b)
	p.n += int64(n)
	p.fn(p.n)
	return n, err
}

// tempFile is a fresh file name in dir.
func tempFile(dir, pattern string) (string, error) {
	f, err := os.CreateTemp(dir, pattern)
	if err != nil {
		return "", err
	}
	name := f.Name()
	_ = f.Close()
	return filepath.Clean(name), nil
}
