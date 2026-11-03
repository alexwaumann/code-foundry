package tcc

import "testing"

func TestAppName(t *testing.T) {
	tests := []struct {
		exe, want string
	}{
		{"/Applications/iTerm.app/Contents/MacOS/iTerm2", "iTerm"},
		{"/Applications/T3 Code (Beta).app/Contents/MacOS/T3 Code (Beta)", "T3 Code (Beta)"},
		{"/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal", "Terminal"},
		// A helper inside another app's bundle is listed under the outer app.
		{"/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper", "Visual Studio Code"},
		{"/Users/me/.code-foundry/app/Code Foundry", "Code Foundry"},
		{"/Users/me/.code-foundry/app/code-foundry", "code-foundry"},
		{"/Users/me/x/.app/bin", "bin"}, // a directory named ".app" is no bundle
	}
	for _, tt := range tests {
		if got := AppName(tt.exe); got != tt.want {
			t.Errorf("AppName(%q) = %q, want %q", tt.exe, got, tt.want)
		}
	}
}

func TestResponsibleAppNamesSomething(t *testing.T) {
	if got := ResponsibleApp(); got == "" {
		t.Fatal("ResponsibleApp() is empty")
	}
}
