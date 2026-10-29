package dictation_test

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/dictation"
)

// modelServer serves body at /test.bin and records the Range headers it saw.
type modelServer struct {
	*httptest.Server
	mu          sync.Mutex
	ranges      []string
	ignoreRange bool
	// hold, when set, blocks each response after its first half until closed.
	hold chan struct{}
}

func newModelServer(t *testing.T, body []byte) *modelServer {
	m := &modelServer{}
	m.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		m.mu.Lock()
		m.ranges = append(m.ranges, r.Header.Get("Range"))
		ignore, hold := m.ignoreRange, m.hold
		m.mu.Unlock()
		if ignore {
			r.Header.Del("Range")
		}
		if hold != nil {
			w.Header().Set("Content-Length", strconv.Itoa(len(body)))
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(body[:len(body)/2])
			w.(http.Flusher).Flush()
			select {
			case <-hold:
			case <-r.Context().Done():
				return
			}
			_, _ = w.Write(body[len(body)/2:])
			return
		}
		http.ServeContent(w, r, "test.bin", time.Unix(0, 0), bytes.NewReader(body))
	}))
	t.Cleanup(m.Close)
	return m
}

func (m *modelServer) seen() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]string(nil), m.ranges...)
}

func TestDownload(t *testing.T) {
	body := modelBody()
	for _, tc := range []struct {
		name        string
		part        []byte // a partial download already on disk
		ignoreRange bool
		serve       []byte // what the server has (default body)
		wantRange   string
		wantErr     string
	}{
		{name: "fresh", wantRange: ""},
		{name: "resumes a partial file", part: body[:1000], wantRange: "bytes=1000-"},
		{name: "server without ranges starts over", part: body[:1000], ignoreRange: true, wantRange: "bytes=1000-"},
		{name: "a too long part starts over", part: append(append([]byte{}, body...), 1, 2, 3), wantRange: ""},
		{name: "damaged file", serve: bytes.Repeat([]byte{9}, len(body)), wantErr: "sha256 mismatch"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			serve := body
			if tc.serve != nil {
				serve = tc.serve
			}
			srv := newModelServer(t, serve)
			srv.ignoreRange = tc.ignoreRange
			m := testModel
			m.URL = srv.URL + "/test.bin"
			h := newHarness(t, setup{attended: true, opts: func(o *dictation.Options) { o.Model = m }})
			if tc.part != nil {
				if err := os.WriteFile(filepath.Join(h.dir, m.Name+".part"), tc.part, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := h.store.Download(); err != nil {
				t.Fatal(err)
			}
			s := h.wait("download end", func(s dictation.Snapshot) bool { return s.State != dictation.Downloading })
			if got := srv.seen(); len(got) != 1 || got[0] != tc.wantRange {
				t.Errorf("ranges %q, want [%q]", got, tc.wantRange)
			}
			if tc.wantErr != "" {
				if !strings.Contains(s.Error, tc.wantErr) || s.Model.Downloaded || s.State != dictation.Disabled {
					t.Errorf("snapshot %+v", s)
				}
				if _, err := os.Stat(filepath.Join(h.dir, m.Name+".part")); !os.IsNotExist(err) {
					t.Errorf("damaged part kept: %v", err)
				}
				if h.enables.Load() != 0 {
					t.Error("turned on after a failure")
				}
				return
			}
			got, err := os.ReadFile(filepath.Join(h.dir, m.Name))
			if err != nil || !bytes.Equal(got, body) {
				t.Fatalf("model on disk: %v (%d bytes)", err, len(got))
			}
			if h.enables.Load() != 1 {
				t.Errorf("Enable called %d times", h.enables.Load())
			}
			// The download turned dictation on: the engine starts.
			h.waitState(dictation.Ready)
			if _, err := h.store.Download(); err == nil {
				t.Error("Download with the model there succeeded")
			}
		})
	}
}

func TestDownloadProgressAndCancel(t *testing.T) {
	body := modelBody()
	srv := newModelServer(t, body)
	srv.hold = make(chan struct{})
	m := testModel
	m.URL = srv.URL + "/test.bin"
	h := newHarness(t, setup{attended: true, opts: func(o *dictation.Options) { o.Model = m }})
	if _, err := h.store.Download(); err != nil {
		t.Fatal(err)
	}
	s := h.waitState(dictation.Downloading)
	if s.Model.Download == nil || s.Model.Download.Total != int64(len(body)) {
		t.Errorf("snapshot %+v", s)
	}
	h.wait("half on disk", func(dictation.Snapshot) bool {
		fi, err := os.Stat(filepath.Join(h.dir, m.Name+".part"))
		return err == nil && fi.Size() == int64(len(body)/2)
	})
	// A second Download leaves the first running.
	if _, err := h.store.Download(); err != nil {
		t.Error(err)
	}
	s = h.store.CancelDownload()
	if s.State != dictation.Disabled || s.Model.Download != nil || s.Error != "" {
		t.Errorf("after cancel %+v", s)
	}
	part, err := os.ReadFile(filepath.Join(h.dir, m.Name+".part"))
	if err != nil || len(part) != len(body)/2 {
		t.Errorf("part kept for resume: %v (%d bytes)", err, len(part))
	}
	close(srv.hold)
	srv.mu.Lock()
	srv.hold = nil
	srv.mu.Unlock()
	if _, err := h.store.Download(); err != nil {
		t.Fatal(err)
	}
	h.wait("downloaded", func(s dictation.Snapshot) bool { return s.Model.Downloaded })
	if got := srv.seen(); got[len(got)-1] != "bytes=1500-" {
		t.Errorf("ranges %q", got)
	}
}
