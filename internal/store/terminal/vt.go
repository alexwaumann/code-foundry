package terminal

import (
	"fmt"

	ghostty "go.mitchellh.com/libghostty"
)

// continuationMaxBytes bounds the unfinished VT sequence libghostty retains so a snapshot
// taken mid-sequence can end with the bytes needed to resume parsing (see snapshot.go).
// OSC payloads larger than this (e.g. huge OSC 52 clipboard writes) are not replayable
// mid-sequence; that is an acceptable loss for a snapshot.
const continuationMaxBytes = 64 << 10

// vtHooks are the effect callbacks the actor installs. They run synchronously inside
// VTWrite on the actor goroutine and must not call VTWrite.
type vtHooks struct {
	// writePty receives query replies (DA, DSR, mode reports, ...). The slice is only
	// valid during the call.
	writePty func(data []byte)
	// titleChanged is called on OSC 0/2.
	titleChanged func()
	// size reports the current size for XTWINOPS queries.
	size func() (cols, rows uint16)
}

// scrollbackLimits bounds an emulator's scrollback. libghostty applies both limits;
// its default byte limit is only 10,000 bytes (a few hundred rows), so the byte limit
// must always be set explicitly for the line limit to matter.
type scrollbackLimits struct {
	lines uint
	bytes uint
}

// newVT creates a libghostty terminal configured for a PTY-backed program. Call only on
// the goroutine that will own the terminal.
func newVT(cols, rows uint16, sb scrollbackLimits, h vtHooks) (*ghostty.Terminal, error) {
	opts := []ghostty.TerminalOption{
		ghostty.WithSize(cols, rows),
		ghostty.WithMaxScrollbackLines(sb.lines),
		ghostty.WithMaxScrollbackBytes(sb.bytes),
		ghostty.WithContinuationMaxBytes(continuationMaxBytes),
		ghostty.WithDeviceAttributes(deviceAttributes),
	}
	if h.writePty != nil {
		opts = append(opts, ghostty.WithWritePty(func(_ *ghostty.Terminal, data []byte) { h.writePty(data) }))
	}
	if h.titleChanged != nil {
		opts = append(opts, ghostty.WithTitleChanged(func(*ghostty.Terminal) { h.titleChanged() }))
	}
	if h.size != nil {
		opts = append(opts, ghostty.WithSizeReport(func(*ghostty.Terminal) (ghostty.SizeReportSize, bool) {
			c, r := h.size()
			return ghostty.SizeReportSize{Rows: r, Columns: c}, true
		}))
	}
	t, err := ghostty.NewTerminal(opts...)
	if err != nil {
		return nil, fmt.Errorf("new vt %dx%d: %w", cols, rows, err)
	}
	return t, nil
}

// deviceAttributes answers DA1/DA2/DA3 like Ghostty does: a VT220-class terminal with
// ANSI color. Without a handler libghostty ignores DA queries, and programs that send
// DA1 as a "terminal responded" sentinel would stall until their timeout.
func deviceAttributes(*ghostty.Terminal) (ghostty.DeviceAttributes, bool) {
	var da ghostty.DeviceAttributes
	da.Primary.ConformanceLevel = 62
	da.Primary.Features[0] = 22 // ANSI color
	da.Primary.NumFeatures = 1
	da.Secondary.DeviceType = 1
	da.Secondary.FirmwareVersion = 10
	return da, true
}

// formatActivePlain returns the active area of t (cols x rows, no scrollback) as plain
// text, one line per row, trailing whitespace trimmed. Call only on t's owning goroutine.
func formatActivePlain(t *ghostty.Terminal, cols, rows uint16) (string, error) {
	if cols == 0 || rows == 0 {
		return "", nil
	}
	start, err := t.GridRef(ghostty.Point{Tag: ghostty.PointTagActive})
	if err != nil {
		return "", fmt.Errorf("screen text start: %w", err)
	}
	end, err := t.GridRef(ghostty.Point{Tag: ghostty.PointTagActive, X: cols - 1, Y: uint32(rows - 1)})
	if err != nil {
		return "", fmt.Errorf("screen text end: %w", err)
	}
	sel := ghostty.Selection{Start: *start, End: *end}
	text, err := t.SelectionFormatString(
		ghostty.WithSelection(&sel),
		ghostty.WithSelectionFormat(ghostty.FormatterFormatPlain),
		ghostty.WithSelectionTrim(true),
	)
	if err != nil {
		return "", fmt.Errorf("screen text: %w", err)
	}
	return text, nil
}
