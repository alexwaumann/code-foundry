// Package textsearch searches the contents of a thread's checkouts with the shipped
// ripgrep (FilesystemService.SearchText). It searches exactly the files file search lists
// (fsx.FileIndex.Files: git's view plus the included ignored files, or the walk), handing
// ripgrep their paths, so a file is findable by name and by contents, or by neither. See
// docs/notes/file-search-4-text-rpc.md.
package textsearch

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/alexwaumann/code-foundry/internal/fsx"
	"github.com/alexwaumann/code-foundry/internal/ripgrep"
)

// Limits bound one search.
type Limits struct {
	// FileLines is the most lines sent for one file.
	FileLines int
	// CountLines is how far a file's matching lines are counted (File.LineCount).
	CountLines int
	// TotalLines is the most lines sent for one search.
	TotalLines int
	// LineChars is the most code points of a line sent (a longer one is cut around its
	// first match).
	LineChars int
	// Timeout bounds the search; it then ends with what it found (Summary.TimedOut).
	Timeout time.Duration
}

// DefaultLimits are the daemon's.
var DefaultLimits = Limits{FileLines: 50, CountLines: 999, TotalLines: 2000, LineChars: 300, Timeout: 15 * time.Second}

// File is a file with matches.
type File struct {
	// Source indexes the sources passed to Search.
	Source int
	// Path is relative to the source's checkout.
	Path string
	// Ignored: git ignores the file and an include pattern brought it in.
	Ignored bool
	// Lines are the file's matching lines, in order: at most Limits.FileLines, fewer when
	// the search's Limits.TotalLines ran out in this file.
	Lines []Line
	// LineCount is how many lines of the file match, at most Limits.CountLines;
	// LineCountCapped: more do.
	LineCount       int
	LineCountCapped bool
}

// Summary ends a search.
type Summary struct {
	// Lines and Files are what was sent.
	Lines, Files int
	// FileCapped: some file has more matching lines than were sent for it
	// (Limits.FileLines). TotalCapped: the search stopped at Limits.TotalLines, with
	// files left unsearched or lines unsent. TimedOut: it stopped at Limits.Timeout.
	FileCapped, TotalCapped, TimedOut bool
	// CaseSensitive is how the query matched (Query.CaseSensitive).
	CaseSensitive bool
	Elapsed       time.Duration
}

// Truncated: there may be matches the search did not send.
func (s Summary) Truncated() bool { return s.FileCapped || s.TotalCapped || s.TimedOut }

const (
	// firstChunk is how many files the first ripgrep searches, so the first results come
	// fast; each next chunk is chunkGrowth times larger, up to maxChunk files or
	// maxChunkBytes of paths (the argument list's limit is 1 MiB with the environment).
	firstChunk    = 128
	chunkGrowth   = 4
	maxChunk      = 8192
	maxChunkBytes = 256 << 10
	// inFlight is how many ripgreps run at once: the next chunk is searched while the
	// last one's results are sent. Each ripgrep uses every core on its own.
	inFlight = 2
)

// errTimeout is the cause of a search's own deadline.
var errTimeout = errors.New("text search timed out")

// Searcher runs text searches. Safe for concurrent use.
type Searcher struct {
	files  *fsx.FileIndex
	engine *ripgrep.Engine
	limits Limits
	log    *slog.Logger
	// pids hears each ripgrep's process id (tests).
	pids func(int)
}

// New returns a Searcher over files' lists (the index file search uses, so both share
// its cache) running engine's ripgrep. A nil log discards.
func New(files *fsx.FileIndex, engine *ripgrep.Engine, log *slog.Logger) *Searcher {
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	return &Searcher{files: files, engine: engine, limits: DefaultLimits, log: log}
}

// Search looks for q in every file of sources, calling emit with each batch of files
// with matches as it is ready: files in search order (sources in the order given, a
// source's files by path), each file whole in one batch. It returns the summary when every
// file was searched or a limit stopped it; a timeout is not an error. Errors:
// ErrInvalidQuery, ripgrep.ErrMissing or ErrBroken, ctx's error when ctx ends, emit's
// error, or a checkout that cannot be listed. Every ripgrep it started has exited when it
// returns.
func (s *Searcher) Search(ctx context.Context, sources []fsx.Source, q Query, emit func([]File) error) (sum Summary, err error) {
	start := time.Now()
	sum.CaseSensitive = q.CaseSensitive()
	defer func() { sum.Elapsed = time.Since(start) }()
	if err := q.check(); err != nil {
		return sum, err
	}
	if q.Text == "" || len(sources) == 0 {
		return sum, nil
	}
	bin, _, err := s.engine.Get()
	if err != nil {
		return sum, err
	}
	parent := ctx
	ctx, cancel := context.WithTimeoutCause(ctx, s.limits.Timeout, errTimeout)
	defer cancel()
	timedOut := func() bool { return parent.Err() == nil && errors.Is(context.Cause(ctx), errTimeout) }
	args := rgArgs(q, s.limits)

	// A regular expression ripgrep cannot compile fails before any file is searched; check
	// it while the checkouts are listed.
	regexErr := make(chan error, 1)
	if q.Regex {
		go func() { regexErr <- checkRegex(ctx, bin.Path, args, q.Text) }()
	} else {
		regexErr <- nil
	}
	lists, listErr := s.files.Files(ctx, sources)
	if err := <-regexErr; err != nil && ctx.Err() == nil {
		return sum, err
	}
	switch {
	case timedOut():
		sum.TimedOut = true
		return sum, nil
	case parent.Err() != nil:
		return sum, parent.Err()
	case listErr != nil:
		return sum, listErr
	}

	chunks := plan(sources, lists)
	runCtx, stop := context.WithCancel(ctx)
	results := make([]chan chunkResult, len(chunks))
	for i := range results {
		results[i] = make(chan chunkResult, 1)
	}
	slots := make(chan struct{}, inFlight)
	var wg sync.WaitGroup
	wg.Go(func() {
		for i, ch := range chunks {
			select {
			case slots <- struct{}{}:
			case <-runCtx.Done():
			}
			if runCtx.Err() != nil {
				results[i] <- chunkResult{err: runCtx.Err()}
				continue
			}
			wg.Go(func() {
				r := runChunk(runCtx, bin.Path, args, ch, s.limits, s.pids)
				r.launched = true
				results[i] <- r
			})
		}
	})
	defer func() { // every ripgrep has exited before Search returns
		stop()
		wg.Wait()
	}()

	for i := range chunks {
		r := <-results[i]
		if r.launched {
			<-slots
		}
		batch, full := s.take(&sum, r.files)
		if len(batch) > 0 {
			if err := emit(batch); err != nil {
				stop()
				return sum, err
			}
		}
		if full {
			sum.TotalCapped = sum.TotalCapped || i < len(chunks)-1
			stop()
			break
		}
		if r.err != nil {
			stop()
			switch {
			case timedOut():
				sum.TimedOut = true
				s.log.Debug("text search timed out", "files", sum.Files, "lines", sum.Lines)
				return sum, nil
			case parent.Err() != nil:
				return sum, parent.Err()
			default:
				return sum, r.err
			}
		}
	}
	return sum, nil
}

// take is the files of a chunk the search sends, counted into sum: all of them until the
// search's TotalLines, the file there cut. full: no more lines can be sent.
func (s *Searcher) take(sum *Summary, files []File) (batch []File, full bool) {
	for _, f := range files {
		room := s.limits.TotalLines - sum.Lines
		if room <= 0 {
			sum.TotalCapped = true
			return batch, true
		}
		if f.LineCount > len(f.Lines) {
			sum.FileCapped = true
		}
		if len(f.Lines) > room {
			f.Lines = f.Lines[:room]
			sum.TotalCapped = true
		}
		sum.Files++
		sum.Lines += len(f.Lines)
		batch = append(batch, f)
	}
	return batch, sum.Lines >= s.limits.TotalLines
}

// plan cuts every source's files, in order, into chunks: firstChunk files, then each
// chunkGrowth times more, up to maxChunk files and maxChunkBytes of paths.
func plan(sources []fsx.Source, lists [][]fsx.FileEntry) []chunk {
	var out []chunk
	size, order := firstChunk, 0
	for si, files := range lists {
		for len(files) > 0 {
			n, nb := 0, 0
			for n < len(files) && n < size && (n == 0 || nb+len(files[n].Path)+1 <= maxChunkBytes) {
				nb += len(files[n].Path) + 1
				n++
			}
			out = append(out, chunk{source: si, dir: sources[si].Dir, files: files[:n], first: order})
			order += n
			files = files[n:]
			size = min(size*chunkGrowth, maxChunk)
		}
	}
	return out
}

// checkRegex compiles the pattern with ripgrep, over no file: ErrInvalidQuery with
// ripgrep's reason when it cannot.
func checkRegex(ctx context.Context, bin string, args []string, pattern string) error {
	cmd := exec.CommandContext(ctx, bin, append(args, "--", os.DevNull)...)
	cmd.Env = append(os.Environ(), "RIPGREP_CONFIG_PATH=")
	cmd.WaitDelay = waitDelay
	stderr := &capped{max: maxStderr}
	cmd.Stderr = stderr
	err := cmd.Run()
	var exit *exec.ExitError
	switch {
	case err == nil, ctx.Err() != nil:
		return nil
	case errors.As(err, &exit) && exit.ExitCode() == 1: // compiled; no match in nothing
		return nil
	case errors.As(err, &exit) && exit.ExitCode() == 2:
		return regexError(pattern, stderr.String())
	default:
		return fmt.Errorf("ripgrep: %w", err)
	}
}
