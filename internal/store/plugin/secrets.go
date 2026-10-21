package plugin

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/plugin/registry"
)

// SecretStore keeps plugin secrets. Values are never logged; keys may be.
type SecretStore interface {
	// Get returns the value of plugin's key and whether it is set.
	Get(ctx context.Context, plugin, key string) (string, bool, error)
	// Set stores a value (non-empty).
	Set(ctx context.Context, plugin, key, value string) error
	// Delete removes a value; removing one that is not set is not an error.
	Delete(ctx context.Context, plugin, key string) error
}

// KeychainService is the Keychain service every plugin secret of the default config home
// is stored under (KeychainServiceFor names another home's); the account is
// "<plugin>/<key>" (keychainAccount).
const KeychainService = "code-foundry-plugin"

// KeychainServiceFor is the Keychain service of the config home home: KeychainService
// for the default home (~/.code-foundry), and KeychainService plus a hash of the path for
// any other (CODE_FOUNDRY_HOME), so a test home's plugin never reads or overwrites the
// real home's secrets of a plugin with the same name.
func KeychainServiceFor(home, defaultHome string) string {
	home, defaultHome = filepath.Clean(home), filepath.Clean(defaultHome)
	if home == defaultHome {
		return KeychainService
	}
	sum := sha256.Sum256([]byte(home))
	return KeychainService + "-" + hex.EncodeToString(sum[:6])
}

// secretKeyPattern is the shape of a secret's key.
var secretKeyPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)

// keychainAccount is the Keychain account of plugin's key: "<plugin>/<key>". A plugin
// name ([a-z0-9][a-z0-9-]*) and a key ([A-Za-z0-9._-]+) never hold a "/", so the account
// names exactly one (plugin, key) pair; anything else is refused here, at the last step
// before the security CLI, whatever the caller checked (the account is also part of the
// command line Set writes to `security -i`, where a space or a newline would be syntax).
func keychainAccount(plugin, key string) (string, error) {
	if !registry.ValidName(plugin) {
		return "", fmt.Errorf("keychain: %q is not a plugin name", plugin)
	}
	if !secretKeyPattern.MatchString(key) {
		return "", fmt.Errorf("keychain: %q is not a secret key", key)
	}
	return plugin + "/" + key, nil
}

// MaxSecretBytes bounds one secret value. It is what one `security -i` line holds: the
// interactive reader takes at most securityLineMax bytes a line (measured on macOS 26:
// a 4096-byte line, newline included, is read whole and a longer one is cut there, the
// rest parsed as another command, after the cut value was stored), Set hex-encodes the
// value (two characters a byte), and the rest of the line is the command with the
// longest service and account the patterns allow (maxAddPrefix).
const MaxSecretBytes = 1800

// securityLineMax is the longest line `security -i` reads whole, newline included.
const securityLineMax = 4096

// maxAddPrefix is the longest add command before the value, and its newline:
// "add-generic-password -U -s <service ≤128> -a <plugin ≤64>/<key ≤128> -X " + "\n".
const maxAddPrefix = len("add-generic-password -U -s  -a / -X \n") + 128 + 64 + 128

// Keychain is the SecretStore backed by the user's login Keychain through the security
// CLI. A value is never in argv (it would show in ps): Set feeds the add command to
// `security -i` on stdin with the value hex-encoded (-X), and Get reads it from `-g`
// output on stderr.
type Keychain struct {
	// Security is the security binary (default /usr/bin/security).
	Security string
	// Service defaults to KeychainService.
	Service string
}

var _ SecretStore = Keychain{}

func (k Keychain) bin() string {
	if k.Security != "" {
		return k.Security
	}
	return "/usr/bin/security"
}

func (k Keychain) service() string {
	if k.Service != "" {
		return k.Service
	}
	return KeychainService
}

// servicePattern bounds Service to what `security -i` reads as one word.
var servicePattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)

// errItemNotFound is security's exit status for a missing item.
const errItemNotFound = 44

func (k Keychain) run(ctx context.Context, stdin string, args ...string) (stdout, stderr string, code int, err error) {
	cmd := exec.CommandContext(ctx, k.bin(), args...)
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	err = cmd.Run()
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return out.String(), errb.String(), ee.ExitCode(), nil
	}
	return out.String(), errb.String(), 0, err
}

// Get implements SecretStore.
func (k Keychain) Get(ctx context.Context, plugin, key string) (string, bool, error) {
	acct, err := keychainAccount(plugin, key)
	if err != nil {
		return "", false, err
	}
	_, stderr, code, err := k.run(ctx, "", "find-generic-password", "-s", k.service(), "-a", acct, "-g")
	switch {
	case err != nil:
		return "", false, fmt.Errorf("keychain: %w", err)
	case code == errItemNotFound:
		return "", false, nil
	case code != 0:
		return "", false, fmt.Errorf("keychain: find %s/%s: exit status %d", plugin, key, code)
	}
	v, ok := parsePasswordLine(stderr)
	if !ok {
		return "", false, fmt.Errorf("keychain: find %s/%s: unexpected output", plugin, key)
	}
	return v, true, nil
}

// parsePasswordLine reads the value from security's `-g` output: `password: "text"` for
// printable values, `password: 0x<HEX>  "escaped"` otherwise.
func parsePasswordLine(out string) (string, bool) {
	for line := range strings.SplitSeq(out, "\n") {
		rest, ok := strings.CutPrefix(line, "password: ")
		if !ok {
			continue
		}
		if h, ok := strings.CutPrefix(rest, "0x"); ok {
			h, _, _ = strings.Cut(h, " ")
			b, err := hex.DecodeString(h)
			if err != nil {
				return "", false
			}
			return string(b), true
		}
		if len(rest) >= 2 && rest[0] == '"' && rest[len(rest)-1] == '"' {
			return rest[1 : len(rest)-1], true
		}
		return "", false
	}
	return "", false
}

// Set implements SecretStore.
func (k Keychain) Set(ctx context.Context, plugin, key, value string) error {
	acct, err := keychainAccount(plugin, key)
	if err != nil {
		return err
	}
	if !servicePattern.MatchString(k.service()) {
		return fmt.Errorf("keychain: %q is not a service name", k.service())
	}
	// No -A and no -T: the item trusts only its creator, /usr/bin/security (the note
	// plugins-8-secrets-hardening.md says what that does and does not protect).
	cmdline := fmt.Sprintf("add-generic-password -U -s %s -a %s -X %s\n", k.service(), acct, hex.EncodeToString([]byte(value)))
	if len(value) > MaxSecretBytes || len(cmdline) > securityLineMax {
		return fmt.Errorf("keychain: store %s/%s: a secret is at most %d bytes, this one is %d", plugin, key, MaxSecretBytes, len(value))
	}
	stdout, stderr, code, err := k.run(ctx, cmdline, "-i")
	if err != nil {
		return fmt.Errorf("keychain: %w", err)
	}
	// A stored value prints nothing. Anything else is a refusal or a line security cut
	// and parsed in part (the item may be written, cut short): remove what it may have
	// written, and never quote its output, which can echo the value's hex.
	if code != 0 || stdout != "" || stderr != "" {
		dctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		_ = k.Delete(dctx, plugin, key)
		return fmt.Errorf("keychain: store %s/%s: the Keychain refused the value (%d bytes)", plugin, key, len(value))
	}
	return nil
}

// Delete implements SecretStore.
func (k Keychain) Delete(ctx context.Context, plugin, key string) error {
	acct, err := keychainAccount(plugin, key)
	if err != nil {
		return err
	}
	_, stderr, code, err := k.run(ctx, "", "delete-generic-password", "-s", k.service(), "-a", acct)
	switch {
	case err != nil:
		return fmt.Errorf("keychain: %w", err)
	case code == errItemNotFound:
		return nil
	case code != 0:
		return fmt.Errorf("keychain: delete %s/%s: %s", plugin, key, firstLine(stderr, code))
	}
	return nil
}

func firstLine(s string, code int) string {
	if l, _, _ := strings.Cut(strings.TrimSpace(s), "\n"); l != "" {
		return l
	}
	return fmt.Sprintf("exit status %d", code)
}
