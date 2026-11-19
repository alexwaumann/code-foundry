package bridge

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHandler(t *testing.T) {
	tests := []struct {
		name, method, path, ifNoneMatch string
		want                            int
		body                            bool
	}{
		{"get", http.MethodGet, Path, "", http.StatusOK, true},
		{"head", http.MethodHead, Path, "", http.StatusOK, false},
		{"revalidated", http.MethodGet, Path, etag, http.StatusNotModified, false},
		{"stale etag", http.MethodGet, Path, `"old"`, http.StatusOK, true},
		{"post", http.MethodPost, Path, "", http.StatusMethodNotAllowed, false},
		{"another path", http.MethodGet, "/cf/bridge.mjs", "", http.StatusNotFound, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.path, nil)
			if tc.ifNoneMatch != "" {
				req.Header.Set("If-None-Match", tc.ifNoneMatch)
			}
			rec := httptest.NewRecorder()
			Handler().ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("status %d, want %d", rec.Code, tc.want)
			}
			if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
				t.Errorf("ACAO %q, want *", got)
			}
			if tc.want != http.StatusOK && tc.want != http.StatusNotModified {
				return
			}
			for k, want := range map[string]string{
				"Content-Type":           "text/javascript; charset=utf-8",
				"Cache-Control":          "no-cache",
				"ETag":                   etag,
				"X-Content-Type-Options": "nosniff",
			} {
				if tc.want == http.StatusNotModified && k == "Content-Type" {
					continue
				}
				if got := rec.Header().Get(k); got != want {
					t.Errorf("%s = %q, want %q", k, got, want)
				}
			}
			if got := bytes.Equal(rec.Body.Bytes(), script); got != tc.body {
				t.Errorf("body is the script: %v, want %v", got, tc.body)
			}
		})
	}
}

// The script carries the contract the GUI's host implements: every message type, the
// protocol version and the error codes it raises itself (declined comes from the host),
// so a rename on one side shows up here.
func TestScriptNamesTheContract(t *testing.T) {
	src := string(Script())
	want := []string{
		`"cf:run"`, `"cf:on"`, `"cf:off"`, `"cf:resize"`, `"cf:theme:ack"`, `"cf:hello"`,
		`"cf:ready"`, `"cf:result"`, `"cf:event"`, `"cf:theme"`,
		`"cf:store"`, `"cf:storage"`, `"cf:cancel"`, `"cf:pending"`, `"cf:resume"`, `"cf:bye"`, `"cf:fetch"`, `"cf:key"`, `"cf:asking"`, "msg.nonce",
		// What cf:ready says a page may use whether or not it has a thread (docs/notes/page-ownership-gui.md).
		"readyMsg.can", "readyMsg.refusal",
		"var VERSION = 1;", "navigator.userActivation", "ResizeObserver", `"*"`,
	}
	for _, code := range ErrorCodes {
		if code != CodeDeclined {
			want = append(want, `"`+code+`"`)
		}
	}
	for _, w := range want {
		if !strings.Contains(src, w) {
			t.Errorf("bridge.js does not contain %s", w)
		}
	}
	if Version != 1 {
		t.Errorf("Version %d; bridge.js says 1", Version)
	}
}

// The script's own list of sources (what cf.on checks before cf:ready) is Sources.
func TestScriptSources(t *testing.T) {
	quoted := make([]string, len(Sources))
	for i, s := range Sources {
		quoted[i] = `"` + s + `"`
	}
	want := "var SOURCES = [" + strings.Join(quoted, ", ") + "];"
	if !strings.Contains(string(Script()), want) {
		t.Errorf("bridge.js does not contain %s", want)
	}
}

// A page no thread owns: its errors say what is true (docs/notes/page-ownership-gui.md), and
// "await cf.ready first" is said only before the app answered.
func TestScriptRefusalsSayWhy(t *testing.T) {
	src := string(Script())
	for _, w := range []string{
		`may("storage")`, `may("fetch")`, `denied("cf.storage")`, `denied("cf.fetch")`,
		"this page is not shown in a thread",
		"Code Foundry has not answered this page yet; await cf.ready first",
	} {
		if !strings.Contains(src, w) {
			t.Errorf("bridge.js does not contain %s", w)
		}
	}
	if n := strings.Count(src, "await cf.ready first"); n != 1 {
		t.Errorf("bridge.js says \"await cf.ready first\" %d times; once, before cf:ready", n)
	}
	for _, gone := range []string{"needs the page's thread"} {
		if strings.Contains(src, gone) {
			t.Errorf("bridge.js still says %q: storage and fetch work without a thread", gone)
		}
	}
}
