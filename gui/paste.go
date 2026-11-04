package main

import (
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	// pasteSettle lets the pasteboard's new contents land before the keys go out.
	pasteSettle = 50 * time.Millisecond
	// pasteRead and pasteRestoreAfter give the app in front time to read the pasteboard
	// before the old contents come back: a paste is handled when the app gets to it.
	pasteRead         = 100 * time.Millisecond
	pasteRestoreAfter = 500 * time.Millisecond
)

// frontApp is the app in front.
type frontApp struct {
	PID  int
	Name string
	// Bundle is its .app path; "" for an executable without one.
	Bundle string
}

// pasteHost is what a paste needs from the system. Calls come from one thread.
type pasteHost interface {
	// Save copies the pasteboard's items in memory. skipped counts the types of them
	// that gave no data and so will not come back.
	Save() (items, skipped int)
	// Write replaces the pasteboard with text, marked transient, and returns its
	// changeCount, which is valid even on an error: the old contents are gone by then.
	Write(text string) (changeCount int64, err error)
	// Post sends Cmd+V. macOS drops the events without a word if it does not allow
	// them, so a nil error says nothing about delivery.
	Post() error
	// Restore puts the saved items back, only if the changeCount is still ours, and
	// says whether it did.
	Restore(changeCount int64) (bool, error)
}

// pasteText pastes text into the app in front through the pasteboard, then gives the
// pasteboard back unless something else wrote to it in the meantime. say reports each
// step and is logged, so it never carries the text; wait is time.Sleep outside tests.
func pasteText(host pasteHost, text string, wait func(time.Duration), say func(string)) error {
	items, skipped := host.Save()
	say(fmt.Sprintf("clipboard saved: %d items, %d types unreadable", items, skipped))
	count, err := host.Write(text)
	if err != nil {
		restorePasteboard(host, count, say)
		return fmt.Errorf("write clipboard: %w", err)
	}
	say(fmt.Sprintf("clipboard written: changeCount %d", count))
	wait(pasteSettle)
	if err := host.Post(); err != nil {
		restorePasteboard(host, count, say)
		return fmt.Errorf("post Cmd+V: %w", err)
	}
	say("Cmd+V posted (macOS gives no error if it drops it)")
	wait(pasteRead)
	wait(pasteRestoreAfter)
	restorePasteboard(host, count, say)
	return nil
}

func restorePasteboard(host pasteHost, count int64, say func(string)) {
	switch restored, err := host.Restore(count); {
	case err != nil:
		say("clipboard not restored: " + err.Error())
	case restored:
		say("clipboard restored")
	default:
		say("clipboard left alone: something else changed it since our write")
	}
}

// pasteAction is what becomes of the text of a counted hold.
type pasteAction int

const (
	pasteNothing   pasteAction = iota // nothing was said
	pasteClipboard                    // left on the clipboard as a normal entry, for the user to paste
	pasteKeys                         // Cmd+V through the pasteboard, which then comes back
	pasteTyped                        // typed: the app has the clipboard race
)

func (a pasteAction) String() string {
	switch a {
	case pasteClipboard:
		return "left on the clipboard"
	case pasteKeys:
		return "pasted"
	case pasteTyped:
		return "typed"
	}
	return "nothing to paste"
}

// pasteFacts is what the decision reads, once the text is ready.
type pasteFacts struct {
	Text           string
	Pressed, Front frontApp
	// Secure: secure event input is on, so a password field probably has the keyboard.
	Secure bool
	// Trusted: Accessibility is still granted. Without it macOS drops Cmd+V silently, and
	// the old clipboard coming back would then lose the text.
	Trusted bool
	// Race: the app in front has the clipboard race (hasClipboardRace).
	Race bool
}

// decidePaste says what to do with the text. Keys only go to the app the user was in when
// they pressed the hold key: anywhere else, or into a password field, they could land
// somewhere nobody meant, so the text waits on the clipboard.
func decidePaste(f pasteFacts) pasteAction {
	switch {
	case f.Text == "":
		return pasteNothing
	case f.Pressed.PID == 0, f.Front.PID != f.Pressed.PID, f.Secure, !f.Trusted:
		return pasteClipboard
	case f.Race:
		return pasteTyped
	}
	return pasteKeys
}

// joinPhrases makes one text of a session's phrases: each trimmed, one space between
// them, none before closing punctuation or after an opening bracket. Capitalisation is
// the engine's, as in a composer (phraseAtCaret in lib/dictation.ts).
func joinPhrases(phrases []string) string {
	var b strings.Builder
	for _, p := range phrases {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		if b.Len() > 0 && spaceBetween(b.String(), p) {
			b.WriteByte(' ')
		}
		b.WriteString(p)
	}
	return b.String()
}

func spaceBetween(before, next string) bool {
	last, _ := utf8.DecodeLastRuneInString(before)
	first, _ := utf8.DecodeRuneInString(next)
	return !strings.ContainsRune("([{“‘«", last) && !strings.ContainsRune(",.;:!?…)]}”’»", first)
}

// clipboardRaceChromium are the Chromium majors where a pasted text can arrive before the
// page reads the clipboard, so the old contents paste instead (Hex's has_clipboard_race).
var clipboardRaceChromium = map[int]bool{155: true, 156: true}

// hasClipboardRace reports whether the app at bundle embeds a Chromium 155 or 156
// framework: Contents/Frameworks/<Name> Framework.framework/Versions/<a.b.c.d>. Every
// version found counts, so a browser that staged an update is covered whichever one runs;
// typing works in any version, so a wrong guess costs nothing. Electron's Versions/A has
// no version, and an app without a bundle has no such folder.
func hasClipboardRace(bundle string) bool {
	if bundle == "" {
		return false
	}
	versions, err := filepath.Glob(filepath.Join(bundle, "Contents", "Frameworks", "*Framework.framework", "Versions", "*"))
	if err != nil {
		return false
	}
	for _, v := range versions {
		if clipboardRaceChromium[chromiumMajor(filepath.Base(v))] {
			return true
		}
	}
	return false
}

// chromiumMajor is the first of a four-part version ("155.0.7000.12"), else 0.
func chromiumMajor(version string) int {
	parts := strings.Split(version, ".")
	if len(parts) != 4 {
		return 0
	}
	for _, p := range parts {
		if _, err := strconv.Atoi(p); err != nil {
			return 0
		}
	}
	n, _ := strconv.Atoi(parts[0])
	return n
}
