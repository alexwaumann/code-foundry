package marketplace

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Commit is the newest commit touching a directory.
type Commit struct {
	SHA string
	At  time.Time
}

// History is what one `git log --name-only` pass over a checkout says: the newest commit
// touching each directory (every ancestor of every path any commit changed).
type History struct {
	Head string
	// Shallow is a shallow clone (Claude Code clones marketplaces with --depth 1): every
	// directory last changed before the shallow boundary dates from the boundary commit.
	Shallow bool
	dirs    map[string]Commit
}

// Dir is the newest commit touching dir (repo-relative, slash-separated; "" or "." for
// the whole checkout).
func (h *History) Dir(dir string) (Commit, bool) {
	if h == nil {
		return Commit{}, false
	}
	c, ok := h.dirs[cleanRel(dir)]
	return c, ok
}

// ErrNotGit is a checkout that is not a git work tree (Claude Code downloads some
// marketplaces instead of cloning them): its entries have no dates.
var ErrNotGit = errors.New("not a git checkout")

// Git runs git in a checkout and reads its history, caching it by HEAD: a read of an
// unchanged checkout costs one `git rev-parse`.
type Git struct {
	// Path is the git executable; "git" (from PATH) when empty.
	Path string

	mu    sync.Mutex
	cache map[string]*History // by checkout dir
}

// History returns dir's history, from the cache while HEAD is unchanged. A checkout
// that is not a git work tree is ErrNotGit.
func (g *Git) History(ctx context.Context, dir string) (*History, error) {
	rp, err := g.run(ctx, dir, "rev-parse", "--show-toplevel", "--is-shallow-repository", "HEAD")
	if err != nil {
		return nil, err
	}
	lines := strings.Split(strings.TrimSpace(string(rp)), "\n")
	if len(lines) != 3 {
		return nil, fmt.Errorf("git rev-parse in %s: unexpected output %q", dir, rp)
	}
	// A checkout inside someone else's work tree (a dotfiles repo holding ~/.claude) is
	// not a checkout of its own.
	if !sameDir(lines[0], dir) {
		return nil, fmt.Errorf("%s: %w (inside %s)", dir, ErrNotGit, lines[0])
	}
	shallow, sha := lines[1] == "true", lines[2]
	g.mu.Lock()
	h := g.cache[dir]
	g.mu.Unlock()
	if h != nil && h.Head == sha && h.Shallow == shallow {
		return h, nil
	}
	out, err := g.run(ctx, dir, "-c", "core.quotePath=false", "log", "--no-renames", "--format=%x01%H%x00%cI", "--name-only", sha)
	if err != nil {
		return nil, err
	}
	h, err = parseLog(out)
	if err != nil {
		return nil, fmt.Errorf("git log in %s: %w", dir, err)
	}
	h.Head, h.Shallow = sha, shallow
	g.mu.Lock()
	if g.cache == nil {
		g.cache = map[string]*History{}
	}
	g.cache[dir] = h
	g.mu.Unlock()
	return h, nil
}

// Unshallow fetches the rest of a shallow checkout's history (`git fetch --unshallow`),
// so its per-directory dates are true. It needs the network; the store runs it only on
// Refresh.
func (g *Git) Unshallow(ctx context.Context, dir string) error {
	_, err := g.run(ctx, dir, "fetch", "--quiet", "--unshallow")
	return err
}

func (g *Git) run(ctx context.Context, dir string, args ...string) ([]byte, error) {
	bin := g.Path
	if bin == "" {
		bin = "git"
	}
	cmd := exec.CommandContext(ctx, bin, append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_OPTIONAL_LOCKS=0", "LC_ALL=C")
	cmd.WaitDelay = 2 * time.Second
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, fmt.Errorf("git %s: %w", args[0], ctxErr)
		}
		msg := strings.TrimSpace(stderr.String())
		if strings.Contains(msg, "not a git repository") {
			return nil, fmt.Errorf("%s: %w", dir, ErrNotGit)
		}
		line, _, _ := strings.Cut(msg, "\n")
		return nil, fmt.Errorf("git %s in %s: %s: %w", strings.Join(args, " "), dir, line, err)
	}
	return stdout.Bytes(), nil
}

// parseLog reads `git log --format=%x01%H%x00%cI --name-only` output. Each record is a
// line "\x01<sha>\x00<committer date>" followed by the paths it changed. A directory's
// commit is the newest (by committer date; the first seen on a tie) among the commits
// changing anything under it.
func parseLog(out []byte) (*History, error) {
	h := &History{dirs: map[string]Commit{}}
	var cur Commit
	sc := bufio.NewScanner(bytes.NewReader(out))
	sc.Buffer(make([]byte, 64<<10), 4<<20)
	for sc.Scan() {
		line := sc.Text()
		if rest, ok := strings.CutPrefix(line, "\x01"); ok {
			sha, date, ok := strings.Cut(rest, "\x00")
			if !ok {
				return nil, fmt.Errorf("bad commit line %q", line)
			}
			at, err := time.Parse(time.RFC3339, date)
			if err != nil {
				return nil, fmt.Errorf("commit %s: %w", sha, err)
			}
			cur = Commit{SHA: sha, At: at}
			continue
		}
		if line == "" || cur.SHA == "" {
			continue
		}
		for d := path.Dir(line); ; d = path.Dir(d) {
			if prev, ok := h.dirs[d]; !ok || cur.At.After(prev.At) {
				h.dirs[d] = cur
			}
			if d == "." {
				break
			}
		}
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	return h, nil
}

// sameDir reports whether a and b name the same directory, symlinks resolved (macOS's
// /tmp is /private/tmp).
func sameDir(a, b string) bool {
	ra, errA := filepath.EvalSymlinks(a)
	rb, errB := filepath.EvalSymlinks(b)
	if errA != nil || errB != nil {
		return filepath.Clean(a) == filepath.Clean(b)
	}
	return ra == rb
}

// cleanRel is a repo-relative path in the form History keys it: slash-separated, no
// "./", "." for the root.
func cleanRel(p string) string {
	p = path.Clean(strings.TrimPrefix(p, "./"))
	if p == "" || p == "/" {
		return "."
	}
	return p
}
