package terminal

import (
	"bytes"
	"errors"
	"fmt"
	"strings"

	ghostty "go.mitchellh.com/libghostty"
)

// Snapshot serialization.
//
// A snapshot is a VT byte stream that, written to a freshly reset emulator of the same
// size, reproduces the terminal: scrollback, screen contents with SGR attributes, cursor
// position and pen, non-default modes, tabstops, scrolling region, title, and (when the
// program is on the alternate screen) the primary screen hidden underneath it.
//
// It is built from libghostty's VT formatter, which emits, in order:
//
//	[palette] [modes] [tabstops, then CSI H]  <content>  [DECSTBM/DECSLRM] [keyboard] [OSC 7]
//	[cursor CUP] [SGR pen] [OSC 8] [DECSCA] [kitty keyboard] [charsets]
//
// Two gaps in the formatter are filled here:
//
//  1. Trailing blank rows of the active area are trimmed from <content>. With scrollback
//     present, a replaying emulator would then align the viewport too high and the
//     trailing CUP would land on the wrong line. We pad <content> with CRLFs up to
//     TotalRows lines before the suffix. The formatter cannot emit the suffix alone, so we
//     format with and without suffix extras and split on the common prefix (plus one
//     wrapped pass to count rows; see writeScreen).
//  2. The formatter only serializes the active screen. On the alternate screen we decode
//     a binary Snapshot into a throwaway terminal, leave the alternate screen there (which
//     restores the primary cursor saved by DECSET 1049), and emit that primary screen
//     first. The live formatter's modes then contain the DECSET that switches the replay
//     to the alternate screen (saving the primary cursor, as the program did), followed by
//     the alternate contents.
//
// Finally the window title (OSC 2) and the parser continuation are appended. The
// continuation is the unfinished escape sequence or UTF-8 prefix at the end of the stream
// so far; without it, the first live Output chunk after the snapshot could start in the
// middle of a sequence the replaying emulator never saw the beginning of.

// buildSnapshot serializes t. Call only on t's owning goroutine.
func buildSnapshot(t *ghostty.Terminal) ([]byte, error) {
	var out bytes.Buffer

	screen, err := t.ActiveScreen()
	if err != nil {
		return nil, fmt.Errorf("active screen: %w", err)
	}
	if screen == ghostty.ScreenAlternate {
		if err := writePrimaryUnderAlt(&out, t); err != nil {
			return nil, err
		}
	}

	prefix := []ghostty.FormatterOption{
		ghostty.WithFormatterExtraModes(true),
		ghostty.WithFormatterExtraTabstops(true),
	}
	if paletteChanged(t) {
		prefix = append(prefix, ghostty.WithFormatterExtraPalette(true))
	}
	suffix := []ghostty.FormatterOption{
		ghostty.WithFormatterExtraScrollingRegion(true),
		ghostty.WithFormatterExtraKeyboard(true),
		ghostty.WithFormatterExtraPwd(true),
		ghostty.WithFormatterExtraCursor(true),
		ghostty.WithFormatterExtraStyle(true),
		ghostty.WithFormatterExtraHyperlink(true),
		ghostty.WithFormatterExtraProtection(true),
		ghostty.WithFormatterExtraKittyKeyboard(true),
		ghostty.WithFormatterExtraCharsets(true),
	}
	if err := writeScreen(&out, t, prefix, suffix); err != nil {
		return nil, err
	}

	if title, err := t.Title(); err == nil && title != "" {
		out.WriteString("\x1b]2;")
		out.WriteString(sanitizeTitle(title))
		out.WriteString("\x1b\\")
	}

	// ErrInvalidValue means continuation tracking is off (only terminals not created by
	// newVT); there is nothing to append then.
	cont, err := t.Continuation()
	if err != nil && !errors.Is(err, ghostty.ErrInvalidValue) {
		return nil, fmt.Errorf("continuation: %w", err)
	}
	out.Write(cont)
	return out.Bytes(), nil
}

// writePrimaryUnderAlt emits the primary screen (with scrollback) of a terminal that is
// currently on the alternate screen, ending with the cursor where the primary cursor is.
func writePrimaryUnderAlt(out *bytes.Buffer, t *ghostty.Terminal) error {
	raw, err := t.Snapshot()
	if err != nil {
		return fmt.Errorf("encode vt snapshot: %w", err)
	}
	dec, err := ghostty.NewSnapshotDecoderBytes(raw)
	if err != nil {
		return fmt.Errorf("new snapshot decoder: %w", err)
	}
	clone, err := dec.Decode()
	dec.Close()
	if err != nil {
		return fmt.Errorf("decode vt snapshot: %w", err)
	}
	defer clone.Close()

	clone.VTWrite([]byte(altScreenExit(modeOf(t, ghostty.ModeAltScreenSave), modeOf(t, ghostty.ModeAltScreen))))
	if s, err := clone.ActiveScreen(); err != nil || s != ghostty.ScreenPrimary {
		return fmt.Errorf("clone did not return to the primary screen (screen=%v err=%v)", s, err)
	}
	return writeScreen(out, clone, nil, []ghostty.FormatterOption{ghostty.WithFormatterExtraCursor(true)})
}

// writeScreen formats the active screen of t as prefix extras + content + padding +
// suffix extras.
//
// Content is emitted unwrapped, so soft-wrapped lines stay soft-wrapped in the replaying
// emulator (and reflow there on resize). Wrapping happens only at the right margin, so an
// emulator of the same width re-wraps them onto exactly the original rows. The row count
// used for padding comes from a separate wrapped pass, where every row ends in CRLF.
func writeScreen(out *bytes.Buffer, t *ghostty.Terminal, prefix, suffix []ghostty.FormatterOption) error {
	vt := ghostty.WithFormatterFormat(ghostty.FormatterFormatVT)
	unwrap := ghostty.WithFormatterUnwrap(true)
	rowsPass, err := format(t, vt)
	if err != nil {
		return err
	}
	head, err := format(t, append([]ghostty.FormatterOption{vt, unwrap}, prefix...)...)
	if err != nil {
		return err
	}
	full, err := format(t, append(append([]ghostty.FormatterOption{vt, unwrap}, prefix...), suffix...)...)
	if err != nil {
		return err
	}
	if !bytes.HasPrefix(full, head) {
		return errors.New("vt formatter output is not stable across passes")
	}
	total, err := t.TotalRows()
	if err != nil {
		return fmt.Errorf("total rows: %w", err)
	}
	out.Write(head)
	out.WriteString(strings.Repeat("\r\n", padRows(rowsPass, total)))
	out.Write(full[len(head):])
	return nil
}

func format(t *ghostty.Terminal, opts ...ghostty.FormatterOption) ([]byte, error) {
	f, err := ghostty.NewFormatter(t, opts...)
	if err != nil {
		return nil, fmt.Errorf("new formatter: %w", err)
	}
	defer f.Close()
	b, err := f.Format()
	if err != nil {
		return nil, fmt.Errorf("format: %w", err)
	}
	return b, nil
}

// padRows returns how many CRLFs to append to content so that it spans totalRows lines.
// rows is a wrapped (non-unwrapped), extras-free VT pass: the formatter ends every row,
// soft-wrapped or not, with CRLF, so the content spans count(CRLF)+1 rows.
func padRows(content []byte, totalRows uint) int {
	lines := uint(bytes.Count(content, []byte("\r\n"))) + 1
	if lines >= totalRows {
		return 0
	}
	return int(totalRows - lines)
}

// altScreenExit returns the sequence that leaves the alternate screen the way the
// program entered it: 1049 restores the primary cursor saved on entry, 1047 and 47 do not.
func altScreenExit(mode1049, mode1047 bool) string {
	switch {
	case mode1049:
		return "\x1b[?1049l"
	case mode1047:
		return "\x1b[?1047l"
	default:
		return "\x1b[?47l"
	}
}

// sanitizeTitle drops C0/C1 controls (including ESC and BEL) so the title cannot end the
// OSC early or inject sequences.
func sanitizeTitle(s string) string {
	return strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f || (r >= 0x80 && r < 0xa0) {
			return -1
		}
		return r
	}, s)
}

func modeOf(t *ghostty.Terminal, m ghostty.Mode) bool {
	v, err := t.Mode(m)
	return err == nil && v
}

// paletteChanged reports whether a program changed the 256-color palette (OSC 4). The
// palette extra emits all 256 entries (~8 KiB), so include it only when needed.
func paletteChanged(t *ghostty.Terminal) bool {
	cur, err := t.ColorPalette()
	if err != nil || cur == nil {
		return false
	}
	def, err := t.ColorPaletteDefault()
	if err != nil || def == nil {
		return false
	}
	return *cur != *def
}
