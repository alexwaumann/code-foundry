package tcc

import "testing"

func TestAppAt(t *testing.T) {
	tests := []struct {
		exe     string
		name    string
		bundled bool
	}{
		{"/Applications/iTerm.app/Contents/MacOS/iTerm2", "iTerm", true},
		{"/Applications/T3 Code (Beta).app/Contents/MacOS/T3 Code (Beta)", "T3 Code (Beta)", true},
		{"/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal", "Terminal", true},
		// A helper inside another app's bundle is listed under the outer app.
		{"/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper", "Visual Studio Code", true},
		{"/Users/me/.code-foundry/app/Code Foundry", "Code Foundry", false},
		{"/Users/me/.code-foundry/app/code-foundry", "code-foundry", false},
		{"/Users/me/x/.app/bin", "bin", false}, // a directory named ".app" is no bundle
	}
	for _, tt := range tests {
		got := appAt(tt.exe)
		if got.Name != tt.name || got.Bundled != tt.bundled || got.Path != tt.exe {
			t.Errorf("appAt(%q) = %+v, want name %q, bundled %t", tt.exe, got, tt.name, tt.bundled)
		}
	}
}

func TestResponsibleNamesSomething(t *testing.T) {
	if got := Responsible(); got.Name == "" || got.Path == "" {
		t.Fatalf("Responsible() = %+v", got)
	}
}
