package plugin

import (
	"context"
	"os"
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
}
