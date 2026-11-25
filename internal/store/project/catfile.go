package project

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/alexwaumann/code-foundry/internal/fsx"
)

const (
	// defaultCatFileIdleTimeout is how long an idle `git cat-file --batch-command` worker
	// stays alive before the reaper shuts it down.
	defaultCatFileIdleTimeout = 45 * time.Second
	// maxCatFileWorkersPerRepo caps idle workers kept per repository. Four covers two
	// concurrent CompareFile calls (Old + New in parallel) without spawning new workers.
	maxCatFileWorkersPerRepo = 4
	// maxCatFileTotalIdle caps idle workers across all registered repositories.
	maxCatFileTotalIdle = 16
	// catFileStderrCap bounds captured stderr from a batch worker.
	catFileStderrCap = 4 << 10
)

// execRunnerOf unwraps r when it is an ExecRunner (value or pointer). Custom test runners
// (fakes, auditRunner, countingRunner) return false so they keep using g.runner.Run.
func execRunnerOf(r Runner) (ExecRunner, bool) {
	switch v := r.(type) {
	case ExecRunner:
		return v, true
	case *ExecRunner:
		if v != nil {
			return *v, true
		}
	}
	return ExecRunner{}, false
}

// catFilePool manages bounded, idle-reaped `git cat-file --batch-command -Z` workers
// keyed by repository directory.
type catFilePool struct {
	runner      ExecRunner
	idleTimeout time.Duration
	now         func() time.Time

	mu        sync.Mutex
	closed    bool
	repos     map[string]*catFileRepo
	reapTimer *time.Timer
}

type catFileRepo struct {
	idle []*catFileWorker
}

type catFileInfo struct {
	oid     string
	kind    string // "blob", "tree", "commit", "tag", "submodule"
	size    int64
	missing bool
}

type catFileWorker struct {
	repoDir      string
	partialClone bool
	cmd          *exec.Cmd
	pid          int
	stdinPipe    io.WriteCloser
	stdin        *bufio.Writer
	stdout       *bufio.Reader
	idleSince    time.Time

	mu      sync.Mutex
	killed  bool
	closing bool
}

// cappedBuffer holds up to max bytes without blocking writers once full.
type cappedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
	max int
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	if rem := b.max - b.buf.Len(); rem > 0 {
		b.buf.Write(p[:min(len(p), rem)])
	}
	b.mu.Unlock()
	return len(p), nil
}

func newCatFilePool(runner ExecRunner, now func() time.Time) *catFilePool {
	if now == nil {
		now = time.Now
	}
	return &catFilePool{
		runner:      runner,
		idleTimeout: defaultCatFileIdleTimeout,
		now:         now,
		repos:       map[string]*catFileRepo{},
	}
}

// readRevSide reads file at rev through a pooled cat-file worker. When fallback is true,
// the caller should fall back to ls-tree + cat-file via g.runner.Run (for partial clones
// where missing promisor objects need git's stderr to produce objectsMissing).
func (p *catFilePool) readRevSide(ctx context.Context, repoDir, commonDir, rev, file string) (v FileVersion, fallback bool, err error) {
	if err := ctx.Err(); err != nil {
		return FileVersion{}, false, err
	}
	spec := rev + ":" + file
	err = p.withWorker(ctx, repoDir, commonDir, func(w *catFileWorker) error {
		info, ierr := w.info(spec)
		if ierr != nil {
			return ierr
		}
		if info.missing {
			if w.partialClone {
				fallback = true
			}
			v = FileVersion{}
			return nil
		}
		switch info.kind {
		case "submodule", "commit":
			v = submoduleVersion(info.oid)
			return nil
		case "blob":
			if info.size > blobReadMax {
				v = FileVersion{Present: true, Truncated: true}
				return nil
			}
			bv, berr := w.readBlob(info.oid)
			if berr != nil {
				return berr
			}
			v = bv
			return nil
		default:
			v = FileVersion{}
			return nil
		}
	})
	return v, fallback, err
}

// readBlobByOID reads a blob by its object ID (for SourceStaged). When fallback is true,
// the object was reported missing and the caller should fall back to g.runner.Run so
// partial-clone or missing-object errors are reported accurately.
func (p *catFilePool) readBlobByOID(ctx context.Context, repoDir, commonDir, oid string) (v FileVersion, fallback bool, err error) {
	if err := ctx.Err(); err != nil {
		return FileVersion{}, false, err
	}
	err = p.withWorker(ctx, repoDir, commonDir, func(w *catFileWorker) error {
		info, ierr := w.info(oid)
		if ierr != nil {
			return ierr
		}
		if info.missing || info.kind != "blob" {
			fallback = true
			return nil
		}
		if info.size > blobReadMax {
			v = FileVersion{Present: true, Truncated: true}
			return nil
		}
		bv, berr := w.readBlob(info.oid)
		if berr != nil {
			return berr
		}
		v = bv
		return nil
	})
	return v, fallback, err
}

// withWorker acquires an idle worker (or spawns one), runs fn with ctx cancellation wired
// to kill the worker, retries once on a broken pooled worker, and returns healthy workers
// to the pool.
func (p *catFilePool) withWorker(ctx context.Context, repoDir, commonDir string, fn func(*catFileWorker) error) error {
	for attempt := range 2 {
		w, reused, err := p.acquire(repoDir, commonDir)
		if err != nil {
			return err
		}
		stop := context.AfterFunc(ctx, w.kill)
		fnErr := fn(w)
		stopped := stop()
		if fnErr == nil && stopped && ctx.Err() == nil {
			p.release(w)
			return nil
		}
		w.close()
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		if !stopped {
			return context.Canceled
		}
		if reused && attempt == 0 {
			// A pooled worker died (broken pipe / EOF); retry once with a fresh worker.
			continue
		}
		return fnErr
	}
	return nil
}

func (p *catFilePool) acquire(repoDir, commonDir string) (w *catFileWorker, reused bool, err error) {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return nil, false, context.Canceled
	}
	if repo := p.repos[repoDir]; repo != nil && len(repo.idle) > 0 {
		last := len(repo.idle) - 1
		w = repo.idle[last]
		repo.idle[last] = nil
		repo.idle = repo.idle[:last]
		if len(repo.idle) == 0 {
			delete(p.repos, repoDir)
		}
		p.mu.Unlock()
		return w, true, nil
	}
	p.mu.Unlock()
	w, err = p.spawn(repoDir, commonDir)
	return w, false, err
}

func (p *catFilePool) release(w *catFileWorker) {
	var evict []*catFileWorker
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		w.close()
		return
	}
	w.idleSince = p.now()
	repo := p.repos[w.repoDir]
	if repo == nil {
		repo = &catFileRepo{}
		p.repos[w.repoDir] = repo
	}
	if len(repo.idle) >= maxCatFileWorkersPerRepo {
		// Pool for this repo is full; close the returning worker.
		p.mu.Unlock()
		w.close()
		return
	}
	repo.idle = append(repo.idle, w)
	// Enforce global idle cap by evicting the oldest idle worker across all repos.
	for p.totalIdleLocked() > maxCatFileTotalIdle {
		if old := p.evictOldestLocked(); old != nil {
			evict = append(evict, old)
		} else {
			break
		}
	}
	p.scheduleReaperLocked()
	p.mu.Unlock()
	for _, old := range evict {
		old.close()
	}
}

func (p *catFilePool) totalIdleLocked() int {
	total := 0
	for _, repo := range p.repos {
		total += len(repo.idle)
	}
	return total
}

func (p *catFilePool) evictOldestLocked() *catFileWorker {
	var (
		oldestDir string
		oldestIdx int
		oldest    *catFileWorker
	)
	for dir, repo := range p.repos {
		for i, w := range repo.idle {
			if oldest == nil || w.idleSince.Before(oldest.idleSince) {
				oldest, oldestDir, oldestIdx = w, dir, i
			}
		}
	}
	if oldest == nil {
		return nil
	}
	repo := p.repos[oldestDir]
	copy(repo.idle[oldestIdx:], repo.idle[oldestIdx+1:])
	repo.idle[len(repo.idle)-1] = nil
	repo.idle = repo.idle[:len(repo.idle)-1]
	if len(repo.idle) == 0 {
		delete(p.repos, oldestDir)
	}
	return oldest
}

func (p *catFilePool) scheduleReaperLocked() {
	if p.closed || p.idleTimeout <= 0 {
		return
	}
	var earliest time.Time
	for _, repo := range p.repos {
		for _, w := range repo.idle {
			if earliest.IsZero() || w.idleSince.Before(earliest) {
				earliest = w.idleSince
			}
		}
	}
	if earliest.IsZero() {
		if p.reapTimer != nil {
			p.reapTimer.Stop()
			p.reapTimer = nil
		}
		return
	}
	wait := max(earliest.Add(p.idleTimeout).Sub(p.now()), time.Millisecond)
	if p.reapTimer == nil {
		p.reapTimer = time.AfterFunc(wait, p.reap)
	} else {
		p.reapTimer.Reset(wait)
	}
}

func (p *catFilePool) reap() {
	var expired []*catFileWorker
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	cutoff := p.now().Add(-p.idleTimeout)
	for dir, repo := range p.repos {
		keep := repo.idle[:0]
		for _, w := range repo.idle {
			if !w.idleSince.After(cutoff) {
				expired = append(expired, w)
			} else {
				keep = append(keep, w)
			}
		}
		for i := len(keep); i < len(repo.idle); i++ {
			repo.idle[i] = nil
		}
		repo.idle = keep
		if len(repo.idle) == 0 {
			delete(p.repos, dir)
		}
	}
	if p.reapTimer != nil {
		p.reapTimer.Stop()
		p.reapTimer = nil
	}
	p.scheduleReaperLocked()
	p.mu.Unlock()
	for _, w := range expired {
		w.close()
	}
}

// closeRepo shuts down all idle workers for repoDir (called on Unregister).
func (p *catFilePool) closeRepo(repoDir string) {
	p.mu.Lock()
	repo := p.repos[repoDir]
	delete(p.repos, repoDir)
	p.mu.Unlock()
	if repo == nil {
		return
	}
	for _, w := range repo.idle {
		w.close()
	}
}

// close shuts down every idle worker and stops the reaper (called on Git.Close).
func (p *catFilePool) close() {
	p.mu.Lock()
	p.closed = true
	if p.reapTimer != nil {
		p.reapTimer.Stop()
		p.reapTimer = nil
	}
	var all []*catFileWorker
	for dir, repo := range p.repos {
		all = append(all, repo.idle...)
		delete(p.repos, dir)
	}
	p.mu.Unlock()
	for _, w := range all {
		w.close()
	}
}

// idleCount reports how many idle workers are currently pooled (for tests).
func (p *catFilePool) idleCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.totalIdleLocked()
}

func (p *catFilePool) spawn(repoDir, commonDir string) (*catFileWorker, error) {
	bin := p.runner.Git
	if bin == "" {
		bin = "git"
	}
	var env []string
	if p.runner.guardedEnv != nil {
		env = p.runner.guardedEnv
	} else {
		env = append(gitEnv(os.Environ()), "GIT_NO_LAZY_FETCH=1")
	}
	args := []string{
		"-c", "core.fsmonitor=false",
		"-c", "diff.autoRefreshIndex=false",
		"cat-file", "--batch-command", "-Z",
	}
	cmd := exec.Command(bin, args...)
	cmd.Dir = repoDir
	cmd.Env = env
	// Own process group / session matching ExecRunner: no controlling terminal and clean
	// group kill on shutdown or cancellation.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	cmd.Stderr = &cappedBuffer{max: catFileStderrCap}

	stdinPipe, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("project: cat-file stdin pipe: %w", err)
	}
	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdinPipe.Close()
		return nil, fmt.Errorf("project: cat-file stdout pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		_ = stdinPipe.Close()
		_ = stdoutPipe.Close()
		return nil, fmt.Errorf("project: start cat-file batch: %w", err)
	}
	if commonDir == "" {
		commonDir = filepath.Join(repoDir, ".git")
	}
	return &catFileWorker{
		repoDir:      repoDir,
		partialClone: isPartialClone(commonDir),
		cmd:          cmd,
		pid:          cmd.Process.Pid,
		stdinPipe:    stdinPipe,
		stdin:        bufio.NewWriterSize(stdinPipe, 4<<10),
		stdout:       bufio.NewReaderSize(stdoutPipe, 64<<10),
	}, nil
}

// isPartialClone reports whether the repository at commonDir has a promisor remote
// configured (a partial clone, e.g. --filter=blob:none or --filter=tree:0).
func isPartialClone(commonDir string) bool {
	if commonDir == "" {
		return false
	}
	cfg, err := os.ReadFile(filepath.Join(commonDir, "config"))
	if err != nil {
		return false
	}
	return bytes.Contains(bytes.ToLower(cfg), []byte("promisor"))
}

// kill terminates the worker's process group unless close has already started. Because
// cmd.Wait only runs after closing is set under w.mu, kill never signals a reaped PID.
func (w *catFileWorker) kill() {
	w.mu.Lock()
	if w.closing || w.killed {
		w.mu.Unlock()
		return
	}
	w.killed = true
	_ = killGroup(w.pid)
	w.mu.Unlock()
}

// close terminates the worker's process group, closes stdin, and reaps the child so no
// zombie processes are ever left behind.
func (w *catFileWorker) close() {
	w.mu.Lock()
	if w.closing {
		w.mu.Unlock()
		return
	}
	w.closing = true
	if !w.killed {
		w.killed = true
		_ = killGroup(w.pid)
	}
	w.mu.Unlock()
	_ = w.stdinPipe.Close()
	_ = w.cmd.Wait()
}

// info runs `info <spec>\0` and parses the NUL-terminated response header.
func (w *catFileWorker) info(spec string) (catFileInfo, error) {
	if _, err := w.stdin.WriteString("info "); err != nil {
		return catFileInfo{}, err
	}
	if _, err := w.stdin.WriteString(spec); err != nil {
		return catFileInfo{}, err
	}
	if err := w.stdin.WriteByte(0); err != nil {
		return catFileInfo{}, err
	}
	if err := w.stdin.Flush(); err != nil {
		return catFileInfo{}, err
	}
	header, err := w.stdout.ReadString(0)
	if err != nil {
		return catFileInfo{}, err
	}
	header = strings.TrimSuffix(header, "\x00")
	return parseCatFileHeader(header, spec)
}

func parseCatFileHeader(header, spec string) (catFileInfo, error) {
	if header == spec+" missing" || header == spec+" ambiguous" || strings.HasSuffix(header, " missing") || strings.HasSuffix(header, " ambiguous") {
		return catFileInfo{missing: true}, nil
	}
	f := strings.Fields(header)
	if len(f) == 2 && f[1] == "submodule" && isSHA(f[0]) {
		return catFileInfo{oid: f[0], kind: "submodule"}, nil
	}
	if len(f) == 3 && isSHA(f[0]) {
		size, err := strconv.ParseInt(f[2], 10, 64)
		if err != nil {
			return catFileInfo{}, fmt.Errorf("project: cat-file header %q: %w", header, err)
		}
		return catFileInfo{oid: f[0], kind: f[1], size: size}, nil
	}
	return catFileInfo{}, fmt.Errorf("project: unexpected cat-file header %q", header)
}

// readBlob runs `contents <oid>\0`, keeping at most FileDiffMax bytes and draining any
// remainder directly into io.Discard so large blobs never spike daemon memory.
func (w *catFileWorker) readBlob(oid string) (FileVersion, error) {
	if _, err := w.stdin.WriteString("contents "); err != nil {
		return FileVersion{}, err
	}
	if _, err := w.stdin.WriteString(oid); err != nil {
		return FileVersion{}, err
	}
	if err := w.stdin.WriteByte(0); err != nil {
		return FileVersion{}, err
	}
	if err := w.stdin.Flush(); err != nil {
		return FileVersion{}, err
	}
	header, err := w.stdout.ReadString(0)
	if err != nil {
		return FileVersion{}, err
	}
	header = strings.TrimSuffix(header, "\x00")
	info, err := parseCatFileHeader(header, oid)
	if err != nil {
		return FileVersion{}, err
	}
	if info.missing || info.kind != "blob" {
		return FileVersion{}, errors.New("project: cat-file contents missing blob " + oid)
	}
	keep := min(info.size, int64(FileDiffMax))
	buf := make([]byte, keep)
	if _, err := io.ReadFull(w.stdout, buf); err != nil {
		return FileVersion{}, err
	}
	if rem := info.size - keep; rem > 0 {
		if _, err := io.CopyN(io.Discard, w.stdout, rem); err != nil {
			return FileVersion{}, err
		}
	}
	// Consume the NUL delimiter that `-Z` appends after the object payload.
	delim, err := w.stdout.ReadByte()
	if err != nil {
		return FileVersion{}, err
	}
	if delim != 0 {
		return FileVersion{}, fmt.Errorf("project: cat-file expected NUL delimiter, got %d", delim)
	}
	return FileVersion{
		Present:   true,
		Contents:  buf,
		Truncated: info.size > FileDiffMax,
		Binary:    fsx.LooksBinary(buf),
	}, nil
}
