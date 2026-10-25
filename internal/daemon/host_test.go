package daemon

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestLoopbackHost(t *testing.T) {
	ok := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) })
	h := loopbackHost(4242, ok)
	tests := []struct {
		host string
		want int
	}{
		{"127.0.0.1:4242", http.StatusTeapot},
		{"localhost:4242", http.StatusTeapot},
		{"LOCALHOST:4242", http.StatusTeapot},
		{"[::1]:4242", http.StatusTeapot},
		{"127.0.0.1", http.StatusTeapot},
		{"localhost", http.StatusTeapot},
		{"[::1]", http.StatusTeapot},
		// Another port: another listener's name, or a proxy's.
		{"127.0.0.1:4243", http.StatusMisdirectedRequest},
		{"localhost:80", http.StatusMisdirectedRequest},
		// A rebinding page sends its own name.
		{"attacker.example:4242", http.StatusMisdirectedRequest},
		{"attacker.example", http.StatusMisdirectedRequest},
		{"localhost.:4242", http.StatusMisdirectedRequest},
		{"127.0.0.1.nip.io:4242", http.StatusMisdirectedRequest},
		{"0.0.0.0:4242", http.StatusMisdirectedRequest},
		{"127.1:4242", http.StatusMisdirectedRequest},
		{"[::ffff:127.0.0.1]:4242", http.StatusMisdirectedRequest},
		{"::1", http.StatusMisdirectedRequest},
		{"[::1", http.StatusMisdirectedRequest},
		{"", http.StatusMisdirectedRequest},
	}
	for _, tc := range tests {
		t.Run(tc.host, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/codefoundry.v1.ThreadService/List", nil)
			req.Host = tc.host
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Errorf("Host %q: status %d, want %d", tc.host, rec.Code, tc.want)
			}
		})
	}
}
