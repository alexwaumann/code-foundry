package plugin

import (
	"context"
	"os"
	"strings"
	"testing"
)

// TestKeychainRoundTrip writes to the real login Keychain under a throwaway service, so
// it runs only when asked: CF_TEST_KEYCHAIN=1 go test -run Keychain ./internal/store/plugin
func TestKeychainRoundTrip(t *testing.T) {
	if os.Getenv("CF_TEST_KEYCHAIN") == "" {
		t.Skip("set CF_TEST_KEYCHAIN=1 to use the real Keychain")
	}
	k := Keychain{Service: "code-foundry-plugin-test"}
	ctx := context.Background()
	t.Cleanup(func() { _ = k.Delete(ctx, "t", "k") })
	for _, v := range []string{"plain", `quo"te\back`, "héllo\nworld"} {
		if err := k.Set(ctx, "t", "k", v); err != nil {
			t.Fatal(err)
		}
		got, ok, err := k.Get(ctx, "t", "k")
		if err != nil || !ok || got != v {
			t.Fatalf("Get = %q %v %v, want %q", got, ok, err, v)
		}
	}
	if err := k.Delete(ctx, "t", "k"); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := k.Get(ctx, "t", "k"); ok || err != nil {
		t.Fatalf("after delete: %v %v", ok, err)
	}
	if err := k.Delete(ctx, "t", "k"); err != nil {
		t.Fatalf("delete missing: %v", err)
	}

	// The longest value, under the longest service and account the patterns allow (the
	// line security -i reads is the limit), is stored whole; one byte more is refused
	// before security runs, and nothing is left behind.
	long := Keychain{Service: "code-foundry-plugin-test-" + strings.Repeat("x", 128-len("code-foundry-plugin-test-"))}
	lp, lk := strings.Repeat("p", 64), strings.Repeat("k", 128)
	t.Cleanup(func() { _ = long.Delete(ctx, lp, lk) })
	for _, v := range []string{strings.Repeat("z", MaxSecretBytes), strings.Repeat("é", MaxSecretBytes/2)} {
		if err := long.Set(ctx, lp, lk, v); err != nil {
			t.Fatal(err)
		}
		got, ok, err := long.Get(ctx, lp, lk)
		if err != nil || !ok || got != v {
			t.Fatalf("Get %d bytes = %d bytes %v %v", len(v), len(got), ok, err)
		}
	}
	if err := long.Delete(ctx, lp, lk); err != nil {
		t.Fatal(err)
	}
	if err := long.Set(ctx, lp, lk, strings.Repeat("z", MaxSecretBytes+1)); err == nil || !strings.Contains(err.Error(), "at most") {
		t.Fatalf("over the cap: %v", err)
	}
	if _, ok, err := long.Get(ctx, lp, lk); ok || err != nil {
		t.Fatalf("over the cap left an item: %v %v", ok, err)
	}
}
