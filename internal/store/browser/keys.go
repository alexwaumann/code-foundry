package browser

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"time"
)

// Modifier bits of the protocol, which the GUI sends as they are.
const (
	modAlt   = 1
	modCtrl  = 2
	modMeta  = 4
	modShift = 8
)

// MouseEvent is Input.dispatchMouseEvent's, in CSS pixels of the page.
type MouseEvent struct {
	Type, Button   string
	X, Y           float64
	Buttons        int
	ClickCount     int
	Modifiers      int
	DeltaX, DeltaY float64
}

// KeyEvent is Input.dispatchKeyEvent's.
type KeyEvent struct {
	Type, Key, Code string
	Text            string
	KeyCode         int
	Modifiers       int
	Location        int
	AutoRepeat      bool
}

// InputEvent is one of a mouse event, a key event or text to insert.
type InputEvent struct {
	Mouse *MouseEvent
	Key   *KeyEvent
	Text  string
}

// maxInputBatch and maxText bound one Input call.
const (
	maxInputBatch = 256
	maxText       = 1 << 20
)

// copySettle is how long a page gets to finish a Copy button's work after the click.
const copySettle = 150 * time.Millisecond

// ErrBadInput refuses an event no GUI would send.
var ErrBadInput = errors.New("bad input event")

var mouseTypes = []string{"mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"}

var mouseButtons = []string{"none", "left", "middle", "right", "back", "forward"}

var keyTypes = []string{"keyDown", "rawKeyDown", "keyUp"}

// chord is a key with its modifiers, as the editing table reads it.
type chord struct {
	mods int
	code string
}

// editCommands are the Mac's text system bindings. On a Mac those live in AppKit, not in the
// page, so headless Chrome does nothing for cmd+a or option+left unless the key event names its
// editing command. Plain keys need none.
var editCommands = map[chord][]string{
	{modMeta, "KeyA"}:                  {"selectAll"},
	{modMeta, "KeyC"}:                  {"copy"},
	{modMeta, "KeyX"}:                  {"cut"},
	{modMeta, "KeyV"}:                  {"paste"},
	{modMeta, "KeyZ"}:                  {"undo"},
	{modMeta | modShift, "KeyZ"}:       {"redo"},
	{modMeta, "Backspace"}:             {"deleteToBeginningOfLine"},
	{modMeta, "ArrowLeft"}:             {"moveToLeftEndOfLine"},
	{modMeta, "ArrowRight"}:            {"moveToRightEndOfLine"},
	{modMeta, "ArrowUp"}:               {"moveToBeginningOfDocument"},
	{modMeta, "ArrowDown"}:             {"moveToEndOfDocument"},
	{modMeta | modShift, "ArrowLeft"}:  {"moveToLeftEndOfLineAndModifySelection"},
	{modMeta | modShift, "ArrowRight"}: {"moveToRightEndOfLineAndModifySelection"},
	{modMeta | modShift, "ArrowUp"}:    {"moveToBeginningOfDocumentAndModifySelection"},
	{modMeta | modShift, "ArrowDown"}:  {"moveToEndOfDocumentAndModifySelection"},
	{modAlt, "Backspace"}:              {"deleteWordBackward"},
	{modAlt, "Delete"}:                 {"deleteWordForward"},
	{modAlt, "ArrowLeft"}:              {"moveWordLeft"},
	{modAlt, "ArrowRight"}:             {"moveWordRight"},
	{modAlt | modShift, "ArrowLeft"}:   {"moveWordLeftAndModifySelection"},
	{modAlt | modShift, "ArrowRight"}:  {"moveWordRightAndModifySelection"},
	{modShift, "ArrowLeft"}:            {"moveLeftAndModifySelection"},
	{modShift, "ArrowRight"}:           {"moveRightAndModifySelection"},
	{modShift, "ArrowUp"}:              {"moveUpAndModifySelection"},
	{modShift, "ArrowDown"}:            {"moveDownAndModifySelection"},
	{modCtrl, "KeyA"}:                  {"moveToBeginningOfParagraph"},
	{modCtrl, "KeyE"}:                  {"moveToEndOfParagraph"},
	{modCtrl, "KeyK"}:                  {"deleteToEndOfParagraph"},
	{modCtrl, "KeyD"}:                  {"deleteForward"},
	{modCtrl, "KeyH"}:                  {"deleteBackward"},
}

// commandsFor is what a key down also runs.
func commandsFor(k *KeyEvent) []string {
	if k.Type == "keyUp" {
		return nil
	}
	return editCommands[chord{k.Modifiers & (modAlt | modCtrl | modMeta | modShift), k.Code}]
}

func (m *MouseEvent) params() (string, map[string]any, error) {
	if !slices.Contains(mouseTypes, m.Type) || !slices.Contains(mouseButtons, m.Button) {
		return "", nil, ErrBadInput
	}
	p := map[string]any{
		"type": m.Type, "x": m.X, "y": m.Y, "button": m.Button, "buttons": m.Buttons,
		"clickCount": m.ClickCount, "modifiers": m.Modifiers,
	}
	if m.Type == "mouseWheel" {
		p["deltaX"], p["deltaY"] = m.DeltaX, m.DeltaY
	}
	return "Input.dispatchMouseEvent", p, nil
}

func (k *KeyEvent) params() (string, map[string]any, error) {
	if !slices.Contains(keyTypes, k.Type) {
		return "", nil, ErrBadInput
	}
	p := map[string]any{
		"type": k.Type, "key": k.Key, "code": k.Code, "windowsVirtualKeyCode": k.KeyCode,
		"modifiers": k.Modifiers, "location": k.Location, "autoRepeat": k.AutoRepeat,
	}
	if k.Text != "" {
		p["text"], p["unmodifiedText"] = k.Text, k.Text
	}
	if c := commandsFor(k); c != nil {
		p["commands"] = c
	}
	return "Input.dispatchKeyEvent", p, nil
}

// Input sends a batch of events to the page showing, in order. A dialog holds the page, and
// an input event would wait on it, so while one is open input is dropped.
func (s *Store) Input(ctx context.Context, key string, events []InputEvent) error {
	if len(events) > maxInputBatch {
		return ErrBadInput
	}
	in, sf, t, err := s.shown(key)
	if err != nil {
		return err
	}
	s.mu.Lock()
	held := t.dialog != nil
	s.mu.Unlock()
	if held {
		return nil
	}
	clicked := false
	for _, e := range events {
		method, params, err := e.encode()
		if err != nil {
			return err
		}
		// Before the event goes: the page's answer to it is what a download comes from.
		if e.clicks() || (e.entersKey() && s.onLink(ctx, in, t)) {
			s.mu.Lock()
			sf.gesture = time.Now()
			s.mu.Unlock()
		}
		if e.copies() {
			if err := s.armCopy(ctx, in, sf); err != nil {
				return err
			}
		}
		if err := in.call(ctx, t.session, method, params, nil); err != nil {
			return err
		}
		clicked = clicked || (e.Mouse != nil && e.Mouse.Type == "mouseReleased")
		if e.mayOpenSelect() {
			s.afterPress(in, t, e.Mouse)
		}
	}
	if clicked {
		s.mu.Lock()
		sf.clicks++
		click := sf.clicks
		s.mu.Unlock()
		time.AfterFunc(copySettle, func() { s.noticeCopied(context.Background(), key, click) })
	}
	return nil
}

// clicks is what a person does to mean "do that", where a page can have been waiting for any key
// at all: typing is no gesture, and neither is Space, which comes with every word.
func (e InputEvent) clicks() bool {
	m := e.Mouse
	return m != nil && m.Type == "mouseReleased" && m.Button == "left"
}

// entersKey is an Enter going down, which is a gesture only on a link (onLink): anywhere else it
// is the end of a line of typing.
func (e InputEvent) entersKey() bool {
	k := e.Key
	return k != nil && k.Type != "keyUp" && !k.AutoRepeat && k.Key == "Enter"
}

// mayOpenSelect is a press the page's select may have taken (helper.go).
func (e InputEvent) mayOpenSelect() bool {
	if m := e.Mouse; m != nil {
		return m.Type == "mousePressed" && m.Button == "left"
	}
	k := e.Key
	return k != nil && k.Type != "keyUp" && slices.Contains(selectKeys, k.Key)
}

// copies is a cmd+c or cmd+x going to the page.
func (e InputEvent) copies() bool {
	if e.Key == nil {
		return false
	}
	c := commandsFor(e.Key)
	return slices.Contains(c, "copy") || slices.Contains(c, "cut")
}

func (e InputEvent) encode() (string, map[string]any, error) {
	switch {
	case e.Mouse != nil:
		return e.Mouse.params()
	case e.Key != nil:
		return e.Key.params()
	case e.Text != "" && len(e.Text) <= maxText:
		return "Input.insertText", map[string]any{"text": e.Text}, nil
	}
	return "", nil, ErrBadInput
}

// jsString is s as a JavaScript string literal.
func jsString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
