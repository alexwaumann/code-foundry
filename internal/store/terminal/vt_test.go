package terminal

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

func TestScrollbackByteCap(t *testing.T) {
	tests := []struct {
		name string
		rows uint
		want uint
	}{
		{"the setting's minimum", 1_000, 128 << 20},
		{"the default", 30_000, 128 << 20},
		{"just under the floor", 43_690, 128 << 20},
		{"past the floor", 43_691, 43_691 * 3 << 10},
		{"the setting's maximum", 100_000, 100_000 * 3 << 10},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := scrollbackByteCap(tt.rows); got != tt.want {
				t.Errorf("scrollbackByteCap(%d) = %d, want %d", tt.rows, got, tt.want)
			}
		})
	}
}

func TestOptionsDeriveTheByteCap(t *testing.T) {
	tests := []struct {
		name      string
		in        Options
		wantRows  uint
		wantBytes uint
	}{
		{"defaults", Options{}, 30_000, 128 << 20},
		{"the setting's maximum", Options{MaxScrollbackLines: 100_000}, 100_000, 100_000 * 3 << 10},
		{"an explicit cap stands", Options{MaxScrollbackLines: 100_000, MaxScrollbackBytes: 1 << 20}, 100_000, 1 << 20},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m := New(tt.in)
			defer func() {
				if err := m.Close(context.Background()); err != nil {
					t.Error(err)
				}
			}()
			if m.opts.MaxScrollbackLines != tt.wantRows || m.opts.MaxScrollbackBytes != tt.wantBytes {
				t.Errorf("rows %d, bytes %d; want %d, %d", m.opts.MaxScrollbackLines, m.opts.MaxScrollbackBytes, tt.wantRows, tt.wantBytes)
			}
		})
	}
}

// The row limit decides at the setting's maximum, for the widths and colouring the cap is
// sized for. It is page-granular, so a little under the limit is kept.
func TestByteCapDoesNotUndercutTheRowLimit(t *testing.T) {
	const limit = 100_000
	plain := func(cols, _ int) string { return strings.Repeat("x", cols) + "\r\n" }
	coloured := func(cols, i int) string {
		var b strings.Builder
		for c := 0; c < cols; c += 8 {
			fmt.Fprintf(&b, "\x1b[38;5;%dm%s", (i+c)%256, strings.Repeat("y", min(8, cols-c)))
		}
		return b.String() + "\x1b[0m\r\n"
	}
	tests := []struct {
		name string
		cols int
		row  func(cols, i int) string
	}{
		{"plain, 160 columns", 160, plain},
		{"coloured, 160 columns", 160, coloured},
		{"plain, 250 columns", 250, plain},
		{"coloured, 250 columns", 250, coloured},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			term, err := newVT(uint16(tt.cols), 40, scrollbackLimits{lines: limit, bytes: scrollbackByteCap(limit)}, vtHooks{})
			if err != nil {
				t.Fatal(err)
			}
			defer term.Close()
			var rows [256][]byte
			for i := range rows {
				rows[i] = []byte(tt.row(tt.cols, i))
			}
			for i := range limit + 2_000 {
				term.VTWrite(rows[i%len(rows)])
			}
			got, err := term.ScrollbackRows()
			if err != nil {
				t.Fatal(err)
			}
			if got < limit-1_000 {
				t.Errorf("kept %d rows of %d", got, limit)
			}
		})
	}
}
