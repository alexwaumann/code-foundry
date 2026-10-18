package registry

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

// DefaultTTL is how long a fetched index is used before it is read again.
const DefaultTTL = time.Hour

// Options configures a Client.
type Options struct {
	// CacheDir keeps one file per registry (<sha256 of the URL>.json). Required.
	CacheDir string
	// Fetcher reads indexes; its Gh is required for github.com registries.
	Fetcher Fetcher
	// TTL is how long a cached index is fresh (default DefaultTTL).
	TTL time.Duration
	Now func() time.Time
	Log *slog.Logger
}

// Status is one registry's state after a read.
type Status struct {
	URL string
	// FetchedAt is when the index in use was fetched (zero: none).
	FetchedAt time.Time
	// Cached: the index in use came from the disk cache (fresh, or kept because the
	// fetch failed: then Error is set too).
	Cached bool
	// Error is the last fetch's failure ("" when it worked or was not needed).
	Error string
	// Plugins is how many entries it contributed before merging.
	Plugins int
	// Issues are skipped entries and names an earlier registry already lists.
	Issues []string
}

// Merged is every registry's index merged by name.
type Merged struct {
	// Entries sorted by name; Entry.Registry says which registry each came from.
	Entries []Entry
	// Registries in the setting's order.
	Registries []Status
}

// Entry returns the entry for name.
func (m Merged) Entry(name string) (Entry, bool) {
	i := slices.IndexFunc(m.Entries, func(e Entry) bool { return e.Name == name })
	if i < 0 {
		return Entry{}, false
	}
	return m.Entries[i], true
}

// Fingerprint changes whenever an entry is added, removed, bumped or moves registry.
func (m Merged) Fingerprint() string {
	h := sha256.New()
	for _, e := range m.Entries {
		_, _ = fmt.Fprintf(h, "%s\x00%s\x00%s\x00", e.Name, e.Version, e.Registry)
	}
	return hex.EncodeToString(h.Sum(nil))
}

// Client reads and caches the configured registries. Safe for concurrent use.
type Client struct {
	opts Options

	mu   sync.Mutex
	locs []Location
	// fetchMu serializes fetches so a burst of reads costs one request per registry.
	fetchMu sync.Mutex
}

// NewClient returns a client with no registries (SetLocations sets them).
func NewClient(opts Options) *Client {
	if opts.TTL <= 0 {
		opts.TTL = DefaultTTL
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.Log == nil {
		opts.Log = slog.Default()
	}
	return &Client{opts: opts}
}

// SetLocations replaces the registries; it reports whether they changed.
func (c *Client) SetLocations(locs []Location) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	same := slices.EqualFunc(c.locs, locs, func(a, b Location) bool { return a.URL == b.URL })
	c.locs = slices.Clone(locs)
	return !same
}

// Locations returns the registries in order.
func (c *Client) Locations() []Location {
	c.mu.Lock()
	defer c.mu.Unlock()
	return slices.Clone(c.locs)
}

// cacheFile is what the cache keeps per registry.
type cacheFile struct {
	URL       string          `json:"url"`
	FetchedAt time.Time       `json:"fetchedAt"`
	Index     json.RawMessage `json:"index"`
}

func (c *Client) cachePath(url string) string {
	sum := sha256.Sum256([]byte(url))
	return filepath.Join(c.opts.CacheDir, hex.EncodeToString(sum[:8])+".json")
}

func (c *Client) readCache(url string) (cacheFile, bool) {
	data, err := os.ReadFile(c.cachePath(url))
	if err != nil {
		return cacheFile{}, false
	}
	var cf cacheFile
	if json.Unmarshal(data, &cf) != nil || cf.URL != url || len(cf.Index) == 0 {
		return cacheFile{}, false
	}
	return cf, true
}

func (c *Client) writeCache(cf cacheFile) error {
	if err := os.MkdirAll(c.opts.CacheDir, 0o700); err != nil {
		return err
	}
	data, err := json.Marshal(cf)
	if err != nil {
		return err
	}
	tmp, err := tempFile(c.opts.CacheDir, ".tmp-*")
	if err != nil {
		return err
	}
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, c.cachePath(cf.URL)); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// Read returns the merged index. A registry whose cached index is younger than the TTL
// is read from the cache unless refresh; any other is fetched, and when that fails its
// cached index (however old) is used and the failure reported in its Status. Read never
// fails as a whole: a registry that cannot be read contributes nothing and says why.
func (c *Client) Read(ctx context.Context, refresh bool) Merged {
	return c.read(ctx, func(cf cacheFile, ok bool) bool {
		return refresh || !ok || c.opts.Now().Sub(cf.FetchedAt) >= c.opts.TTL
	})
}

// Cached returns the merged index from the disk cache only, however old (no network):
// what the daemon knows at start.
func (c *Client) Cached() Merged {
	return c.read(context.Background(), func(cacheFile, bool) bool { return false })
}

func (c *Client) read(ctx context.Context, fetch func(cf cacheFile, ok bool) bool) Merged {
	locs := c.Locations()
	c.fetchMu.Lock()
	defer c.fetchMu.Unlock()
	out := Merged{Entries: []Entry{}, Registries: make([]Status, 0, len(locs))}
	byName := map[string]int{}
	for _, loc := range locs {
		st := Status{URL: loc.URL}
		cf, ok := c.readCache(loc.URL)
		fetched := false
		if fetch(cf, ok) {
			data, err := c.opts.Fetcher.FetchIndex(ctx, loc)
			if err == nil {
				if _, _, perr := Parse(data); perr != nil {
					err = perr
				}
			}
			if err != nil {
				st.Error = err.Error()
				c.opts.Log.Warn("plugin registry: fetch failed", "registry", loc.URL, "err", err, "cached", ok)
			} else {
				cf, ok, fetched = cacheFile{URL: loc.URL, FetchedAt: c.opts.Now().UTC(), Index: data}, true, true
				if werr := c.writeCache(cf); werr != nil {
					c.opts.Log.Warn("plugin registry: cache", "registry", loc.URL, "err", werr)
				}
			}
		}
		st.Cached = ok && !fetched
		if ok {
			st.FetchedAt = cf.FetchedAt
			idx, issues, err := Parse(cf.Index)
			if err != nil {
				st.Error = strings.TrimSpace(st.Error + "; cached index: " + err.Error())
			}
			st.Issues = issues
			st.Plugins = len(idx.Plugins)
			for _, e := range idx.Plugins {
				if i, dup := byName[e.Name]; dup {
					st.Issues = append(st.Issues, fmt.Sprintf("%s: already listed by %s, which comes first", e.Name, out.Entries[i].Registry))
					continue
				}
				e.Registry = loc.URL
				byName[e.Name] = len(out.Entries)
				out.Entries = append(out.Entries, e)
			}
		}
		out.Registries = append(out.Registries, st)
	}
	slices.SortFunc(out.Entries, func(a, b Entry) int { return strings.Compare(a.Name, b.Name) })
	return out
}

// Err is the registries' failures joined (nil when every one was read).
func (m Merged) Err() error {
	var errs []error
	for _, s := range m.Registries {
		if s.Error != "" {
			errs = append(errs, fmt.Errorf("%s: %s", s.URL, s.Error))
		}
	}
	return errors.Join(errs...)
}

// Fetcher returns the client's fetcher (downloads, releases).
func (c *Client) Fetcher() Fetcher { return c.opts.Fetcher }
