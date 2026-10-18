package thread

import (
	"context"
	"reflect"
	"testing"
	"time"
)

func TestItemsDBRoundTrip(t *testing.T) {
	e := newEnv(t)
	s := e.connected(CreateOptions{})
	at := time.UnixMilli(time.Now().UnixMilli())
	tests := []struct {
		name string
		item Item
	}{
		{"a created-by note keeps its creator", Item{ID: "rt-note-by", Kind: KindNote, Text: "Created by Parent · brief: hi", NoteCreatedBy: "s-parent"}},
		{"a fork note has no creator", Item{ID: "rt-note-fork", Kind: KindNote, Text: "Forked from base"}},
		{"a wake message", Item{ID: "rt-wake", Kind: KindUserMessage, Text: "wake", Origin: OriginWake, WakeTitle: "s-1 is idle", WakeJSON: `{"n":1}`}},
	}
	for i, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			want := tt.item
			want.Ordinal, want.CreatedAt, want.UpdatedAt = int64(1000+i), at, at
			if err := saveItem(context.Background(), e.m.opts.DB, s.ID, want); err != nil {
				t.Fatal(err)
			}
			items, err := loadItems(context.Background(), e.m.opts.DB, s.ID)
			if err != nil {
				t.Fatal(err)
			}
			for _, got := range items {
				if got.ID == want.ID {
					if !reflect.DeepEqual(got, want) {
						t.Errorf("loaded %+v, want %+v", got, want)
					}
					return
				}
			}
			t.Fatalf("item %s not loaded", want.ID)
		})
	}
}
