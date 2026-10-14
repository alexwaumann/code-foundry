package command

import (
	"context"
	"fmt"
	"strconv"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// The alert volume setting (internal/store/settings, which imports this package, so the
// key is repeated here) and its default.
const (
	keySoundVolume     = "notifications.sound_volume"
	defaultSoundVolume = 50
)

// soundVolume is the alert volume to preview: the explicit volume arg, else the
// notifications.sound_volume setting (its default when the daemon's settings lack it or
// it does not parse), clamped to 0–100.
func soundVolume(ctx context.Context, b SettingsBackend, a Args) (int, error) {
	if a.Has("volume") {
		v := a.Int("volume")
		if v < 0 || v > 100 {
			return 0, InvalidArg("volume", "volume %d is outside 0–100", v)
		}
		return v, nil
	}
	res, err := b.Get(ctx, connect.NewRequest(&v1.GetSettingsRequest{}))
	if err != nil {
		return 0, fmt.Errorf("read %s: %w", keySoundVolume, err)
	}
	v, err := strconv.Atoi(res.Msg.GetSettings().GetValues()[keySoundVolume])
	if err != nil {
		return defaultSoundVolume, nil
	}
	return min(max(v, 0), 100), nil
}

// RegisterNotifications registers notifications.test, which makes every connected GUI
// play the attention alert sound once (UiIntent.PlayAlertSound): a preview, regardless of
// focus, the alert cooldown and the notifications.sound toggle
// (docs/notes/dock-alerts.md). The settings page's Play button runs it with the slider's
// value.
func RegisterNotifications(r *Registry, b SettingsBackend, e Emitter) error {
	return r.Register(Command{
		Name:        "notifications.test",
		Title:       "Notifications: Play Alert Sound",
		Description: "Play the alert sound at the current volume.",
		Category:    "Settings",
		Args: []ArgSpec{{Name: "volume", Type: Int,
			Description: "Volume in percent of the Mac's output volume, 0–100 (default: the notifications.sound_volume setting)"}},
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			v, err := soundVolume(ctx, b, a)
			if err != nil {
				return Result{}, err
			}
			n := e.Emit(&v1.UiIntent{Intent: &v1.UiIntent_PlayAlertSound_{PlayAlertSound: &v1.UiIntent_PlayAlertSound{Volume: int32(v)}}})
			return Result{Message: fmt.Sprintf("alert sound at %d%%: delivered=%d", v, n), JSON: EmitResult{Delivered: n}}, nil
		},
	})
}
