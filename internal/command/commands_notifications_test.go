package command_test

import (
	"context"
	"errors"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/api"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	"github.com/alexwaumann/code-foundry/internal/store/settings/settingstest"
)

// valuesSettings is a SettingsBackend whose Get returns fixed values (an older daemon's,
// or a hand-edited file's).
type valuesSettings struct {
	codefoundryv1connect.UnimplementedSettingsServiceHandler
	values map[string]string
}

func (s valuesSettings) Get(context.Context, *connect.Request[v1.GetSettingsRequest]) (*connect.Response[v1.GetSettingsResponse], error) {
	return connect.NewResponse(&v1.GetSettingsResponse{Settings: &v1.SettingsSnapshot{Values: s.values}}), nil
}

func TestNotificationsTest(t *testing.T) {
	tests := []struct {
		name     string
		stored   string // notifications.sound_volume written first ("" leaves the default)
		backend  command.SettingsBackend
		args     map[string]string
		want     int32
		wantMsg  string
		wantErr  error
		wantCode connect.Code
	}{
		{name: "default volume", want: 50, wantMsg: "alert sound at 50%: delivered=1"},
		{name: "the setting's volume", stored: "15", want: 15, wantMsg: "alert sound at 15%: delivered=1"},
		{name: "explicit volume wins", stored: "15", args: map[string]string{"volume": "80"}, want: 80},
		{name: "explicit zero", args: map[string]string{"volume": "0"}, want: 0, wantMsg: "alert sound at 0%: delivered=1"},
		{name: "explicit volume above 100", args: map[string]string{"volume": "101"}, wantErr: command.ErrInvalidArgs},
		{name: "explicit negative volume", args: map[string]string{"volume": "-1"}, wantErr: command.ErrInvalidArgs},
		{name: "not a number", args: map[string]string{"volume": "loud"}, wantErr: command.ErrInvalidArgs},
		{name: "a daemon without the setting gets the default", backend: valuesSettings{values: map[string]string{}}, want: 50},
		{name: "an out-of-range value is clamped", backend: valuesSettings{values: map[string]string{"notifications.sound_volume": "250"}}, want: 100},
		{name: "settings unavailable", backend: codefoundryv1connect.UnimplementedSettingsServiceHandler{}, wantCode: connect.CodeUnimplemented},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx := context.Background()
			b := tt.backend
			if b == nil {
				store, err := settingstest.New(ctx, t.TempDir(), nil, nil)
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = store.Close() })
				if tt.stored != "" {
					if _, err := store.Update(ctx, map[string]string{"notifications.sound_volume": tt.stored}); err != nil {
						t.Fatal(err)
					}
				}
				b = api.NewSettings(store)
			}
			reg := command.NewRegistry()
			e := &commandtest.Emitter{Delivered: 1}
			if err := command.RegisterNotifications(reg, b, e); err != nil {
				t.Fatal(err)
			}
			res, err := reg.Invoke(ctx, command.Context{}, "notifications.test", tt.args)
			switch {
			case tt.wantCode != 0:
				if connect.CodeOf(err) != tt.wantCode {
					t.Fatalf("err = %v, want code %v", err, tt.wantCode)
				}
				return
			case !errors.Is(err, tt.wantErr):
				t.Fatalf("err = %v, want %v", err, tt.wantErr)
			}
			if err != nil {
				if n := len(e.Intents()); n != 0 {
					t.Errorf("emitted %d intents on error", n)
				}
				return
			}
			in := e.Intents()
			if len(in) != 1 || in[0].GetPlayAlertSound() == nil {
				t.Fatalf("intents = %v, want one PlayAlertSound", in)
			}
			if got := in[0].GetPlayAlertSound().GetVolume(); got != tt.want {
				t.Errorf("volume = %d, want %d", got, tt.want)
			}
			if tt.wantMsg != "" && res.Message != tt.wantMsg {
				t.Errorf("message = %q, want %q", res.Message, tt.wantMsg)
			}
			if js, _ := res.EncodeJSON(); js != `{"delivered":1}` {
				t.Errorf("json = %s", js)
			}
		})
	}
}
