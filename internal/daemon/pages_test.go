package daemon

import (
	"bytes"
	"encoding/hex"
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

// The pages key is read back as written, made (0600) when missing or malformed, and the same
// across two starts on one home.
func TestPagesKey(t *testing.T) {
	const kept = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
	tests := []struct {
		name string
		// content is pages.key's; "" leaves it missing.
		content  string
		wantKept bool
	}{
		{"no file", "", false},
		{"a kept key", kept + "\n", true},
		{"not hex", "not a key\n", false},
		{"too short", "0001\n", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			file := filepath.Join(t.TempDir(), "pages.key")
			if tc.content != "" {
				if err := os.WriteFile(file, []byte(tc.content), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			log := slog.New(slog.DiscardHandler)
			key, err := pagesKey(log, file)
			if err != nil {
				t.Fatal(err)
			}
			if got := hex.EncodeToString(key) == kept; got != tc.wantKept {
				t.Errorf("key %x: kept = %v, want %v", key, got, tc.wantKept)
			}
			if len(key) != 32 {
				t.Errorf("key is %d bytes, want 32", len(key))
			}
			fi, err := os.Stat(file)
			if err != nil {
				t.Fatal(err)
			}
			if fi.Mode().Perm() != 0o600 {
				t.Errorf("mode %v, want 0600", fi.Mode().Perm())
			}
			again, err := pagesKey(log, file)
			if err != nil || !bytes.Equal(again, key) {
				t.Errorf("next start: %x, %v; want %x", again, err, key)
			}
		})
	}
}
