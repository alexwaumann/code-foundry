package pagelib

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"regexp"
	"slices"
	"strings"
	"testing"
)

// The files a page names by path, and the import map's: all built and served.
func TestServedFiles(t *testing.T) {
	want := []string{JSXPath, TailwindPath, UICSSPath}
	for _, im := range ImportMap {
		want = append(want, im.Path)
	}
	paths := Paths()
	for _, p := range want {
		if !slices.Contains(paths, p) {
			t.Errorf("%s is not served (dist has %v); run make pagelib", p, paths)
		}
	}
	for _, p := range paths {
		if !strings.HasPrefix(p, Prefix) || !(strings.HasSuffix(p, ".js") || strings.HasSuffix(p, ".css")) {
			t.Errorf("serves %s: want only .js and .css under %s", p, Prefix)
		}
	}
	// The loader's import map names the same files.
	loader := string(files[JSXPath].body)
	for _, im := range ImportMap {
		// Minified: a bare key when it is an identifier, any quotes around the file.
		entry := regexp.MustCompile(`[{,]["']?` + regexp.QuoteMeta(im.Specifier) + "[\"']?:[\"'`]" + regexp.QuoteMeta(strings.TrimPrefix(im.Path, Prefix)) + "[\"'`]")
		if !entry.MatchString(loader) {
			t.Errorf("jsx.js does not map %s to %s", im.Specifier, im.Path)
		}
	}
	// The runtime carries the app's theme; the stylesheet the type roles.
	if tw := string(files[TailwindPath].body); !strings.Contains(tw, "--color-cf-surface") || !strings.Contains(tw, "text/tailwindcss") {
		t.Error("tailwind.js lacks the app's @theme")
	}
	if css := string(files[UICSSPath].body); !strings.Contains(css, ".text-body{") || !strings.Contains(css, ".bg-cf-surface-raised{") {
		t.Error("ui.css lacks the type roles or the cf colours")
	}
	ui := UIExports()
	for _, name := range []string{"Button", "Dialog", "Tabs", "Table", "cn", "toast"} {
		if !slices.Contains(ui, name) {
			t.Errorf("ui-exports.json lacks %s", name)
		}
	}
}

func TestHandler(t *testing.T) {
	routes := Routes()
	js := routes[Prefix+"ui.js"]
	css := routes[UICSSPath]
	if js == nil || css == nil {
		t.Fatal("ui.js or ui.css has no route")
	}
	f := files[Prefix+"ui.js"]
	tests := []struct {
		name, method, path, ifNoneMatch string
		h                               http.Handler
		want                            int
		ctype                           string
		body                            bool
	}{
		{"get", http.MethodGet, Prefix + "ui.js", "", js, http.StatusOK, "text/javascript; charset=utf-8", true},
		{"head", http.MethodHead, Prefix + "ui.js", "", js, http.StatusOK, "text/javascript; charset=utf-8", false},
		{"revalidated", http.MethodGet, Prefix + "ui.js", f.etag, js, http.StatusNotModified, "", false},
		{"stale etag", http.MethodGet, Prefix + "ui.js", `"old"`, js, http.StatusOK, "text/javascript; charset=utf-8", true},
		{"stylesheet", http.MethodGet, UICSSPath, "", css, http.StatusOK, "text/css; charset=utf-8", false},
		{"post", http.MethodPost, Prefix + "ui.js", "", js, http.StatusMethodNotAllowed, "", false},
		{"another path", http.MethodGet, Prefix + "ui.mjs", "", js, http.StatusNotFound, "", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.path, nil)
			if tc.ifNoneMatch != "" {
				req.Header.Set("If-None-Match", tc.ifNoneMatch)
			}
			rec := httptest.NewRecorder()
			tc.h.ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("status %d, want %d", rec.Code, tc.want)
			}
			if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
				t.Errorf("ACAO %q, want *", got)
			}
			if tc.want != http.StatusOK && tc.want != http.StatusNotModified {
				return
			}
			if tc.ctype != "" {
				if got := rec.Header().Get("Content-Type"); got != tc.ctype {
					t.Errorf("Content-Type %q, want %q", got, tc.ctype)
				}
			}
			for k, want := range map[string]string{"Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff"} {
				if got := rec.Header().Get(k); got != want {
					t.Errorf("%s = %q, want %q", k, got, want)
				}
			}
			if rec.Header().Get("ETag") == "" {
				t.Error("no ETag")
			}
			if tc.body && !bytes.Equal(rec.Body.Bytes(), f.body) {
				t.Error("body is not ui.js")
			}
		})
	}
}
