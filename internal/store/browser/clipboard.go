package browser

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"unicode/utf8"
)

// Headless Chrome's clipboard is its own, in memory: nothing a page copies reaches the Mac's
// and nothing on the Mac's reaches a page (measured; docs/notes/chrome-surface.md). So a page
// can never read or write the user's clipboard, and both directions are the user's doing:
//
//   - Paste: the window hands over the text of the paste the user made, which goes on
//     Chrome's clipboard, and cmd+v then runs in the page, so its paste handlers run.
//   - Copy: reading Chrome's clipboard is a paste into a page of our own, so no site needs
//     clipboard permission, and the text goes to the Mac's through Options.SetClipboard. The
//     window could not do it: a reply arrives after the key event's gesture has ended.

// clipboard is the scratch page that reads Chrome's clipboard.
type clipboard struct {
	mu      sync.Mutex
	session string
	last    string
}

const scratchInit = `document.body.innerHTML = "<textarea id=c></textarea>"; 1`

const scratchRead = `(() => { const c = document.getElementById("c"); const v = c.value; c.value = ""; return v; })()`

const scratchFocus = `document.getElementById("c").focus(); 1`

// scratch attaches to a page of our own, once per Chrome.
func (in *instance) scratch(ctx context.Context) (string, error) {
	if in.clip.session != "" {
		return in.clip.session, nil
	}
	var created struct {
		TargetID string `json:"targetId"`
	}
	if err := in.call(ctx, "", "Target.createTarget", map[string]any{"url": "about:blank"}, &created); err != nil {
		return "", err
	}
	var attached struct {
		SessionID string `json:"sessionId"`
	}
	if err := in.call(ctx, "", "Target.attachToTarget", map[string]any{"targetId": created.TargetID, "flatten": true}, &attached); err != nil {
		return "", err
	}
	if err := in.call(ctx, attached.SessionID, "Emulation.setFocusEmulationEnabled", map[string]any{"enabled": true}, nil); err != nil {
		return "", err
	}
	if err := evaluate(ctx, in, attached.SessionID, scratchInit, nil); err != nil {
		return "", err
	}
	in.clip.session = attached.SessionID
	return attached.SessionID, nil
}

// evaluate runs expression in the session's main world; only ever this file's own expressions,
// in this file's own page, or a string literal for Paste.
func evaluate(ctx context.Context, in *instance, session, expression string, out any) error {
	var res struct {
		Result struct {
			Value json.RawMessage `json:"value"`
		} `json:"result"`
		Exception *struct {
			Text string `json:"text"`
		} `json:"exceptionDetails"`
	}
	err := in.call(ctx, session, "Runtime.evaluate", map[string]any{
		"expression": expression, "returnByValue": true, "awaitPromise": true, "userGesture": true,
	}, &res)
	if err != nil {
		return err
	}
	if res.Exception != nil {
		return fmt.Errorf("evaluate: %s", res.Exception.Text)
	}
	if out != nil && res.Result.Value != nil {
		return json.Unmarshal(res.Result.Value, out)
	}
	return nil
}

// readClipboard is Chrome's clipboard text.
func (in *instance) readClipboard(ctx context.Context) (string, error) {
	in.clip.mu.Lock()
	defer in.clip.mu.Unlock()
	session, err := in.scratch(ctx)
	if err != nil {
		return "", err
	}
	if err := evaluate(ctx, in, session, scratchFocus, nil); err != nil {
		return "", err
	}
	for _, typ := range []string{"rawKeyDown", "keyUp"} {
		p := map[string]any{"type": typ, "key": "v", "code": "KeyV", "windowsVirtualKeyCode": 86, "modifiers": modMeta}
		if typ != "keyUp" {
			p["commands"] = []string{"paste"}
		}
		if err := in.call(ctx, session, "Input.dispatchKeyEvent", p, nil); err != nil {
			return "", err
		}
	}
	var text string
	err = evaluate(ctx, in, session, scratchRead, &text)
	return text, err
}

// Copy moves Chrome's clipboard to the Mac's, for the user's own cmd+c or Copy button. It
// returns how much went: nothing when there was no text.
func (s *Store) Copy(ctx context.Context, key string) (int, error) {
	in, _, _, err := s.shown(key)
	if err != nil {
		return 0, err
	}
	text, err := in.readClipboard(ctx)
	if err != nil {
		return 0, err
	}
	in.clip.mu.Lock()
	in.clip.last = text
	in.clip.mu.Unlock()
	if text == "" {
		return 0, nil
	}
	if err := s.opts.SetClipboard(ctx, text); err != nil {
		return 0, err
	}
	return utf8.RuneCountInString(text), nil
}

// noticeCopied tells a surface when a click left new text on Chrome's clipboard: a page's own
// Copy button, which would otherwise go nowhere the user can reach.
func (s *Store) noticeCopied(ctx context.Context, key string) {
	in, sf, _, err := s.shown(key)
	if err != nil {
		return
	}
	text, err := in.readClipboard(ctx)
	if err != nil {
		return
	}
	in.clip.mu.Lock()
	fresh := text != "" && text != in.clip.last
	in.clip.last = text
	in.clip.mu.Unlock()
	if fresh {
		s.mu.Lock()
		sf.state.Copied++
		sf.publish()
		s.mu.Unlock()
	}
}

// Paste puts the user's text in the page as a real paste, so a page's paste handlers run. A page
// that is not a secure context cannot take the first step and gets the text typed in.
func (s *Store) Paste(ctx context.Context, key, text string) error {
	if len(text) > maxText {
		return ErrBadInput
	}
	in, _, t, err := s.shown(key)
	if err != nil {
		return err
	}
	var ok bool
	expr := "navigator.clipboard.writeText(" + jsString(text) + ").then(() => true, () => false)"
	if err := evaluate(ctx, in, t.session, expr, &ok); err != nil || !ok {
		return in.call(ctx, t.session, "Input.insertText", map[string]any{"text": text}, nil)
	}
	in.clip.mu.Lock()
	in.clip.last = text
	in.clip.mu.Unlock()
	return s.Input(ctx, key, []InputEvent{
		{Key: &KeyEvent{Type: "rawKeyDown", Key: "v", Code: "KeyV", KeyCode: 86, Modifiers: modMeta}},
		{Key: &KeyEvent{Type: "keyUp", Key: "v", Code: "KeyV", KeyCode: 86, Modifiers: modMeta}},
	})
}
