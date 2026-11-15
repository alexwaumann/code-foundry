package daemon

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// The media route answers on the API listener with no token and none of CORS's headers;
// everything else there stays behind both.
func TestWithMedia(t *testing.T) {
	rest := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	media := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) })
	h := withMedia(media, loopbackHandler("secret", nil, []string{"/preview/"}, 4242, nil, rest, http.NotFoundHandler()))
	tests := []struct {
		name, path, origin string
		want               int
	}{
		{"media without token", "/media/abc/clip.mp4", "", http.StatusTeapot},
		{"media from the app", "/media/abc/clip.mp4", "wails://localhost", http.StatusTeapot},
		{"media from a page", "/media/abc/clip.mp4", "http://127.0.0.1:4242", http.StatusTeapot},
		{"media-ish path outside the prefix", "/mediax", "", http.StatusUnauthorized},
		{"rpc without token", "/codefoundry.v1.FilesystemService/ReadFile", "", http.StatusUnauthorized},
		{"preview stays 404", "/preview/abc/index.html", "", http.StatusNotFound},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tc.path, nil)
			if tc.origin != "" {
				req.Header.Set("Origin", tc.origin)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Errorf("status %d, want %d", rec.Code, tc.want)
			}
			if tc.want == http.StatusTeapot && rec.Header().Get("Access-Control-Allow-Origin") != "" {
				t.Errorf("CORS on the media route: %q", rec.Header().Get("Access-Control-Allow-Origin"))
			}
		})
	}
}
