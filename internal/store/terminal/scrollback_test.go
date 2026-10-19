package terminal

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

// ScrollbackText is the history above the screen and the screen, oldest first, as plain
// text: escapes stripped, soft wraps joined, trailing blanks trimmed.
func TestScrollbackText(t *testing.T) {
	ctx := testCtx(t)
	m := newTestManager(t, Options{})
	// 60 coloured lines and one 70-column line on a 30x8 screen, then wait.
	script := `i=0; while [ $i -lt 60 ]; do printf '\033[1;32mline %d\033[0m   \n' $i; i=$((i+1)); done; ` +
		`printf '%070d\n' 7; echo done; sleep 30`
	term, err := m.Create(ctx, Spec{Argv: []string{"/bin/sh", "-c", script}, Cols: 30, Rows: 8})
	if err != nil {
		t.Fatal(err)
	}
	var text string
	deadline := time.Now().Add(8 * time.Second)
	for !strings.HasSuffix(text, "\ndone") {
		if time.Now().After(deadline) {
			t.Fatalf("ScrollbackText never ended in done: %q", text)
		}
		time.Sleep(20 * time.Millisecond)
		if text, err = m.ScrollbackText(ctx, term.ID); err != nil {
			t.Fatal(err)
		}
	}
	var want []string
	for i := range 60 {
		want = append(want, fmt.Sprintf("line %d", i))
	}
	want = append(want, fmt.Sprintf("%070d", 7), "done")
	if got := strings.Split(text, "\n"); strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("ScrollbackText lines = %q\nwant %q", got, want)
	}

	// The screen alone is its last rows, the long line wrapped.
	screen, err := m.ScreenText(ctx, term.ID)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(screen, "line 50\n") || !strings.HasSuffix(screen, "0000000000\n0000000007\ndone") {
		t.Errorf("ScreenText = %q", screen)
	}

	if _, err := m.ScrollbackText(ctx, "nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("ScrollbackText(unknown) err = %v, want ErrNotFound", err)
	}
	_ = m.Kill(ctx, term.ID)
}
