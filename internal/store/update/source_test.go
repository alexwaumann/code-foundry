package update_test

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/gh"
	"github.com/alexwaumann/code-foundry/internal/store/update"
)

func TestParseChannel(t *testing.T) {
	tests := []struct {
		in   string
		want update.Channel
	}{
		{"stable", update.ChannelStable},
		{"tip", update.ChannelTip},
		{"", update.ChannelStable},
		{"nightly", update.ChannelStable},
	}
	for _, tt := range tests {
		if got := update.ParseChannel(tt.in); got != tt.want {
			t.Errorf("ParseChannel(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestHighestTag(t *testing.T) {
	tests := []struct {
		name   string
		tags   []string
		want   string
		wantOK bool
	}{
		{"none", nil, "", false},
		{"only junk", []string{"latest", "nightly"}, "", false},
		{"tip above its stable", []string{"v0.14.41", "v0.14.42-tip.1"}, "v0.14.42-tip.1", true},
		{"base moved: counter keeps climbing", []string{"v0.14.42-tip.1", "v0.15.0-tip.2", "v0.15.0-tip.3", "v0.14.41"}, "v0.15.0-tip.3", true},
		{"promoted stable wins over its tips", []string{"v0.15.0-tip.3", "v0.15.0", "v0.15.0-tip.2"}, "v0.15.0", true},
		{"numeric counter, not lexical", []string{"v0.15.0-tip.9", "v0.15.0-tip.10"}, "v0.15.0-tip.10", true},
		{"junk skipped", []string{"dev", "v0.2.0", "v0.10.0", "garbage"}, "v0.10.0", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := update.HighestTag(tt.tags)
			if got != tt.want || ok != tt.wantOK {
				t.Fatalf("HighestTag(%v) = %q, %v; want %q, %v", tt.tags, got, ok, tt.want, tt.wantOK)
			}
		})
	}
}

func TestDirSource(t *testing.T) {
	tests := []struct {
		name          string
		latest, tip   string // file contents; "" = no file
		ch            update.Channel
		want          string
		wantNoRelease bool
	}{
		{"stable: no files", "", "", update.ChannelStable, "", true},
		{"tip: no files", "", "", update.ChannelTip, "", true},
		{"stable reads latest", "v0.3.0\n", "v0.3.1-tip.2\n", update.ChannelStable, "v0.3.0", false},
		{"tip reads latest-tip", "v0.3.0\n", "v0.3.1-tip.2\n", update.ChannelTip, "v0.3.1-tip.2", false},
		{"tip without latest-tip falls back to latest", "v0.3.0\n", "", update.ChannelTip, "v0.3.0", false},
		{"stable without latest has no release", "", "v0.3.1-tip.2\n", update.ChannelStable, "", true},
		{"tip without latest", "", "v0.3.1-tip.2\n", update.ChannelTip, "v0.3.1-tip.2", false},
		{"tip: a stable promoted after the last tip wins", "v0.3.1\n", "v0.3.1-tip.2\n", update.ChannelTip, "v0.3.1", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			for name, body := range map[string]string{"latest": tt.latest, "latest-tip": tt.tip} {
				if body == "" {
					continue
				}
				if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			got, err := update.DirSource{Dir: dir}.Latest(context.Background(), tt.ch)
			if tt.wantNoRelease {
				if !errors.Is(err, update.ErrNoRelease) {
					t.Fatalf("Latest = %q, %v; want ErrNoRelease", got, err)
				}
				return
			}
			if err != nil || got != tt.want {
				t.Fatalf("Latest = %q, %v; want %q", got, err, tt.want)
			}
		})
	}
}

type fakeTokens struct {
	mu     sync.Mutex
	tokens []string
	err    error
	calls  int
}

func (f *fakeTokens) Token(context.Context) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if f.err != nil {
		return "", f.err
	}
	if len(f.tokens) == 0 {
		return "", gh.ErrNoToken
	}
	tok := f.tokens[0]
	if len(f.tokens) > 1 {
		f.tokens = f.tokens[1:]
	}
	return tok, nil
}

func (f *fakeTokens) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func TestGhSource(t *testing.T) {
	tests := []struct {
		name          string
		ch            update.Channel
		status        int
		body          string
		wantPath      string
		want          string
		wantNoRelease bool
		wantErr       string
	}{
		{
			name:     "stable asks releases/latest",
			ch:       update.ChannelStable,
			status:   http.StatusOK,
			body:     `{"tag_name":"v0.14.41","draft":false}`,
			wantPath: "/repos/o/n/releases/latest",
			want:     "v0.14.41",
		},
		{
			name:   "tip lists non-draft releases and takes the highest",
			ch:     update.ChannelTip,
			status: http.StatusOK,
			body: `[
				{"tag_name":"v0.16.0-tip.1","draft":true},
				{"tag_name":"v0.15.0-tip.3","draft":false},
				{"tag_name":"v0.15.0-tip.2","draft":false},
				{"tag_name":"v0.14.42-tip.1","draft":false},
				{"tag_name":"v0.14.41","draft":false}
			]`,
			wantPath: "/repos/o/n/releases?per_page=20",
			want:     "v0.15.0-tip.3",
		},
		{
			name:   "tip: a promoted stable wins",
			ch:     update.ChannelTip,
			status: http.StatusOK,
			body: `[
				{"tag_name":"v0.15.0","draft":false},
				{"tag_name":"v0.15.0-tip.3","draft":false},
				{"tag_name":"v0.14.41","draft":false}
			]`,
			want: "v0.15.0",
		},
		{
			name:          "tip: no releases",
			ch:            update.ChannelTip,
			status:        http.StatusOK,
			body:          `[]`,
			wantNoRelease: true,
		},
		{
			name:          "stable: 404 means no release",
			ch:            update.ChannelStable,
			status:        http.StatusNotFound,
			body:          `{"message":"Not Found"}`,
			wantNoRelease: true,
		},
		{
			name:    "tip: other errors name the endpoint",
			ch:      update.ChannelTip,
			status:  http.StatusForbidden,
			body:    `{"message":"API rate limit exceeded"}`,
			wantErr: "github api repos/o/n/releases: API rate limit exceeded (HTTP 403)",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var gotURI, gotAuth, gotUA string
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotURI = r.RequestURI
				gotAuth = r.Header.Get("Authorization")
				gotUA = r.Header.Get("User-Agent")
				w.WriteHeader(tt.status)
				_, _ = w.Write([]byte(tt.body))
			}))
			defer srv.Close()

			src := &update.GhSource{
				Repo:      "o/n",
				BaseURL:   srv.URL,
				Tokens:    &fakeTokens{tokens: []string{"secret-tok"}},
				UserAgent: "code-foundry/test",
			}
			got, err := src.Latest(context.Background(), tt.ch)
			switch {
			case tt.wantNoRelease:
				if !errors.Is(err, update.ErrNoRelease) {
					t.Fatalf("Latest = %q, %v; want ErrNoRelease", got, err)
				}
			case tt.wantErr != "":
				if err == nil || err.Error() != tt.wantErr {
					t.Fatalf("err = %v, want %q", err, tt.wantErr)
				}
			default:
				if err != nil || got != tt.want {
					t.Fatalf("Latest = %q, %v; want %q", got, err, tt.want)
				}
			}
			if tt.wantPath != "" && gotURI != tt.wantPath {
				t.Errorf("request URI = %q, want %q", gotURI, tt.wantPath)
			}
			if gotAuth != "Bearer secret-tok" {
				t.Errorf("Authorization = %q, want Bearer secret-tok", gotAuth)
			}
			if gotUA != "code-foundry/test" {
				t.Errorf("User-Agent = %q, want code-foundry/test", gotUA)
			}
		})
	}
}

func TestGhSourceETagCache(t *testing.T) {
	var (
		mu         sync.Mutex
		etag       = `W/"etag-v1"`
		stableTag  = "v0.15.0"
		tipTag     = "v0.15.1-tip.2"
		notModHits int
		fullHits   int
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		curETag, curStable, curTip := etag, stableTag, tipTag
		mu.Unlock()

		if r.Header.Get("If-None-Match") == curETag {
			mu.Lock()
			notModHits++
			mu.Unlock()
			w.WriteHeader(http.StatusNotModified)
			return
		}
		mu.Lock()
		fullHits++
		mu.Unlock()
		w.Header().Set("ETag", curETag)
		if strings.HasSuffix(r.URL.Path, "/releases/latest") {
			fmt.Fprintf(w, `{"tag_name":%q}`, curStable)
			return
		}
		fmt.Fprintf(w, `[{"tag_name":%q,"draft":false}]`, curTip)
	}))
	defer srv.Close()

	src := &update.GhSource{
		Repo:    "o/n",
		BaseURL: srv.URL,
		Tokens:  &fakeTokens{tokens: []string{"tok"}},
	}
	ctx := context.Background()

	// Stable: miss -> 200, then hit -> 304, then updated -> 200.
	if got, err := src.Latest(ctx, update.ChannelStable); err != nil || got != "v0.15.0" {
		t.Fatalf("stable 1 = %q, %v", got, err)
	}
	if got, err := src.Latest(ctx, update.ChannelStable); err != nil || got != "v0.15.0" {
		t.Fatalf("stable 2 (304) = %q, %v", got, err)
	}

	// Tip: miss -> 200, then hit -> 304.
	if got, err := src.Latest(ctx, update.ChannelTip); err != nil || got != "v0.15.1-tip.2" {
		t.Fatalf("tip 1 = %q, %v", got, err)
	}
	if got, err := src.Latest(ctx, update.ChannelTip); err != nil || got != "v0.15.1-tip.2" {
		t.Fatalf("tip 2 (304) = %q, %v", got, err)
	}

	// Publish a newer release: ETag changes, server returns 200 with new tag.
	mu.Lock()
	etag = `W/"etag-v2"`
	stableTag = "v0.16.0"
	mu.Unlock()
	if got, err := src.Latest(ctx, update.ChannelStable); err != nil || got != "v0.16.0" {
		t.Fatalf("stable 3 (updated) = %q, %v", got, err)
	}

	mu.Lock()
	gotNotMod, gotFull := notModHits, fullHits
	mu.Unlock()
	if gotNotMod != 2 || gotFull != 3 {
		t.Errorf("304 hits = %d (want 2), 200 hits = %d (want 3)", gotNotMod, gotFull)
	}
}

func TestGhSourceTipPagination(t *testing.T) {
	t.Run("stops after page 1 when release found", func(t *testing.T) {
		var requests atomic.Int32
		var srv *httptest.Server
		srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			requests.Add(1)
			w.Header().Set("Link", fmt.Sprintf(`<%s/repos/o/n/releases?per_page=20&page=2>; rel="next"`, srv.URL))
			_, _ = w.Write([]byte(`[{"tag_name":"v0.15.0-tip.4","draft":false},{"tag_name":"v0.15.0-tip.3","draft":false}]`))
		}))
		defer srv.Close()

		src := &update.GhSource{Repo: "o/n", BaseURL: srv.URL, Tokens: &fakeTokens{tokens: []string{"tok"}}}
		got, err := src.Latest(context.Background(), update.ChannelTip)
		if err != nil || got != "v0.15.0-tip.4" {
			t.Fatalf("Latest = %q, %v", got, err)
		}
		if n := requests.Load(); n != 1 {
			t.Errorf("HTTP requests = %d, want 1 (must not paginate all releases)", n)
		}
	})

	t.Run("pages further only when page 1 has no usable release", func(t *testing.T) {
		var requests atomic.Int32
		var srv *httptest.Server
		srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			n := requests.Add(1)
			if r.URL.Query().Get("page") == "2" {
				_, _ = w.Write([]byte(`[{"tag_name":"v0.14.9","draft":false}]`))
				return
			}
			w.Header().Set("ETag", `"p1"`)
			w.Header().Set("Link", fmt.Sprintf(`<%s/repos/o/n/releases?per_page=2&page=2>; rel="next"`, srv.URL))
			if n == 1 {
				_, _ = w.Write([]byte(`[{"tag_name":"v0.15.0-draft","draft":true},{"tag_name":"not-semver","draft":false}]`))
				return
			}
			w.WriteHeader(http.StatusNotModified)
		}))
		defer srv.Close()

		src := &update.GhSource{
			Repo:        "o/n",
			BaseURL:     srv.URL,
			Tokens:      &fakeTokens{tokens: []string{"tok"}},
			TipPageSize: 2,
		}
		got, err := src.Latest(context.Background(), update.ChannelTip)
		if err != nil || got != "v0.14.9" {
			t.Fatalf("Latest = %q, %v", got, err)
		}
		if n := requests.Load(); n != 2 {
			t.Errorf("HTTP requests = %d, want 2", n)
		}
	})
}

func TestGhSourceTokenCacheAndAnonymousFallback(t *testing.T) {
	t.Run("caches token within TTL and refreshes after expiry", func(t *testing.T) {
		now := time.Unix(1_700_000_000, 0)
		tokens := &fakeTokens{tokens: []string{"tok1", "tok2"}}
		var gotAuths []string
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			gotAuths = append(gotAuths, r.Header.Get("Authorization"))
			_, _ = w.Write([]byte(`{"tag_name":"v0.15.0"}`))
		}))
		defer srv.Close()

		src := &update.GhSource{
			Repo:     "o/n",
			BaseURL:  srv.URL,
			Tokens:   tokens,
			TokenTTL: 15 * time.Minute,
			Now:      func() time.Time { return now },
		}
		ctx := context.Background()
		if _, err := src.Latest(ctx, update.ChannelStable); err != nil {
			t.Fatal(err)
		}
		now = now.Add(5 * time.Minute)
		if _, err := src.Latest(ctx, update.ChannelStable); err != nil {
			t.Fatal(err)
		}
		if tokens.count() != 1 {
			t.Fatalf("token lookups within TTL = %d, want 1", tokens.count())
		}
		now = now.Add(11 * time.Minute)
		if _, err := src.Latest(ctx, update.ChannelStable); err != nil {
			t.Fatal(err)
		}
		if tokens.count() != 2 {
			t.Fatalf("token lookups after TTL = %d, want 2", tokens.count())
		}
		wantAuths := []string{"Bearer tok1", "Bearer tok1", "Bearer tok2"}
		if strings.Join(gotAuths, ",") != strings.Join(wantAuths, ",") {
			t.Errorf("auth headers = %v, want %v", gotAuths, wantAuths)
		}
	})

	t.Run("falls back to anonymous on ErrNoToken and caches absence", func(t *testing.T) {
		tokens := &fakeTokens{err: gh.ErrNoToken}
		var sawAuth bool
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authorization") != "" {
				sawAuth = true
			}
			_, _ = w.Write([]byte(`{"tag_name":"v0.15.0"}`))
		}))
		defer srv.Close()

		src := &update.GhSource{Repo: "o/n", BaseURL: srv.URL, Tokens: tokens}
		ctx := context.Background()
		for range 3 {
			got, err := src.Latest(ctx, update.ChannelStable)
			if err != nil || got != "v0.15.0" {
				t.Fatalf("Latest = %q, %v", got, err)
			}
		}
		if sawAuth {
			t.Error("expected anonymous request with no Authorization header")
		}
		if tokens.count() != 1 {
			t.Errorf("token lookups = %d, want 1 (cached anonymous fallback)", tokens.count())
		}
	})

	t.Run("401 retries with fresh token then falls back to anonymous", func(t *testing.T) {
		tokens := &fakeTokens{tokens: []string{"expired-tok", "expired-tok"}}
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authorization") != "" {
				w.WriteHeader(http.StatusUnauthorized)
				_, _ = w.Write([]byte(`{"message":"Bad credentials"}`))
				return
			}
			_, _ = w.Write([]byte(`{"tag_name":"v0.15.0"}`))
		}))
		defer srv.Close()

		src := &update.GhSource{Repo: "o/n", BaseURL: srv.URL, Tokens: tokens}
		got, err := src.Latest(context.Background(), update.ChannelStable)
		if err != nil || got != "v0.15.0" {
			t.Fatalf("Latest = %q, %v; want v0.15.0 via anonymous fallback", got, err)
		}
	})

	t.Run("caches gh auth token subprocess across repeated checks", func(t *testing.T) {
		dir := t.TempDir()
		countFile := filepath.Join(dir, "count")
		bin := filepath.Join(dir, "gh")
		script := "#!/bin/sh\necho x >> '" + countFile + "'\necho fake-cli-token\n"
		if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authorization") != "Bearer fake-cli-token" {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			_, _ = w.Write([]byte(`{"tag_name":"v0.15.0"}`))
		}))
		defer srv.Close()

		src := &update.GhSource{Repo: "o/n", Gh: bin, BaseURL: srv.URL}
		ctx := context.Background()
		for range 3 {
			if got, err := src.Latest(ctx, update.ChannelStable); err != nil || got != "v0.15.0" {
				t.Fatalf("Latest = %q, %v", got, err)
			}
		}
		b, err := os.ReadFile(countFile)
		if err != nil {
			t.Fatal(err)
		}
		if lines := len(strings.Fields(string(b))); lines != 1 {
			t.Errorf("gh auth token invoked %d times across 3 checks, want 1", lines)
		}
	})
}

func BenchmarkGhSourceETag304(b *testing.B) {
	const etag = `W/"bench-etag"`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("If-None-Match") == etag {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("ETag", etag)
		_, _ = w.Write([]byte(`[{"tag_name":"v0.15.0-tip.4","draft":false}]`))
	}))
	defer srv.Close()

	src := &update.GhSource{
		Repo:    "o/n",
		BaseURL: srv.URL,
		Tokens:  &fakeTokens{tokens: []string{"tok"}},
	}
	ctx := context.Background()
	// Prime ETag + keep-alive connection.
	if got, err := src.Latest(ctx, update.ChannelTip); err != nil || got != "v0.15.0-tip.4" {
		b.Fatalf("prime: %q, %v", got, err)
	}

	b.ResetTimer()
	for range b.N {
		got, err := src.Latest(ctx, update.ChannelTip)
		if err != nil || got != "v0.15.0-tip.4" {
			b.Fatalf("Latest: %q, %v", got, err)
		}
	}
}
