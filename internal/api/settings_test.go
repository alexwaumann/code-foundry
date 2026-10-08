package api

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/awaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/awaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/awaumann/code-foundry/internal/bus"
	"github.com/awaumann/code-foundry/internal/store/settings"
	"github.com/awaumann/code-foundry/internal/store/settings/settingstest"
)

func newSettingsFake(t *testing.T, b *bus.Bus) (*settingstest.Fake, string) {
	t.Helper()
	dir := t.TempDir()
	f, err := settingstest.New(context.Background(), dir, b, []settings.CommandInfo{
		{Name: "session.new", Title: "New Session", Category: "Session", Keybindings: []string{"cmd+n"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = f.Close() })
	return f, filepath.Join(dir, settings.FileName)
}

func TestSettingsService(t *testing.T) {
	store, path := newSettingsFake(t, nil)
	h := NewSettings(store)
	ctx := context.Background()

	schema, err := h.GetSchema(ctx, connect.NewRequest(&v1.GetSettingsSchemaRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	byKey := map[string]*v1.SettingField{}
	for _, f := range schema.Msg.GetFields() {
		byKey[f.GetKey()] = f
	}
	if fs := byKey["appearance.font_size"]; fs.GetType() != v1.SettingType_SETTING_TYPE_INT || fs.GetMin() != 9 || fs.GetMax() != 28 || fs.GetDefaultValue() != "13" {
		t.Errorf("font_size field = %v", fs)
	}
	if kb := byKey["keybindings.session.new"]; kb.GetType() != v1.SettingType_SETTING_TYPE_KEYBINDING || kb.GetDefaultValue() != "cmd+n" {
		t.Errorf("keybinding field = %v", kb)
	}
	if !byKey["sessions.scrollback_lines"].GetRestartRequired() || len(schema.Msg.GetGroups()) != len(settings.Groups) {
		t.Errorf("restart flag or groups missing")
	}

	got, err := h.Get(ctx, connect.NewRequest(&v1.GetSettingsRequest{}))
	if err != nil || got.Msg.GetSettings().GetValues()["appearance.theme"] != "system" || got.Msg.GetSettings().GetPath() != path {
		t.Fatalf("Get = %v, %v", got, err)
	}

	up, err := h.Update(ctx, connect.NewRequest(&v1.UpdateSettingsRequest{Values: map[string]string{"appearance.theme": "dark"}}))
	if err != nil || up.Msg.GetSettings().GetValues()["appearance.theme"] != "dark" {
		t.Fatalf("Update = %v, %v", up, err)
	}

	_, err = h.Update(ctx, connect.NewRequest(&v1.UpdateSettingsRequest{Values: map[string]string{"keybindings.session.new": "cmd+k"}}))
	var ce *connect.Error
	if !errors.As(err, &ce) || ce.Code() != connect.CodeInvalidArgument {
		t.Fatalf("err = %v, want InvalidArgument", err)
	}
	var detail *v1.SettingsValidationErrors
	for _, d := range ce.Details() {
		if m, derr := d.Value(); derr == nil {
			detail, _ = m.(*v1.SettingsValidationErrors)
		}
	}
	if detail == nil || len(detail.GetErrors()) != 1 || detail.GetErrors()[0].GetKey() != "keybindings.session.new" ||
		detail.GetErrors()[0].GetMessage() != "cmd+k is reserved by the app" {
		t.Fatalf("detail = %v", detail)
	}
}

func TestSettingsErrorCodes(t *testing.T) {
	tests := []struct {
		err  error
		want connect.Code
	}{
		{&settings.ValidationError{Issues: []settings.Issue{{Key: "a.b", Message: "bad"}}}, connect.CodeInvalidArgument},
		{settings.ErrFileInvalid, connect.CodeFailedPrecondition},
		{context.Canceled, connect.CodeCanceled},
		{errors.New("disk full"), connect.CodeInternal},
	}
	for _, tt := range tests {
		if got := connect.CodeOf(settingsError(tt.err)); got != tt.want {
			t.Errorf("settingsError(%v) = %v, want %v", tt.err, got, tt.want)
		}
	}
}

// Settings snapshots ride EventService: one on connect, one per change, including
// changes made by editing the file by hand.
func TestEventsCarrySettings(t *testing.T) {
	b := bus.New()
	store, path := newSettingsFake(t, b)
	route := NewEvents(EventsDeps{Bus: b, Settings: store}).Route()
	mux := http.NewServeMux()
	mux.Handle(route.Path, route.Handler)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	client := codefoundryv1connect.NewEventServiceClient(srv.Client(), srv.URL)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	s, err := client.Watch(ctx, connect.NewRequest(&v1.WatchEventsRequest{Sources: []v1.EventSource{v1.EventSource_EVENT_SOURCE_SETTINGS}}))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	next := func() *v1.SettingsSnapshot {
		t.Helper()
		if !s.Receive() {
			t.Fatalf("stream ended: %v", s.Err())
		}
		return s.Msg().GetSettings().GetSnapshot()
	}
	if first := next(); first.GetValues()["appearance.font_size"] != "13" {
		t.Fatalf("first = %v", first)
	}
	if _, err := store.Update(ctx, map[string]string{"appearance.font_size": "15"}); err != nil {
		t.Fatal(err)
	}
	if got := next(); got.GetValues()["appearance.font_size"] != "15" {
		t.Fatalf("after Update = %v", got.GetValues()["appearance.font_size"])
	}
	if err := os.WriteFile(path, []byte("[appearance]\nfont_size = 17\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := next(); got.GetValues()["appearance.font_size"] != "17" {
		t.Fatalf("after hand edit = %v", got.GetValues()["appearance.font_size"])
	}
}
