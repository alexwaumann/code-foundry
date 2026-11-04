package terminal

import (
	"context"
	"strings"
	"testing"

	ghostty "go.mitchellh.com/libghostty"
)

var testColors = Colors{
	Foreground: RGB{0xab, 0xb2, 0xbf},
	Background: RGB{0x21, 0x25, 0x2b},
	Cursor:     RGB{0x52, 0x8b, 0xff},
}

// TestColorQueryRepliedBeforeCursorPosition asks the way gh does: OSC 11, then a cursor
// position query as the sentinel. Its reply must not overtake the color's, and only the
// emulator can answer here, as no GUI is attached.
func TestColorQueryRepliedBeforeCursorPosition(t *testing.T) {
	ctx := testCtx(t)
	m := newTestManager(t, Options{})
	m.SetColors(ctx, testColors)
	script := `stty raw -echo; printf '\033]11;?\033\\\033[6n'; r=$(dd bs=1 count=31 2>/dev/null | od -An -c | tr -d ' \n'); stty sane; printf '\r\nREPLY:%s\r\n' "$r"`
	term, err := m.Create(ctx, Spec{Argv: []string{"/bin/sh", "-c", script}, Cols: 40, Rows: 5})
	if err != nil {
		t.Fatal(err)
	}
	ch, err := m.Attach(ctx, term.ID)
	if err != nil {
		t.Fatal(err)
	}
	c := collect(ch)
	c.waitFor(t, "exit", func(c *collector) bool { return c.exited() != nil })
	c.mu.Lock()
	defer c.mu.Unlock()
	if want := `REPLY:033]11;rgb:2121/2525/2b2b033\033[1;1R`; !strings.Contains(c.raw.String(), want) {
		t.Errorf("want %q; raw = %q", want, c.raw.String())
	}
}

// xterm swallows every query below, so each needs the emulator's answer.
func TestColorQueryReplies(t *testing.T) {
	const fg, bg, cursor = "rgb:abab/b2b2/bfbf", "rgb:2121/2525/2b2b", "rgb:5252/8b8b/ffff"
	tests := []struct{ name, query, want string }{
		{"OSC 10", "\x1b]10;?\x07", "\x1b]10;" + fg + "\x07"},
		{"OSC 11", "\x1b]11;?\x07", "\x1b]11;" + bg + "\x07"},
		{"OSC 12", "\x1b]12;?\x07", "\x1b]12;" + cursor + "\x07"},
		{"ST terminates the reply like the query", "\x1b]11;?\x1b\\", "\x1b]11;" + bg + "\x1b\\"},
		{"OSC 10 asking for the next color too", "\x1b]10;?;?\x07", "\x1b]10;" + fg + "\x07\x1b]11;" + bg + "\x07"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var got []byte
			vt, err := newVT(80, 24, scrollbackLimits{lines: 100, bytes: 1 << 20}, vtHooks{writePty: func(b []byte) { got = append(got, b...) }})
			if err != nil {
				t.Fatal(err)
			}
			defer vt.Close()
			if err := setVTColors(vt, testColors); err != nil {
				t.Fatal(err)
			}
			if _, err := vt.Write([]byte(tt.query)); err != nil {
				t.Fatal(err)
			}
			if string(got) != tt.want {
				t.Errorf("reply %q, want %q", got, tt.want)
			}
		})
	}
}

// actorColors reads the emulator's default colors on its actor.
func actorColors(ctx context.Context, t *testing.T, m *Manager, id string) Colors {
	t.Helper()
	a, err := m.actor(id)
	if err != nil {
		t.Fatal(err)
	}
	var got Colors
	if err := a.call(ctx, func() {
		for _, c := range []struct {
			read func() (*ghostty.ColorRGB, error)
			into *RGB
		}{
			{a.vt.ColorForegroundDefault, &got.Foreground},
			{a.vt.ColorBackgroundDefault, &got.Background},
			{a.vt.ColorCursorDefault, &got.Cursor},
		} {
			v, err := c.read()
			if err != nil {
				t.Error(err)
				continue
			}
			if v != nil {
				*c.into = RGB{v.R, v.G, v.B}
			}
		}
	}); err != nil {
		t.Fatal(err)
	}
	return got
}

func TestSetColors(t *testing.T) {
	sleeper := Spec{Argv: []string{"/bin/sleep", "30"}}
	tests := []struct {
		name string
		// before and after are set around Create; a zero one is not set.
		before, after, want Colors
	}{
		{name: "none set", want: Colors{}},
		{name: "a new terminal starts with them", before: testColors, want: testColors},
		{name: "a running terminal gets them", after: testColors, want: testColors},
		{name: "the latest wins", before: Colors{Background: RGB{1, 2, 3}}, after: testColors, want: testColors},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx := testCtx(t)
			m := newTestManager(t, Options{})
			if tt.before != (Colors{}) {
				m.SetColors(ctx, tt.before)
			}
			term, err := m.Create(ctx, sleeper)
			if err != nil {
				t.Fatal(err)
			}
			if tt.after != (Colors{}) {
				m.SetColors(ctx, tt.after)
			}
			if got := actorColors(ctx, t, m, term.ID); got != tt.want {
				t.Errorf("colors = %+v, want %+v", got, tt.want)
			}
		})
	}
}
