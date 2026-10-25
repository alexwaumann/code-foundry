package daemon

import (
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

func TestListenPages(t *testing.T) {
	// A port free right now, to write into pages.port.
	free := func(t *testing.T) int {
		t.Helper()
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		port := ln.Addr().(*net.TCPAddr).Port
		_ = ln.Close()
		return port
	}
	tests := []struct {
		name string
		// file is pages.port's content; "" leaves it missing. take holds the port first.
		file     func(t *testing.T) (content string, port int)
		take     bool
		wantSame bool
	}{
		{"no file", func(*testing.T) (string, int) { return "", 0 }, false, false},
		{"last port free", func(t *testing.T) (string, int) { p := free(t); return strconv.Itoa(p) + "\n", p }, false, true},
		{"last port taken", func(t *testing.T) (string, int) { p := free(t); return strconv.Itoa(p) + "\n", p }, true, false},
		{"malformed", func(*testing.T) (string, int) { return "not a port\n", 0 }, false, false},
		{"out of range", func(*testing.T) (string, int) { return "70000\n", 0 }, false, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			file := filepath.Join(t.TempDir(), "pages.port")
			content, want := tc.file(t)
			if content != "" {
				if err := os.WriteFile(file, []byte(content), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			if tc.take {
				hold, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(want)))
				if err != nil {
					t.Skipf("cannot hold port %d: %v", want, err)
				}
				defer func() { _ = hold.Close() }()
			}
			ln, err := listenPages(slog.New(slog.DiscardHandler), file)
			if err != nil {
				t.Fatalf("listenPages: %v", err)
			}
			defer func() { _ = ln.Close() }()
			addr := ln.Addr().(*net.TCPAddr)
			if !addr.IP.IsLoopback() {
				t.Errorf("listening on %s, want loopback", addr)
			}
			if got := addr.Port == want; got != tc.wantSame {
				t.Errorf("port %d, last %d: same = %v, want %v", addr.Port, want, got, tc.wantSame)
			}
		})
	}
}
