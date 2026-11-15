package fsx

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestReadTail(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	line := []byte("0123456789abcde\n") // 16 bytes
	big := bytes.Repeat(line, MaxReadBytes/16+10)
	// 100 lines past the cap and an unfinished one of 7 bytes, so the window starts 7 bytes
	// into a line: the first whole one is 9 bytes on.
	odd := append(bytes.Repeat(line, MaxReadBytes/16+100), "1234567"...)
	files := map[string][]byte{
		"small.log":     []byte("one\ntwo\nthree\n"),
		"exact.log":     bytes.Repeat(line, MaxReadBytes/16),
		"big.log":       big,
		"odd.log":       odd,
		"lines.log":     []byte("aaaa\nbbbb\ncccc\n"),
		"at-break.log":  []byte("aaa\nbbb\n"),
		"one-line.log":  []byte("abcdefghij"),
		"ends-in.log":   []byte("abcdefghij\n"),
		"crlf.log":      []byte("line1\r\nline2\r\nline3\r\n"),
		"two-byte.log":  []byte("ééééé"), // c3 a9 ×5
		"four-byte.log": []byte("😀😀😀"),   // f0 9f 98 80 ×3
		"three.log":     []byte("x€€€"),  // e2 82 ac ×3 after one byte
		"empty.log":     {},
		"blob":          append([]byte("a\x00b"), bytes.Repeat([]byte("z"), 100)...),
	}
	for name, b := range files {
		if err := os.WriteFile(filepath.Join(root, name), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	tests := []struct {
		name, path string
		max        int64
		want       string // the contents; "" with wantLen
		wantLen    int
		offset     int64
		cut        bool
		binary     bool
	}{
		{name: "smaller than the cap: whole", path: "small.log", want: "one\ntwo\nthree\n"},
		{name: "exactly the cap: whole", path: "exact.log", wantLen: MaxReadBytes},
		{name: "empty", path: "empty.log", want: ""},
		// big.log's last MiB starts on a line: the byte before it is a break.
		{name: "over the cap, window on a line start", path: "big.log", wantLen: MaxReadBytes, offset: int64(len(big) - MaxReadBytes), cut: true},
		{name: "over the cap, window mid-line", path: "odd.log", wantLen: MaxReadBytes - 9, offset: int64(len(odd) - MaxReadBytes + 9), cut: true},
		{name: "first line start in the window", path: "lines.log", max: 8, want: "cccc\n", offset: 10, cut: true},
		{name: "window starts just after a break", path: "at-break.log", max: 4, want: "bbb\n", offset: 4, cut: true},
		{name: "one byte over", path: "lines.log", max: 14, want: "bbbb\ncccc\n", offset: 5, cut: true},
		{name: "no break: the window", path: "one-line.log", max: 4, want: "ghij", offset: 6, cut: true},
		{name: "only a final break: the window", path: "ends-in.log", max: 4, want: "hij\n", offset: 7, cut: true},
		{name: "crlf", path: "crlf.log", max: 9, want: "line3\r\n", offset: 14, cut: true},
		{name: "crlf cut between cr and lf", path: "crlf.log", max: 8, want: "line3\r\n", offset: 14, cut: true},
		{name: "two-byte character at the cut", path: "two-byte.log", max: 5, want: "éé", offset: 6, cut: true},
		{name: "four-byte character at the cut", path: "four-byte.log", max: 5, want: "😀", offset: 8, cut: true},
		{name: "three-byte character at the cut", path: "three.log", max: 4, want: "€", offset: 7, cut: true},
		{name: "a binary reads from the start", path: "blob", max: 10, wantLen: 10, binary: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ReadTail(ReadRoots{Home: root}, root, tt.path, tt.max)
			if err != nil {
				t.Fatal(err)
			}
			if tt.wantLen == 0 && string(got.Contents) != tt.want {
				t.Errorf("contents %q, want %q", got.Contents, tt.want)
			}
			if tt.wantLen != 0 && len(got.Contents) != tt.wantLen {
				t.Errorf("len(contents) = %d, want %d", len(got.Contents), tt.wantLen)
			}
			if got.Offset != tt.offset || got.TruncatedStart != tt.cut || got.Binary != tt.binary {
				t.Errorf("offset %d cut %t binary %t, want %d %t %t", got.Offset, got.TruncatedStart, got.Binary, tt.offset, tt.cut, tt.binary)
			}
			if got.Truncated != tt.binary { // a tail read never stops before the end; the binary's head does
				t.Errorf("truncated %t", got.Truncated)
			}
			if tt.cut {
				whole := files[tt.path]
				if !bytes.Equal(got.Contents, whole[got.Offset:]) {
					t.Error("contents are not the file from offset to its end")
				}
				if whole[got.Offset-1] != '\n' && !utf8.RuneStart(whole[got.Offset]) {
					t.Errorf("starts inside a character, after %q", whole[got.Offset-1])
				}
			}
		})
	}
	t.Run("refusals as ReadFile's", func(t *testing.T) {
		for _, p := range []string{"/etc/hosts", "../x.log", ""} {
			if _, err := ReadTail(ReadRoots{Home: root}, root, p, 0); !errors.Is(err, ErrInvalidArgument) {
				t.Errorf("ReadTail(%q) err = %v, want ErrInvalidArgument", p, err)
			}
		}
	})
}

// A tail read that left out the start, like a head read that stopped short, is not edited.
func TestNotEditableCut(t *testing.T) {
	for _, f := range []FileContents{{TruncatedStart: true, Offset: 4}, {Truncated: true}} {
		if why := notEditable(f); !strings.Contains(why, "over 1 MiB") {
			t.Errorf("notEditable(%+v) = %q", f, why)
		}
	}
	if why := notEditable(FileContents{Media: true, Binary: true, MIMEType: "video/mp4"}); !strings.Contains(why, "video or audio") {
		t.Errorf("media: %q", why)
	}
}

func TestMediaType(t *testing.T) {
	media := map[string]string{
		"a.mp4": "video/mp4", "a.M4V": "video/mp4", "a.mov": "video/quicktime", "a.webm": "video/webm",
		"a.mp3": "audio/mpeg", "a.wav": "audio/wav", "a.m4a": "audio/mp4", "a.aac": "audio/aac",
		"a.ogg": "audio/ogg", "a.flac": "audio/flac",
	}
	for name, want := range media {
		if got, ok := MediaType(name); !ok || got != want {
			t.Errorf("MediaType(%q) = %q, %t", name, got, ok)
		}
		if got := DetectMIME(name, nil); got != want {
			t.Errorf("DetectMIME(%q) = %q", name, got)
		}
	}
	for _, name := range []string{"a.txt", "a.png", "mp4", "a.mp4.txt", "a.html"} {
		if _, ok := MediaType(name); ok {
			t.Errorf("MediaType(%q) is media", name)
		}
	}
	// The new text formats read as text.
	for _, name := range []string{"a.csv", "a.tsv", "a.jsonl", "a.ndjson", "a.mmd", "a.mermaid", "a.log", "a.patch", "a.diff"} {
		if got := DetectMIME(name, []byte("x")); !TextMIME(got) {
			t.Errorf("DetectMIME(%q) = %q, not text", name, got)
		}
	}
}
