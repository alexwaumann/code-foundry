package claudestatus

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

// claudeOutput returns n bytes of real Claude Code output (the plan fixture's chunks,
// repeated): dense cursor movement, SGR, synchronized-update brackets, and titles.
func claudeOutput(tb testing.TB, n int) []byte {
	var src bytes.Buffer
	for _, ev := range loadFixture(tb, "plan") {
		if ev.K == "out" {
			src.WriteString(ev.D)
		}
	}
	out := make([]byte, 0, n)
	for len(out) < n {
		out = append(out, src.Bytes()...)
	}
	return out[:n]
}

func benchOutput(b *testing.B, chunk []byte) {
	d := New(nil, WithClock(func() time.Time { return replayBase }))
	b.SetBytes(int64(len(chunk)))
	b.ReportAllocs()
	for b.Loop() {
		d.Output(chunk)
	}
}

// Output must cost microseconds per 64 KiB chunk (the actor's maximum coalesced chunk).
func BenchmarkOutput64KClaude(b *testing.B) { benchOutput(b, claudeOutput(b, 64<<10)) }

func BenchmarkOutput64KPlainText(b *testing.B) {
	benchOutput(b, bytes.Repeat([]byte("the quick brown fox jumps over the lazy dog\r\n"), (64<<10)/45))
}

func BenchmarkOutput64KDenseSGR(b *testing.B) {
	benchOutput(b, bytes.Repeat([]byte("\x1b[38;2;10;20;30mx\x1b[0m"), (64<<10)/23))
}

func BenchmarkOutputSmallChunk(b *testing.B) {
	benchOutput(b, []byte("\x1b[?2026h\x1b[12;1H\x1b[38;5;174m✻\x1b[39m\x1b[?2026l"))
}

func BenchmarkClassifyScreen(b *testing.B) {
	screen := screenAt(loadFixture(b, "permission"), 9000)
	b.ReportAllocs()
	for b.Loop() {
		ClassifyScreen(screen)
	}
}

// A screen with deep scrollback (the inline renderer's plain text includes it).
func BenchmarkClassifyScreenScrollback(b *testing.B) {
	screen := strings.Repeat("some earlier transcript line that is fairly long, like real output\n", 10000) +
		fullscreenIdle
	b.ReportAllocs()
	for b.Loop() {
		ClassifyScreen(screen)
	}
}

func BenchmarkTranscriptLine(b *testing.B) {
	d := New(nil)
	line := []byte(lineToolUse)
	b.ReportAllocs()
	for b.Loop() {
		d.Transcript(line)
	}
}

// Large non-turn records (attachments, file-history snapshots) are common.
func BenchmarkTranscriptAttachment(b *testing.B) {
	d := New(nil)
	line := []byte(`{"type":"attachment","attachment":{"type":"skill_listing","content":"` +
		strings.Repeat("x", 50_000) + `"}}`)
	b.ReportAllocs()
	for b.Loop() {
		d.Transcript(line)
	}
}
