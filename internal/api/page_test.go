package api

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/db/dbtest"
	"github.com/alexwaumann/code-foundry/internal/proxyfetch"
	"github.com/alexwaumann/code-foundry/internal/store/page"
	"github.com/alexwaumann/code-foundry/internal/store/project/projecttest"
)

// pageEnv is a home with pages in every state, and a page store over it with the
// preview's floor: owned.html shown by t-1, allowed.html and refused.html answered,
// new.html not asked about, pages/t-1/own.html in t-1's pages directory.
type pageEnv struct {
	root  string
	store *page.Store
}

func newPageEnv(t *testing.T) pageEnv {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"owned.html", "allowed.html", "refused.html", "new.html", "notes.txt",
		".code-foundry/pages/t-1/own.html", ".ssh/key.html"} {
		p := filepath.Join(root, f)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("<p>x</p>"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	db := dbtest.Open(t)
	for _, q := range []string{
		`INSERT INTO projects (id, path, name, registered_at) VALUES ('web', '/web', 'web', 0)`,
		`INSERT INTO threads (id, project_id, worktree_path, created_at, state) VALUES ('t-1', 'web', '/web', 1, 4)`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	ctx := context.Background()
	s, err := page.New(ctx, page.Options{DB: db, Home: root, PagesRoot: filepath.Join(root, ".code-foundry", "pages"),
		StorageRoot: filepath.Join(root, ".code-foundry", "page-file-storage"), Guarded: testGrants(root).Guarded})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Record(ctx, "t-1", filepath.Join(root, "owned.html"), page.Written); err != nil {
		t.Fatal(err)
	}
	for f, ok := range map[string]bool{"allowed.html": true, "refused.html": false} {
		if _, err := s.SetConsent(ctx, filepath.Join(root, f), ok); err != nil {
			t.Fatal(err)
		}
	}
	return pageEnv{root: root, store: s}
}

// PreviewFile answers who owns the page and whether it may use the bridge with the grant;
// without a page store it leaves page unset, as an older daemon.
func TestFilesystemPreviewFilePage(t *testing.T) {
	e := newPageEnv(t)
	h := NewFilesystem(e.root, projecttest.New(nil), testGrants(e.root)).WithPages(e.store)
	ctx := context.Background()
	for _, tc := range []struct {
		path    string
		owner   string
		source  v1.PageOwnerSource
		consent v1.PageConsent
	}{
		{"owned.html", "t-1", v1.PageOwnerSource_PAGE_OWNER_SOURCE_WRITTEN, v1.PageConsent_PAGE_CONSENT_OWNED},
		{".code-foundry/pages/t-1/own.html", "t-1", v1.PageOwnerSource_PAGE_OWNER_SOURCE_PAGES_DIRECTORY, v1.PageConsent_PAGE_CONSENT_OWNED},
		{"allowed.html", "", 0, v1.PageConsent_PAGE_CONSENT_ALLOWED},
		{"refused.html", "", 0, v1.PageConsent_PAGE_CONSENT_REFUSED},
		{"new.html", "", 0, v1.PageConsent_PAGE_CONSENT_NOT_ASKED},
		{"notes.txt", "", 0, v1.PageConsent_PAGE_CONSENT_UNAVAILABLE},
	} {
		res, err := h.PreviewFile(ctx, connect.NewRequest(&v1.PreviewFileRequest{Path: filepath.Join(e.root, tc.path)}))
		if err != nil {
			t.Fatalf("%s: %v", tc.path, err)
		}
		p := res.Msg.GetPage()
		if p.GetOwnerThread() != tc.owner || p.GetOwnerSource() != tc.source || p.GetConsent() != tc.consent {
			t.Errorf("%s: page %v; want owner %q %v, %v", tc.path, p, tc.owner, tc.source, tc.consent)
		}
		if tc.consent == v1.PageConsent_PAGE_CONSENT_UNAVAILABLE {
			if !strings.HasSuffix(p.GetUnavailableReason(), "notes.txt is not an .html or .htm file") || strings.HasPrefix(p.GetUnavailableReason(), "invalid") || p.GetPath() != "" {
				t.Errorf("%s: unavailable without a reason or with a path: %v", tc.path, p)
			}
		} else if p.GetPath() != filepath.Join(e.root, tc.path) {
			t.Errorf("%s: path %q", tc.path, p.GetPath())
		}
	}
	res, err := NewFilesystem(e.root, projecttest.New(nil), testGrants(e.root)).PreviewFile(ctx,
		connect.NewRequest(&v1.PreviewFileRequest{Path: filepath.Join(e.root, "owned.html")}))
	if err != nil || res.Msg.Page != nil {
		t.Errorf("no page store: %v, %v; want page unset", res.Msg.GetPage(), err)
	}
}

// PageService refuses a page the user has not allowed (FailedPrecondition) or did not
// allow (PermissionDenied), whatever the GUI says; it serves an allowed one and an owned
// one; and a path the preview refuses is never answered for.
func TestPageServiceConsent(t *testing.T) {
	e := newPageEnv(t)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ok") }))
	defer upstream.Close()
	ap := netip.MustParseAddrPort(strings.TrimPrefix(upstream.URL, "http://"))
	fetch := proxyfetch.New(proxyfetch.Options{Allow: []netip.AddrPort{ap}})
	defer fetch.Close()
	h := NewPage(e.store, e.root, fetch)
	ctx := context.Background()
	val := "1"
	for _, tc := range []struct {
		path string
		code connect.Code // 0: served
	}{
		{"owned.html", 0},
		{".code-foundry/pages/t-1/own.html", 0},
		{"allowed.html", 0},
		{"~/allowed.html", 0},
		{"new.html", connect.CodeFailedPrecondition},
		{"refused.html", connect.CodePermissionDenied},
		{".ssh/key.html", connect.CodePermissionDenied},
		{"notes.txt", connect.CodeInvalidArgument},
		{"missing.html", connect.CodeNotFound},
	} {
		path := tc.path
		if !strings.HasPrefix(path, "~/") {
			path = filepath.Join(e.root, path)
		}
		_, setErr := h.SetPageStorage(ctx, connect.NewRequest(&v1.SetPageFileStorageRequest{Path: path, Key: "k", Value: &val}))
		got, getErr := h.PageStorage(ctx, connect.NewRequest(&v1.PageFileStorageRequest{Path: path}))
		res, fetchErr := h.ProxyFetch(ctx, connect.NewRequest(&v1.PageProxyFetchRequest{Path: path, Url: upstream.URL}))
		for name, err := range map[string]error{"set": setErr, "get": getErr, "fetch": fetchErr} {
			if code := connect.CodeOf(err); (tc.code == 0 && err != nil) || (tc.code != 0 && code != tc.code) {
				t.Errorf("%s %s: %v, want code %v", tc.path, name, err, tc.code)
			}
		}
		if tc.code == 0 && (got.Msg.GetValues()["k"] != "1" || string(res.Msg.GetBody()) != "ok") {
			t.Errorf("%s: storage %v, fetch %v", tc.path, got.Msg.GetValues(), res.Msg)
		}
	}
	// GetPage answers for any page, and refuses what the preview refuses.
	got, err := h.GetPage(ctx, connect.NewRequest(&v1.GetPageRequest{Path: "~/new.html"}))
	if err != nil || got.Msg.GetPage().GetConsent() != v1.PageConsent_PAGE_CONSENT_NOT_ASKED || got.Msg.GetPage().GetPath() != filepath.Join(e.root, "new.html") {
		t.Errorf("GetPage(new) = %v, %v", got.Msg.GetPage(), err)
	}
	if _, err := h.GetPage(ctx, connect.NewRequest(&v1.GetPageRequest{Path: filepath.Join(e.root, ".ssh/key.html")})); connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("GetPage(guarded) = %v", err)
	}
	if _, err := NewPage(e.store, e.root, nil).ProxyFetch(ctx, connect.NewRequest(&v1.PageProxyFetchRequest{Path: filepath.Join(e.root, "allowed.html"), Url: upstream.URL})); connect.CodeOf(err) != connect.CodeUnimplemented {
		t.Errorf("no client: %v", err)
	}
}
