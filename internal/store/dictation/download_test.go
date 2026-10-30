package dictation_test

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/dictation"
	"github.com/alexwaumann/code-foundry/internal/store/dictation/dictationtest"
)

// modelServer serves body at /test.bin and records the Range headers it saw.
type modelServer struct {
	*httptest.Server
	mu          sync.Mutex
	ranges      []string
	ignoreRange bool
	// status, when set, answers every request with it (a proxy refusing the host).
	status int
	// hold, when set, blocks each response after its first half until closed.
	hold chan struct{}
}

func newModelServer(t *testing.T, body []byte) *modelServer {
	m := &modelServer{}
	m.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		m.mu.Lock()
		m.ranges = append(m.ranges, r.Header.Get("Range"))
		ignore, hold, status := m.ignoreRange, m.hold, m.status
		m.mu.Unlock()
		if status != 0 {
			http.Error(w, http.StatusText(status), status)
			return
		}
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
		{name: "damaged file", serve: bytes.Repeat([]byte{9}, len(body)), wantErr: "Download failed: the downloaded model is damaged (sha256 mismatch)"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			serve := body
			if tc.serve != nil {
				serve = tc.serve
			}
			srv := newModelServer(t, serve)
			srv.ignoreRange = tc.ignoreRange
			m := testModel
			m.Sources = []dictation.Source{{URL: srv.URL + "/test.bin"}}
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
				if s.Error != tc.wantErr || s.Model.Downloaded || s.State != dictation.Disabled {
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
	m.Sources = []dictation.Source{{URL: srv.URL + "/test.bin"}}
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

// testAsset is where the fake gh serves the test model.
var testAsset = dictation.ReleaseAsset{Repo: "o/r", Tag: "models-test", Asset: "test.bin"}

func TestDownloadSources(t *testing.T) {
	body := modelBody()
	damaged := bytes.Repeat([]byte{9}, len(body))
	for _, tc := range []struct {
		name string
		// httpFirst puts the URL source before GitHub.
		httpFirst bool
		gh        dictationtest.Gh
		// httpStatus makes the URL source answer with it (403: a proxy blocking it).
		httpStatus int
		part       []byte
		wantSource string // "gh" or "http": which one sent the bytes that landed
		wantGhRng  []string
		wantHTTP   []string // the URL source's Range headers
		wantErr    string   // {http} is the URL source's label
	}{
		{name: "GitHub first", wantSource: "gh"},
		{name: "GitHub resumes a partial file", part: body[:1000], wantSource: "gh", wantGhRng: []string{"Range: bytes=1000-"}},
		{name: "GitHub ignoring the range starts over", part: body[:1000], gh: dictationtest.Gh{IgnoreRange: true}, wantSource: "gh", wantGhRng: []string{"Range: bytes=1000-"}},
		{name: "no gh falls back", gh: dictationtest.Gh{Missing: true}, wantSource: "http", wantHTTP: []string{""}},
		{name: "gh logged out falls back", gh: dictationtest.Gh{LoggedOut: true}, wantSource: "http", wantHTTP: []string{""}},
		{name: "an asset still uploading falls back", gh: dictationtest.Gh{State: "starter"}, wantSource: "http", wantHTTP: []string{""}},
		{name: "a broken transfer is resumed by the next source", gh: dictationtest.Gh{FailAfter: 1200}, wantSource: "http", wantHTTP: []string{"bytes=1200-"}},
		{name: "a damaged file is not resumed by the next source", gh: dictationtest.Gh{Body: damaged}, wantSource: "http", wantHTTP: []string{""}},
		{name: "a blocked URL falls back to GitHub", httpFirst: true, httpStatus: http.StatusForbidden, wantSource: "gh", wantHTTP: []string{""}},
		{
			name: "every source failing names each", gh: dictationtest.Gh{LoggedOut: true}, httpStatus: http.StatusForbidden, wantHTTP: []string{""},
			wantErr: "Download failed:\nGitHub: gh is not logged in (run gh auth login)\n{http}: the server answered 403 Forbidden",
		},
		{
			name: "both damaged", gh: dictationtest.Gh{Body: damaged}, httpStatus: http.StatusForbidden, wantHTTP: []string{""},
			wantErr: "Download failed:\nGitHub: the downloaded model is damaged (sha256 mismatch)\n{http}: the server answered 403 Forbidden",
		},
		{
			name: "blocked URL then no release", httpFirst: true, httpStatus: http.StatusForbidden, gh: dictationtest.Gh{Asset: dictation.ReleaseAsset{Repo: "o/r", Tag: "other"}}, wantHTTP: []string{""},
			wantErr: "Download failed:\n{http}: the server answered 403 Forbidden\nGitHub: no release models-test in o/r (or no access to it)",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := newModelServer(t, body)
			srv.status = tc.httpStatus
			gh := tc.gh
			if gh.Asset == (dictation.ReleaseAsset{}) {
				gh.Asset = testAsset
			}
			if gh.Body == nil {
				gh.Body = body
			}
			m := testModel
			hf := dictation.Source{URL: srv.URL + "/test.bin"}
			m.Sources = []dictation.Source{{GitHub: &testAsset}, hf}
			if tc.httpFirst {
				m.Sources = []dictation.Source{hf, {GitHub: &testAsset}}
			}
			h := newHarness(t, setup{attended: true, opts: func(o *dictation.Options) { o.Model = m; o.Gh = &gh }})
			if tc.part != nil {
				if err := os.WriteFile(filepath.Join(h.dir, m.Name+".part"), tc.part, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := h.store.Download(); err != nil {
				t.Fatal(err)
			}
			s := h.wait("download end", func(s dictation.Snapshot) bool { return s.State != dictation.Downloading })
			if got := gh.Ranges(); !slices.Equal(got, tc.wantGhRng) {
				t.Errorf("gh ranges %q, want %q", got, tc.wantGhRng)
			}
			if got := srv.seen(); !slices.Equal(got, tc.wantHTTP) {
				t.Errorf("http ranges %q, want %q", got, tc.wantHTTP)
			}
			if tc.wantErr != "" {
				want := strings.ReplaceAll(tc.wantErr, "{http}", hf.Label())
				if s.Error != want || s.Model.Downloaded {
					t.Errorf("error %q, want %q (snapshot %+v)", s.Error, want, s)
				}
				return
			}
			if s.Error != "" || !s.Model.Downloaded {
				t.Fatalf("snapshot %+v", s)
			}
			got, err := os.ReadFile(filepath.Join(h.dir, m.Name))
			if err != nil || !bytes.Equal(got, body) {
				t.Fatalf("model on disk: %v (%d bytes)", err, len(got))
			}
			if served := len(srv.seen()) > 0 && tc.httpStatus == 0; (tc.wantSource == "http") != served {
				t.Errorf("served by http %v, want %s", served, tc.wantSource)
			}
		})
	}
}

func TestDownloadGitHubCancelAndResume(t *testing.T) {
	body := modelBody()
	gh := &dictationtest.Gh{Asset: testAsset, Body: body, Hold: make(chan struct{})}
	m := testModel
	m.Sources = []dictation.Source{{GitHub: &testAsset}, {URL: "http://invalid/test.bin"}}
	h := newHarness(t, setup{attended: true, opts: func(o *dictation.Options) { o.Model = m; o.Gh = gh }})
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
	s = h.store.CancelDownload()
	if s.State != dictation.Disabled || s.Model.Download != nil || s.Error != "" {
		t.Errorf("after cancel %+v", s)
	}
	part, err := os.ReadFile(filepath.Join(h.dir, m.Name+".part"))
	if err != nil || len(part) != len(body)/2 {
		t.Errorf("part kept for resume: %v (%d bytes)", err, len(part))
	}
	// The cancel did not fall through to the next source.
	if calls := gh.Calls(); len(calls) != 2 {
		t.Errorf("gh calls %q", calls)
	}
	close(gh.Hold)
	if _, err := h.store.Download(); err != nil {
		t.Fatal(err)
	}
	h.wait("downloaded", func(s dictation.Snapshot) bool { return s.Model.Downloaded })
	if got := gh.Ranges(); !slices.Equal(got, []string{"Range: bytes=1500-"}) {
		t.Errorf("ranges %q", got)
	}
	if want := []string{"api", "--include", "-H", "Accept: application/octet-stream", "-H", "Range: bytes=1500-", "repos/o/r/releases/assets/7"}; !slices.Equal(gh.Calls()[3], want) {
		t.Errorf("transfer args %q", gh.Calls()[3])
	}
}
