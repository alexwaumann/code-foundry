package dictation

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"time"
)

// partSuffix marks a download in progress: <model>.part, renamed to the model once it
// is whole and verified. A cancelled or interrupted download leaves it for the next one
// to resume with a byte range.
const partSuffix = ".part"

// progressEvery bounds how often a download reports progress (4 a second).
const progressEvery = 250 * time.Millisecond

// ErrChecksum is a downloaded file whose sha256 is not the registry's. The partial file
// is deleted, so the next download starts over.
var ErrChecksum = errors.New("the downloaded model is damaged (sha256 mismatch)")

// Progress is a running download's progress.
type Progress struct {
	Received, Total int64
	// BytesPerSecond is the recent speed; 0 until known.
	BytesPerSecond int64
}

// fetcher downloads one model into a file, resuming a partial one.
type fetcher struct {
	client *http.Client
	now    func() time.Time
	// progress is called at most every progressEvery, and once more at the end.
	progress func(Progress)
}

// fetch downloads m to dest: into dest.part (resumed from its length with a Range
// request when the server honours it), verified against m.SHA256, then renamed to dest.
func (f fetcher) fetch(ctx context.Context, m Model, dest string) error {
	part := dest + partSuffix
	file, err := os.OpenFile(part, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return fmt.Errorf("open %s: %w", part, err)
	}
	defer func() { _ = file.Close() }()
	have, err := file.Seek(0, io.SeekEnd)
	if err != nil {
		return fmt.Errorf("seek %s: %w", part, err)
	}
	if have > m.Size {
		have = 0
	}
	if have < m.Size {
		if have, err = f.get(ctx, m, file, have); err != nil {
			return err
		}
	}
	if have != m.Size {
		return fmt.Errorf("download ended at %d of %d bytes", have, m.Size)
	}
	if err := verify(file, m.SHA256); err != nil {
		_ = file.Close()
		_ = os.Remove(part)
		return err
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close %s: %w", part, err)
	}
	if err := os.Rename(part, dest); err != nil {
		return fmt.Errorf("rename %s: %w", part, err)
	}
	return nil
}

// get requests the bytes from have on and appends them to file, returning the length
// reached. A server that ignores the range sends the whole file, which replaces what
// file had.
func (f fetcher) get(ctx context.Context, m Model, file *os.File, have int64) (int64, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, m.URL, nil)
	if err != nil {
		return have, err
	}
	if have > 0 {
		req.Header.Set("Range", "bytes="+strconv.FormatInt(have, 10)+"-")
	}
	res, err := f.client.Do(req)
	if err != nil {
		return have, fmt.Errorf("download %s: %w", m.Name, err)
	}
	defer func() { _ = res.Body.Close() }()
	switch {
	case res.StatusCode == http.StatusPartialContent && have > 0:
	case res.StatusCode == http.StatusOK:
		have = 0
	case res.StatusCode == http.StatusRequestedRangeNotSatisfiable:
		// What we hold does not fit the file the server has: start over next time.
		_ = file.Truncate(0)
		return 0, fmt.Errorf("download %s: the server refused to resume; try again", m.Name)
	default:
		return have, fmt.Errorf("download %s: %s", m.Name, res.Status)
	}
	if err := file.Truncate(have); err != nil {
		return have, fmt.Errorf("truncate: %w", err)
	}
	if _, err := file.Seek(have, io.SeekStart); err != nil {
		return have, fmt.Errorf("seek: %w", err)
	}
	meter := newMeter(f.now, have, m.Size, f.progress)
	buf := make([]byte, 256<<10)
	for {
		n, rerr := res.Body.Read(buf)
		if n > 0 {
			if have+int64(n) > m.Size {
				return have, fmt.Errorf("download %s: the server sent more than %d bytes", m.Name, m.Size)
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
			return have, fmt.Errorf("download %s: %w", m.Name, rerr)
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
