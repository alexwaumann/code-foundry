package api

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/backdrop"
	"github.com/alexwaumann/code-foundry/internal/store/backdrop/backdroptest"
	"github.com/alexwaumann/code-foundry/internal/store/settings"
)

// The real store behind the handler: import selects, list shows, read returns the
// bytes, remove of the selected one falls back to forest.
func TestSettingsBackdrops(t *testing.T) {
	set, _ := newSettingsFake(t, nil)
	dir := t.TempDir()
	h := NewSettings(set).WithBackdrops(backdrop.New(backdrop.Options{Dir: filepath.Join(dir, "backdrops"), Settings: set}))
	ctx := context.Background()

	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewGray(image.Rect(0, 0, 32, 18))); err != nil {
		t.Fatal(err)
	}
	src := filepath.Join(dir, "my picture.png")
	if err := os.WriteFile(src, buf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	imp, err := h.ImportBackdrop(ctx, connect.NewRequest(&v1.ImportBackdropRequest{Path: src}))
	if err != nil {
		t.Fatal(err)
	}
	b := imp.Msg.GetBackdrop()
	if len(b.GetName()) != 36 || b.GetWidth() != 32 || b.GetHeight() != 18 || b.GetSize() != int64(buf.Len()) || time.Since(b.GetAddedAt().AsTime()) > time.Minute {
		t.Fatalf("imported = %v", b)
	}
	vals := set.Snapshot().Values
	if vals[settings.KeyBackdrop] != "custom" || vals[settings.KeyBackdropFile] != b.GetName() {
		t.Fatalf("selection = %q %q", vals[settings.KeyBackdrop], vals[settings.KeyBackdropFile])
	}

	list, err := h.ListBackdrops(ctx, connect.NewRequest(&v1.ListBackdropsRequest{}))
	if err != nil || len(list.Msg.GetBackdrops()) != 1 || list.Msg.GetBackdrops()[0].GetName() != b.GetName() {
		t.Fatalf("list = %v, %v", list, err)
	}
	read, err := h.ReadBackdrop(ctx, connect.NewRequest(&v1.ReadBackdropRequest{Name: b.GetName()}))
	if err != nil || read.Msg.GetMimeType() != "image/png" || !bytes.Equal(read.Msg.GetData(), buf.Bytes()) {
		t.Fatalf("read = %q %d bytes, %v", read.Msg.GetMimeType(), len(read.Msg.GetData()), err)
	}
	if _, err := h.RemoveBackdrop(ctx, connect.NewRequest(&v1.RemoveBackdropRequest{Name: b.GetName()})); err != nil {
		t.Fatal(err)
	}
	vals = set.Snapshot().Values
	if vals[settings.KeyBackdrop] != "forest" || vals[settings.KeyBackdropFile] != "" {
		t.Fatalf("after remove: %q %q", vals[settings.KeyBackdrop], vals[settings.KeyBackdropFile])
	}
	if list, _ := h.ListBackdrops(ctx, connect.NewRequest(&v1.ListBackdropsRequest{})); len(list.Msg.GetBackdrops()) != 0 {
		t.Fatalf("list after remove = %v", list.Msg.GetBackdrops())
	}
}

func TestSettingsBackdropErrors(t *testing.T) {
	set, _ := newSettingsFake(t, nil)
	fake := backdroptest.New()
	fake.Fail("/x/notes.txt", fmt.Errorf("%w: image type %q", backdrop.ErrInvalidArgument, "text/plain"))
	fake.Fail("/x/gone.png", fmt.Errorf("%w: image %q does not exist", backdrop.ErrNotFound, "/x/gone.png"))
	fake.Fail("boom.png", errors.New("disk on fire"))
	h := NewSettings(set).WithBackdrops(fake)
	bare := NewSettings(set)
	ctx := context.Background()

	tests := []struct {
		name string
		call func(*Settings) error
		code connect.Code
	}{
		{"unsupported import", func(h *Settings) error {
			_, err := h.ImportBackdrop(ctx, connect.NewRequest(&v1.ImportBackdropRequest{Path: "/x/notes.txt"}))
			return err
		}, connect.CodeInvalidArgument},
		{"missing import", func(h *Settings) error {
			_, err := h.ImportBackdrop(ctx, connect.NewRequest(&v1.ImportBackdropRequest{Path: "/x/gone.png"}))
			return err
		}, connect.CodeNotFound},
		{"remove unknown", func(h *Settings) error {
			_, err := h.RemoveBackdrop(ctx, connect.NewRequest(&v1.RemoveBackdropRequest{Name: "nope.png"}))
			return err
		}, connect.CodeNotFound},
		{"read unknown", func(h *Settings) error {
			_, err := h.ReadBackdrop(ctx, connect.NewRequest(&v1.ReadBackdropRequest{Name: "nope.png"}))
			return err
		}, connect.CodeNotFound},
		{"other failure", func(h *Settings) error {
			_, err := h.ReadBackdrop(ctx, connect.NewRequest(&v1.ReadBackdropRequest{Name: "boom.png"}))
			return err
		}, connect.CodeInternal},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := connect.CodeOf(tt.call(h)); got != tt.code {
				t.Fatalf("code = %v, want %v", got, tt.code)
			}
			if got := connect.CodeOf(tt.call(bare)); got != connect.CodeUnimplemented {
				t.Fatalf("without a store: %v, want unimplemented", got)
			}
		})
	}
}
