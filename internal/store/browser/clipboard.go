package browser

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"unicode/utf8"
)

// Headless Chrome's clipboard is its own, in memory: nothing a page copies reaches the Mac's
// and nothing on the Mac's reaches a page (measured; docs/notes/chrome-surface.md). So a page
// can never read or write the user's clipboard, and both directions are the user's doing. Chrome's
// clipboard has no owner and every surface shares it, so at rest it holds clipboardEmpty, and
// whatever else is on it is what just changed:
//
//   - Paste: the text goes on Chrome's clipboard through a page of our own, and cmd+v then runs in
//     the page, so its paste handlers run in the focused frame and nowhere else. No script of any
//     page sees the text on the way, and no page gets a gesture the user did not make. The
//     clipboard is marked read straight after.
//   - Copy: the clipboard is marked just before a cmd+c goes to the page, so what is there
//     afterwards is what that key press changed. Reading it is a paste into our own page, so no
//     site needs clipboard permission, and it goes to the Mac's through Options.SetClipboard. The
//     window could not do it: a reply arrives after the key event's gesture has ended.
//   - A page's Copy button: after each click a text on the clipboard moves to the surface it was
//     clicked in, and waits for the user's click on the strip.

// clipboard is the scratch page that reads Chrome's clipboard. mu is held across whatever must
// see the clipboard unchanged.
type clipboard struct {
	mu      sync.Mutex
	session string
}

// maxClip bounds what comes off Chrome's clipboard, in UTF-16 units: a page can put 70 MB there.
// The field's maxlength cuts a paste off cheaply, and scratchRead reads a full field as too long.
const maxClip = maxText

var scratchInit = fmt.Sprintf(`document.body.innerHTML = "<textarea id=c maxlength=%d></textarea>"; 1`, maxClip+1)

var scratchRead = fmt.Sprintf(`(() => { const c = document.getElementById("c"); const v = c.value; c.value = ""; return v.length > %d ? "" : v; })()`, maxClip)

const scratchFocus = `document.getElementById("c").focus(); 1`

// clipboardEmpty is what Chrome's clipboard holds at rest. There is no way to empty it, and a
// cmd+c with nothing selected leaves it as it was, which must not then put an old text on the
// Mac's clipboard over what the user has there now.
const clipboardEmpty = "\u2060"

// scratchHolding selects text in the scratch field, for a copy to take.
func scratchHolding(text string) string {
	return `(() => { const c = document.getElementById("c"); c.value = ` + jsString(text) + `; c.focus(); c.select(); return 1; })()`
}

// scratch attaches to a page of our own, once per Chrome. Needs clip.mu.
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

// evaluate runs expression in our scratch page, and nowhere else: it is the only page with no
// site's script to see what goes through it.
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
		"expression": expression, "returnByValue": true, "awaitPromise": true,
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

// editKey runs an editing command by its key, in session.
func (in *instance) editKey(ctx context.Context, session string, k KeyEvent) error {
	for _, typ := range []string{"rawKeyDown", "keyUp"} {
		k.Type = typ
		_, p, err := k.params()
		if err != nil {
			return err
		}
		if err := in.call(ctx, session, "Input.dispatchKeyEvent", p, nil); err != nil {
			return err
		}
	}
	return nil
}

var (
	cmdC = KeyEvent{Key: "c", Code: "KeyC", KeyCode: 67, Modifiers: modMeta}
	cmdV = KeyEvent{Key: "v", Code: "KeyV", KeyCode: 86, Modifiers: modMeta}
)

// readClipboard is the text on Chrome's clipboard, if it changed since it was last marked, and
// marks it. Needs clip.mu.
func (in *instance) readClipboard(ctx context.Context) (string, error) {
	session, err := in.scratch(ctx)
	if err != nil {
		return "", err
	}
	if err := evaluate(ctx, in, session, scratchFocus, nil); err != nil {
		return "", err
	}
	if err := in.editKey(ctx, session, cmdV); err != nil {
		return "", err
	}
	var text string
	if err := evaluate(ctx, in, session, scratchRead, &text); err != nil {
		return "", err
	}
	if text == clipboardEmpty {
		return "", nil
	}
	return text, in.writeClipboard(ctx, clipboardEmpty)
}

// writeClipboard puts text on Chrome's clipboard, from our own page. Needs clip.mu.
func (in *instance) writeClipboard(ctx context.Context, text string) error {
	session, err := in.scratch(ctx)
	if err != nil {
		return err
	}
	if err := evaluate(ctx, in, session, scratchHolding(text), nil); err != nil {
		return err
	}
	if err := in.editKey(ctx, session, cmdC); err != nil {
		return err
	}
	return evaluate(ctx, in, session, scratchRead, nil)
}

// armCopy readies a surface for a cmd+c: the mark on Chrome's clipboard makes what the key press
// changes, and nothing before it, what Copy finds.
func (s *Store) armCopy(ctx context.Context, in *instance, sf *surface) error {
	in.clip.mu.Lock()
	defer in.clip.mu.Unlock()
	if err := in.writeClipboard(ctx, clipboardEmpty); err != nil {
		return err
	}
	s.mu.Lock()
	sf.copyArmed = true
	s.mu.Unlock()
	return nil
}

// Copy moves the user's copy to the Mac's clipboard and returns how much went, nothing when there
// was nothing new. It takes what the last cmd+c or cmd+x of this surface changed, or with
// fromPage what a page's own Copy button left here.
func (s *Store) Copy(ctx context.Context, key string, fromPage bool) (int, error) {
	in, sf, _, err := s.shown(key)
	if err != nil {
		return 0, err
	}
	text := ""
	if fromPage {
		s.mu.Lock()
		text, sf.copied = sf.copied, ""
		s.mu.Unlock()
	} else {
		s.mu.Lock()
		armed := sf.copyArmed
		sf.copyArmed = false
		s.mu.Unlock()
		if !armed {
			return 0, nil
		}
		in.clip.mu.Lock()
		text, err = in.readClipboard(ctx)
		in.clip.mu.Unlock()
		if err != nil {
			return 0, err
		}
	}
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
	in.clip.mu.Lock()
	text, err := in.readClipboard(ctx)
	in.clip.mu.Unlock()
	if err != nil || text == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	sf.copied = text
	sf.state.Copied++
	sf.publish()
}

// Paste puts the user's text in the page as a real paste: see the top of this file.
func (s *Store) Paste(ctx context.Context, key, text string) error {
	if len(text) > maxText {
		return ErrBadInput
	}
	in, _, t, err := s.shown(key)
	if err != nil {
		return err
	}
	s.mu.Lock()
	held := t.dialog != nil
	s.mu.Unlock()
	if held {
		return nil // as for any input: a dialog holds the page
	}
	in.clip.mu.Lock()
	defer in.clip.mu.Unlock()
	if err := in.writeClipboard(ctx, text); err != nil {
		return err
	}
	pasted := in.editKey(ctx, t.session, cmdV)
	// However the key went, and however long the caller waits, the text does not stay.
	if err := in.writeClipboard(context.WithoutCancel(ctx), clipboardEmpty); err != nil {
		return errors.Join(pasted, err)
	}
	return pasted
}
