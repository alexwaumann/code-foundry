package api

import (
	"context"
	"errors"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/store/settings"
)

// Settings implements codefoundryv1connect.SettingsServiceHandler over a settings
// store.
type Settings struct {
	store settings.Service
}

var _ codefoundryv1connect.SettingsServiceHandler = (*Settings)(nil)

// NewSettings returns a SettingsService handler.
func NewSettings(store settings.Service) *Settings { return &Settings{store: store} }

// Route mounts the service.
func (h *Settings) Route(opts ...connect.HandlerOption) Route {
	path, handler := codefoundryv1connect.NewSettingsServiceHandler(h, opts...)
	return Route{Path: path, Handler: handler}
}

// GetSchema returns the groups and fields in display order.
func (h *Settings) GetSchema(context.Context, *connect.Request[v1.GetSettingsSchemaRequest]) (*connect.Response[v1.GetSettingsSchemaResponse], error) {
	groups := make([]*v1.SettingGroup, len(settings.Groups))
	for i, g := range settings.Groups {
		groups[i] = &v1.SettingGroup{Id: g.ID, Title: g.Title, Description: g.Description}
	}
	fields := h.store.Fields()
	out := make([]*v1.SettingField, len(fields))
	for i, f := range fields {
		out[i] = &v1.SettingField{
			Key: f.Key, Title: f.Title, Description: f.Description, Group: f.Group, Type: settingTypes[f.Type],
			EnumValues: f.Enum, DefaultValue: f.Default, RestartRequired: f.Restart,
			Min: int64(f.Min), Max: int64(f.Max), Placeholder: f.Placeholder,
		}
	}
	return connect.NewResponse(&v1.GetSettingsSchemaResponse{Groups: groups, Fields: out}), nil
}

// Get returns the current values.
func (h *Settings) Get(context.Context, *connect.Request[v1.GetSettingsRequest]) (*connect.Response[v1.GetSettingsResponse], error) {
	return connect.NewResponse(&v1.GetSettingsResponse{Settings: settingsSnapshotToProto(h.store.Snapshot())}), nil
}

// Update applies a partial change.
func (h *Settings) Update(ctx context.Context, req *connect.Request[v1.UpdateSettingsRequest]) (*connect.Response[v1.UpdateSettingsResponse], error) {
	snap, err := h.store.Update(ctx, req.Msg.GetValues())
	if err != nil {
		return nil, settingsError(err)
	}
	return connect.NewResponse(&v1.UpdateSettingsResponse{Settings: settingsSnapshotToProto(snap)}), nil
}

// Watch streams the current snapshot, then every change.
func (h *Settings) Watch(ctx context.Context, _ *connect.Request[v1.WatchSettingsRequest], stream *connect.ServerStream[v1.SettingsEvent]) error {
	for snap := range h.store.Watch(ctx) {
		if err := stream.Send(settingsEvent(snap)); err != nil {
			return err
		}
	}
	return nil
}

var settingTypes = map[settings.Type]v1.SettingType{
	settings.String:     v1.SettingType_SETTING_TYPE_STRING,
	settings.Int:        v1.SettingType_SETTING_TYPE_INT,
	settings.Bool:       v1.SettingType_SETTING_TYPE_BOOL,
	settings.Enum:       v1.SettingType_SETTING_TYPE_ENUM,
	settings.Path:       v1.SettingType_SETTING_TYPE_PATH,
	settings.Keybinding: v1.SettingType_SETTING_TYPE_KEYBINDING,
}

// settingsError maps store errors: a rejected change is InvalidArgument with a
// SettingsValidationErrors detail; a broken file is FailedPrecondition.
func settingsError(err error) error {
	var ve *settings.ValidationError
	switch {
	case errors.As(err, &ve):
		out := connect.NewError(connect.CodeInvalidArgument, err)
		if d, derr := connect.NewErrorDetail(&v1.SettingsValidationErrors{Errors: issuesToProto(ve.Issues)}); derr == nil {
			out.AddDetail(d)
		}
		return out
	case errors.Is(err, settings.ErrFileInvalid):
		return connect.NewError(connect.CodeFailedPrecondition, err)
	case errors.Is(err, context.Canceled):
		return connect.NewError(connect.CodeCanceled, err)
	default:
		return connect.NewError(connect.CodeInternal, err)
	}
}

func issuesToProto(issues []settings.Issue) []*v1.SettingIssue {
	out := make([]*v1.SettingIssue, len(issues))
	for i, is := range issues {
		out[i] = &v1.SettingIssue{Key: is.Key, Message: is.Message}
	}
	return out
}

func settingsSnapshotToProto(s *settings.Snapshot) *v1.SettingsSnapshot {
	return &v1.SettingsSnapshot{
		Values: s.Values, Path: s.Path, Revision: s.Revision, LoadError: s.LoadError,
		Issues: issuesToProto(s.Issues), RestartPending: s.RestartPending,
	}
}

func settingsEvent(s *settings.Snapshot) *v1.SettingsEvent {
	return &v1.SettingsEvent{Event: &v1.SettingsEvent_Snapshot{Snapshot: settingsSnapshotToProto(s)}}
}
