package dictation

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// partSuffix marks a download in progress: <model>.part, renamed to the model once it
// is whole and verified. A cancelled or interrupted download leaves it for the next one
// (or the next source) to resume with a byte range.
const partSuffix = ".part"

// progressEvery bounds how often a download reports progress (4 a second).
const progressEvery = 250 * time.Millisecond

// findAssetTimeout bounds the GitHub release lookup before a download.
const findAssetTimeout = 30 * time.Second

// ErrChecksum is a downloaded file whose sha256 is not the registry's. The partial file
// is emptied, so the next source (or the next download) starts over.
var ErrChecksum = errors.New("the downloaded model is damaged (sha256 mismatch)")

var errResumeRefused = errors.New("the server refused to resume the partial download; try again")

// Progress is a running download's progress.
type Progress struct {
	Received, Total int64
	// BytesPerSecond is the recent speed; 0 until known.
	BytesPerSecond int64
}

// DownloadError is a download no source completed. Its message is what the snapshot
// shows: "Download failed: " and each source's failure, on a line of its own when there
// are several.
type DownloadError struct {
	Failures []SourceFailure
}

// SourceFailure is why one source did not serve the model.
type SourceFailure struct {
	// Source is the source's Label.
	Source string
	Err    error
}

func (e *DownloadError) Error() string {
	if len(e.Failures) == 1 {
		return "Download failed: " + e.Failures[0].Err.Error()
	}
	var b strings.Builder
	b.WriteString("Download failed:")
	for _, f := range e.Failures {
		b.WriteString("\n" + f.Source + ": " + f.Err.Error())
	}
	return b.String()
}

func (e *DownloadError) Unwrap() []error {
	errs := make([]error, len(e.Failures))
	for i, f := range e.Failures {
		errs[i] = f.Err
	}
	return errs
}

// fetcher downloads one model into a file from its sources, resuming a partial one.
type fetcher struct {
	client *http.Client
	gh     GhRunner
	log    *slog.Logger
	now    func() time.Time
	// progress is called at most every progressEvery, and once more at the end of
	// each source's transfer.
	progress func(Progress)
}

// fetch downloads m to dest: into dest.part, from each source in turn until one
// completes it (each resumes what the last left), verified against m.SHA256, then
// renamed to dest. It returns the label of the source that completed it; a
// *DownloadError when none did.
func (f fetcher) fetch(ctx context.Context, m Model, dest string) (string, error) {
	if len(m.Sources) == 0 {
		return "", fmt.Errorf("%s has no download source", m.Name)
	}
	part := dest + partSuffix
	file, err := os.OpenFile(part, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return "", fmt.Errorf("open %s: %w", part, err)
	}
	defer func() { _ = file.Close() }()
	var failures []SourceFailure
	for _, src := range m.Sources {
		err := f.fetchFrom(ctx, src, m, file)
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		if err == nil {
			if err := file.Close(); err != nil {
				return "", fmt.Errorf("close %s: %w", part, err)
			}
			if err := os.Rename(part, dest); err != nil {
				return "", fmt.Errorf("rename %s: %w", part, err)
			}
			return src.Label(), nil
		}
		if errors.Is(err, ErrGhNotFound) || errors.Is(err, errGhLoggedOut) {
			f.log.Info("skipping a dictation model source", "source", src.Label(), "reason", err)
		} else {
			f.log.Warn("dictation model source failed", "source", src.Label(), "err", err)
		}
		failures = append(failures, SourceFailure{Source: src.Label(), Err: err})
	}
	if fi, err := file.Stat(); err == nil && fi.Size() == 0 {
		_ = file.Close()
		_ = os.Remove(part)
	}
	return "", &DownloadError{Failures: failures}
}

// fetchFrom completes file from src, resuming what it holds, and verifies it. A
// damaged file is emptied, so the next source starts over rather than trust any of it.
func (f fetcher) fetchFrom(ctx context.Context, src Source, m Model, file *os.File) error {
	have, err := file.Seek(0, io.SeekEnd)
	if err != nil {
		return fmt.Errorf("seek: %w", err)
	}
	if have > m.Size {
		have = 0
	}
	if have < m.Size {
		f.log.Info("downloading the dictation model", "source", src.Label(), "from_byte", have)
		if src.GitHub != nil {
			have, err = f.fromGitHub(ctx, *src.GitHub, m, file, have)
		} else {
			have, err = f.fromURL(ctx, src.URL, m, file, have)
		}
		if err != nil {
			return err
		}
	}
	if have != m.Size {
		return fmt.Errorf("the download ended at %d of %d bytes", have, m.Size)
	}
	if err := verify(file, m.SHA256); err != nil {
		if !errors.Is(err, ErrChecksum) {
			return err
		}
		f.log.Warn("dictation model damaged", "source", src.Label(), "err", err)
		if err := file.Truncate(0); err != nil {
			return fmt.Errorf("truncate: %w", err)
		}
		return ErrChecksum
	}
	return nil
}

// fromURL requests the bytes from have on and appends them to file, returning the
// length reached. A server that ignores the range sends the whole file, which replaces
// what file had.
func (f fetcher) fromURL(ctx context.Context, rawURL string, m Model, file *os.File, have int64) (int64, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return have, err
	}
	if have > 0 {
		req.Header.Set("Range", "bytes="+strconv.FormatInt(have, 10)+"-")
	}
	res, err := f.client.Do(req)
	if err != nil {
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err
		}
		return have, fmt.Errorf("could not connect: %w", err)
	}
	defer func() { _ = res.Body.Close() }()
	if have, err = begin(file, res.StatusCode, res.Status, have); err != nil {
		return have, err
	}
	return f.receive(res.Body, file, have, m)
}

// fromGitHub is fromURL for a release asset, through gh: `gh api` finds the asset's id
// in the release, then `gh api --include` with Accept: application/octet-stream streams
// it (GitHub redirects to its object store, and gh carries the Range header across the
// redirect). The response's status line says whether the range was honoured.
func (f fetcher) fromGitHub(ctx context.Context, a ReleaseAsset, m Model, file *os.File, have int64) (int64, error) {
	if f.gh == nil {
		return have, ErrGhNotFound
	}
	id, err := f.findAsset(ctx, a, m)
	if err != nil {
		return have, err
	}
	args := []string{"api", "--include", "-H", "Accept: application/octet-stream"}
	if have > 0 {
		args = append(args, "-H", "Range: bytes="+strconv.FormatInt(have, 10)+"-")
	}
	args = append(args, "repos/"+a.Repo+"/releases/assets/"+id)
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	pr, pw := io.Pipe()
	ran := make(chan error, 1)
	go func() {
		err := f.gh.Run(ctx, args, pw)
		_ = pw.CloseWithError(err) // nil: the reader sees EOF
		ran <- err
	}()
	have, err = f.receiveGh(bufio.NewReaderSize(pr, 256<<10), file, have, m)
	if err != nil {
		cancel()
	}
	_ = pr.Close() // unblocks gh's writer when we stopped reading early
	<-ran
	if err != nil {
		return have, ghReason(err)
	}
	return have, nil
}

// receiveGh reads gh --include's output: the status line and headers, then the body.
// Reads fail with gh's own error when it exits non-zero.
func (f fetcher) receiveGh(r *bufio.Reader, file *os.File, have int64, m Model) (int64, error) {
	status, text, err := readHead(r)
	if err != nil {
		return have, err
	}
	if have, err = begin(file, status, text, have); err != nil {
		return have, err
	}
	return f.receive(r, file, have, m)
}

// readHead reads an HTTP status line ("HTTP/2.0 206 Partial Content") and the headers
// after it, up to the blank line before the body.
func readHead(r *bufio.Reader) (status int, text string, err error) {
	line, err := r.ReadString('\n')
	if err != nil {
		if errors.Is(err, io.EOF) {
			return 0, "", errors.New("gh printed no response")
		}
		return 0, "", err
	}
	proto, text, _ := strings.Cut(strings.TrimSpace(line), " ")
	code, _, _ := strings.Cut(text, " ")
	if status, err = strconv.Atoi(code); !strings.HasPrefix(proto, "HTTP/") || err != nil {
		return 0, "", fmt.Errorf("unexpected gh output %q", firstLine(line))
	}
	for {
		h, err := r.ReadString('\n')
		if err != nil {
			if errors.Is(err, io.EOF) {
				return 0, "", errors.New("gh's response ended in its headers")
			}
			return 0, "", err
		}
		if strings.TrimRight(h, "\r\n") == "" {
			return status, text, nil
		}
	}
}

// findAsset returns the id of a's file in its release, checking it is whole and of the
// model's size.
func (f fetcher) findAsset(ctx context.Context, a ReleaseAsset, m Model) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, findAssetTimeout)
	defer cancel()
	var out bytes.Buffer
	if err := f.gh.Run(ctx, []string{"api", "repos/" + a.Repo + "/releases/tags/" + a.Tag}, &out); err != nil {
		var ge *GhError
		switch {
		case errors.Is(err, context.DeadlineExceeded):
			return "", fmt.Errorf("GitHub did not answer within %s", findAssetTimeout)
		case errors.As(err, &ge) && strings.Contains(ge.Stderr, "HTTP 404"):
			return "", fmt.Errorf("no release %s in %s (or no access to it)", a.Tag, a.Repo)
		}
		return "", ghReason(err)
	}
	var rel struct {
		Assets []struct {
			ID    int64  `json:"id"`
			Name  string `json:"name"`
			Size  int64  `json:"size"`
			State string `json:"state"`
		} `json:"assets"`
	}
	if err := json.Unmarshal(out.Bytes(), &rel); err != nil {
		return "", fmt.Errorf("read release %s: %w", a.Tag, err)
	}
	for _, as := range rel.Assets {
		if as.Name != a.Asset {
			continue
		}
		switch {
		case as.State != "uploaded":
			return "", fmt.Errorf("%s in release %s is not fully uploaded yet", a.Asset, a.Tag)
		case as.Size != m.Size:
			return "", fmt.Errorf("%s in release %s is %d bytes, not %d", a.Asset, a.Tag, as.Size, m.Size)
		}
		return strconv.FormatInt(as.ID, 10), nil
	}
	return "", fmt.Errorf("release %s has no %s", a.Tag, a.Asset)
}

// begin positions file for a response to a request for the bytes from have on and
// returns where its body goes: a 206 continues at have, a 200 is the whole file and
// starts over. Any other status fails; a 416 (what file holds does not fit the file the
// server has) empties it, so the next attempt starts over.
func begin(file *os.File, status int, text string, have int64) (int64, error) {
	switch {
	case status == http.StatusPartialContent && have > 0:
	case status == http.StatusOK:
		have = 0
	case status == http.StatusRequestedRangeNotSatisfiable:
		_ = file.Truncate(0)
		return 0, errResumeRefused
	default:
		return have, fmt.Errorf("the server answered %s", text)
	}
	if err := file.Truncate(have); err != nil {
		return have, fmt.Errorf("truncate: %w", err)
	}
	if _, err := file.Seek(have, io.SeekStart); err != nil {
		return have, fmt.Errorf("seek: %w", err)
	}
	return have, nil
}

// receive appends body to file from have on, reporting progress, and returns the
// length reached.
func (f fetcher) receive(body io.Reader, file *os.File, have int64, m Model) (int64, error) {
	meter := newMeter(f.now, have, m.Size, f.progress)
	buf := make([]byte, 256<<10)
	for {
		n, rerr := body.Read(buf)
		if n > 0 {
			if have+int64(n) > m.Size {
				return have, fmt.Errorf("the server sent more than %d bytes", m.Size)
			}
			if _, err := file.Write(buf[:n]); err != nil {
				return have, fmt.Errorf("write: %w", err)
			}
			have += int64(n)
			meter.add(have)
		}
		if rerr == io.EOF {
			meter.flush(have)
			return have, nil
		}
		if rerr != nil {
			meter.flush(have)
			return have, fmt.Errorf("the download stopped at %d of %d bytes: %w", have, m.Size, rerr)
		}
	}
}

// verify hashes the whole file and compares it with want (hex).
func verify(file *os.File, want string) error {
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return fmt.Errorf("seek: %w", err)
	}
	h := sha256.New()
	if _, err := io.Copy(h, file); err != nil {
		return fmt.Errorf("hash: %w", err)
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != want {
		return fmt.Errorf("%w: got %s", ErrChecksum, got)
	}
	return nil
}

// meter reports progress at most every progressEvery, with the speed over the last
// interval smoothed.
type meter struct {
	now      func() time.Time
	report   func(Progress)
	total    int64
	last     time.Time
	lastHave int64
	bps      float64
}

func newMeter(now func() time.Time, have, total int64, report func(Progress)) *meter {
	m := &meter{now: now, report: report, total: total, last: now(), lastHave: have}
	m.emit(have)
	return m
}

func (m *meter) add(have int64) {
	t := m.now()
	dt := t.Sub(m.last)
	if dt < progressEvery {
		return
	}
	rate := float64(have-m.lastHave) / dt.Seconds()
	if m.bps == 0 {
		m.bps = rate
	} else {
		m.bps = 0.7*m.bps + 0.3*rate
	}
	m.last, m.lastHave = t, have
	m.emit(have)
}

func (m *meter) flush(have int64) { m.emit(have) }

func (m *meter) emit(have int64) {
	if m.report != nil {
		m.report(Progress{Received: have, Total: m.total, BytesPerSecond: int64(m.bps)})
	}
}
