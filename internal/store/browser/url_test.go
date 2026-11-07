package browser

import (
	"errors"
	"strings"
	"testing"
)

func TestNormalizeURL(t *testing.T) {
	tests := []struct {
		typed string
		want  string // "" is refused
	}{
		{"example.com", "https://example.com"},
		{"  example.com/a?b=c#d  ", "https://example.com/a?b=c#d"},
		{"https://example.com", "https://example.com"},
		{"HTTP://example.com/", "http://example.com/"},
		{"localhost:5173/x", "http://localhost:5173/x"},
		{"localhost", "http://localhost"},
		{"127.0.0.1:8080", "http://127.0.0.1:8080"},
		{"app.localhost:3000", "http://app.localhost:3000"},
		{"example.com:8443/x", "https://example.com:8443/x"},
		{"//example.com", "https://example.com"},

		{"", ""},
		{"two words", ""},
		{"file:///etc/passwd", ""},
		{"FILE:///etc/passwd", ""},
		{"file:/etc/passwd", ""},
		{"chrome://settings", ""},
		{"chrome-extension://abc/x.html", ""},
		{"chrome-untrusted://x", ""},
		{"devtools://devtools/bundled/inspector.html", ""},
		{"javascript:alert(1)", ""},
		{"JavaScript:alert(1)", ""},
		{"javascript:1", ""},
		{"data:text/html,<script>1</script>", ""},
		{"blob:https://example.com/1", ""},
		{"about:blank", ""},
		{"view-source:https://example.com", ""},
		{"filesystem:https://example.com/x", ""},
		{"ftp://example.com", ""},
		{"ws://example.com", ""},
		{"mailto:a@example.com", ""},
		{"https://user:pw@example.com", ""},
		{"https://user@example.com", ""},
		{"https://", ""},
		{"http:example.com", ""},
	}
	for _, tt := range tests {
		t.Run(tt.typed, func(t *testing.T) {
			got, err := NormalizeURL(tt.typed)
			if tt.want == "" {
				if !errors.Is(err, ErrBadURL) {
					t.Fatalf("NormalizeURL(%q) = %q, %v; want refused", tt.typed, got, err)
				}
				return
			}
			if err != nil || got != tt.want {
				t.Fatalf("NormalizeURL(%q) = %q, %v; want %q", tt.typed, got, err, tt.want)
			}
		})
	}
}

func TestCheckURLRefusesAnythingLong(t *testing.T) {
	long := "https://example.com/"
	for len(long) <= maxURL {
		long += "aaaaaaaa"
	}
	if _, err := CheckURL(long); !errors.Is(err, ErrBadURL) {
		t.Fatalf("got %v", err)
	}
}

func TestRefusalNeverQuotesTheAddress(t *testing.T) {
	for _, typed := range []string{"file:///secret-path", "https://me:hunter2@example.com/"} {
		_, err := NormalizeURL(typed)
		if err == nil {
			t.Fatalf("%q was not refused", typed)
		}
		for _, leak := range []string{"secret-path", "hunter2"} {
			if contains(err.Error(), leak) {
				t.Fatalf("refusal quotes the address: %v", err)
			}
		}
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

func TestAllowedPage(t *testing.T) {
	tests := map[string]bool{
		"": true, "about:blank": true, "https://example.com": true, "http://localhost": true,
		"chrome-error://chromewebdata/": true, "blob:https://example.com/1": true,
		"file:///etc/passwd": false, "chrome://settings": false, "devtools://x": false,
		"chrome-extension://x/y": false, "javascript:1": false, "nonsense": false,
	}
	for u, want := range tests {
		if got := allowedPage(u); got != want {
			t.Errorf("allowedPage(%q) = %v", u, got)
		}
	}
}

func TestWhoAPageIsSurvivesWhatAParserRefuses(t *testing.T) {
	tests := []struct{ raw, origin, site string }{
		{"https://a.bank.example.co.uk/x", "https://a.bank.example.co.uk", "example.co.uk"},
		{"http://evil.test:8080/%zz", "http://evil.test:8080", "evil.test"},
		{"http://evil.test/%zz?a#b", "http://evil.test", "evil.test"},
		{"http://a{b.evil.test/", "http://a{b.evil.test", "evil.test"},
		{"http://a`b.evil.test:9/", "http://a`b.evil.test:9", "evil.test"},
		{"https://me:pw@bank.example%2Flogin@evil.test/", "https://evil.test", "evil.test"},
		{"http://[::1]:8080/x", "http://[::1]:8080", "::1"},
		{"http://127.0.0.1:9/", "http://127.0.0.1:9", "127.0.0.1"},
		{"http://localhost:9/", "http://localhost:9", "localhost"},
		{`http://evil.test\@bank.example/`, "http://evil.test", "evil.test"},
		{"about:blank", "", ""},
		{"blob:https://evil.test/1", "", ""},
		{"data:text/html,x", "", ""},
		{"", "", ""},
	}
	for _, tt := range tests {
		if got := originOf(tt.raw); got != tt.origin {
			t.Errorf("originOf(%q) = %q", tt.raw, got)
		}
		if got := siteOf(tt.raw); got != tt.site {
			t.Errorf("siteOf(%q) = %q", tt.raw, got)
		}
	}
}

func TestChromesOriginSaysNothingWhenOpaque(t *testing.T) {
	for in, want := range map[string]string{"://": "", "null": "", "": "", "http://evil.test": "http://evil.test"} {
		if got := chromeOrigin(in); got != want {
			t.Errorf("chromeOrigin(%q) = %q", in, got)
		}
	}
}

func TestALongHostKeepsItsEnd(t *testing.T) {
	long := "http://" + strings.Repeat("a.", 1000) + "evil.test"
	got := clipHost(long)
	if !strings.HasSuffix(got, ".evil.test") || len(got) > maxHost+4 {
		t.Fatalf("clipped to %q", got)
	}
	if clipHost("http://evil.test") != "http://evil.test" {
		t.Fatal("a short one changed")
	}
}
