package command

import (
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

func TestListContext(t *testing.T) {
	now := time.Date(2026, 10, 12, 9, 0, 0, 0, time.UTC)
	at := func(d time.Duration) *timestamppb.Timestamp { return timestamppb.New(now.Add(d)) }
	tests := []struct {
		name string
		s    *v1.Session
		want string
	}{
		{name: "a terminal thread", s: &v1.Session{}, want: "-"},
		{name: "no expiry", s: &v1.Session{ContextTokens: 25_700}, want: "-"},
		{name: "warm", s: &v1.Session{ContextTokens: 25_700, CacheExpiresAt: at(41*time.Minute + 30*time.Second)}, want: "25.7K · cache expires in 42 min"},
		{name: "under a minute rounds up", s: &v1.Session{ContextTokens: 812, CacheExpiresAt: at(time.Second)}, want: "812 · cache expires in 1 min"},
		{name: "a whole hour", s: &v1.Session{ContextTokens: 25_700, CacheExpiresAt: at(time.Hour)}, want: "25.7K · cache expires in 1 h"},
		{name: "hours and minutes", s: &v1.Session{ContextTokens: 1_200_000, CacheExpiresAt: at(2*time.Hour + 5*time.Minute)}, want: "1.2M · cache expires in 2 h 5 min"},
		{name: "expiring now", s: &v1.Session{ContextTokens: 25_700, CacheExpiresAt: at(0)}, want: "25.7K · cache expired"},
		{name: "expired", s: &v1.Session{ContextTokens: 25_700, CacheExpiresAt: at(-time.Hour)}, want: "25.7K · cache expired"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := listContext(tt.s, now); got != tt.want {
				t.Errorf("listContext = %q, want %q", got, tt.want)
			}
		})
	}
}
