package plugin

import (
	"encoding/json"
	"strings"
	"unicode/utf8"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// view/toast (registered with the surface methods in surface_act.go). The host announces
// the success level and the description (docs/notes/toast-plugin-levels.md): an older host
// shows success as info and drops the description.
func init() { hostCapabilities = append(hostCapabilities, pluginsdk.ToastDescriptionCapability) }

// maxToastsPerSecond bounds a plugin's toasts.
const maxToastsPerSecond = 1

// viewToast serves view/toast: to an instance's viewers, or (no instance) to the GUI as
// a notification.
func (a *actor) viewToast(params json.RawMessage) {
	var p pluginsdk.ToastParams
	if err := json.Unmarshal(params, &p); err != nil {
		a.hostLog("bad view/toast: %v", err)
		return
	}
	t, ok := cleanToast(p)
	if !ok {
		return
	}
	h := a.m.surf
	h.toastMu.Lock()
	rl := h.toasts[a.name]
	if rl == nil {
		rl = &rateLimiter{}
		h.toasts[a.name] = rl
	}
	h.toastMu.Unlock()
	if !rl.allow(a.m.opts.Now(), maxToastsPerSecond) {
		a.hostLog("dropped a toast: at most %d a second", maxToastsPerSecond)
		return
	}
	if t.Instance != "" {
		in, err := h.instanceFor(a, t.Instance)
		if err != nil {
			a.hostLog("dropped a toast: %v", err)
			return
		}
		in.toast(t)
		return
	}
	if a.m.opts.Emitter == nil {
		return
	}
	pl, _ := a.m.Snapshot().Plugin(a.name)
	a.m.opts.Emitter.Emit(&v1.UiIntent{Intent: &v1.UiIntent_Notify_{Notify: toastNotify(t, pl.DisplayName())}})
}

// toastLevels are view/toast's levels and the notify intent's level for each.
var toastLevels = map[string]v1.UiIntent_Notify_Level{
	pluginsdk.ToastSuccess: v1.UiIntent_Notify_LEVEL_SUCCESS, pluginsdk.ToastInfo: v1.UiIntent_Notify_LEVEL_INFO,
	pluginsdk.ToastAttention: v1.UiIntent_Notify_LEVEL_WARNING, pluginsdk.ToastError: v1.UiIntent_Notify_LEVEL_ERROR,
}

// cleanToast is a plugin's toast as viewers get it: text and description trimmed and cut
// to their limits, an unknown level info. No text: no toast (a description alone is not
// one; the text is the title).
func cleanToast(p pluginsdk.ToastParams) (SurfaceToast, bool) {
	text := truncateToast(p.Text, maxToastText)
	if text == "" {
		return SurfaceToast{}, false
	}
	level := p.Level
	if _, ok := toastLevels[level]; !ok {
		level = pluginsdk.ToastInfo
	}
	return SurfaceToast{Instance: p.Instance, Level: level, Text: text, Description: truncateToast(p.Description, maxToastDescription)}, true
}

func truncateToast(s string, limit int) string {
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) > limit {
		s = string([]rune(s)[:limit-1]) + "…"
	}
	return s
}

// toastNotify is a toast without an instance as a notification. Without a description it
// is titled with the plugin's name and the text under it, as before descriptions; with
// one, the text is the title and the description goes under it, like every other toast.
func toastNotify(t SurfaceToast, pluginName string) *v1.UiIntent_Notify {
	n := &v1.UiIntent_Notify{Level: toastLevels[t.Level], Title: pluginName, Body: t.Text}
	if t.Description != "" {
		n.Title, n.Body = t.Text, t.Description
	}
	return n
}
