package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa -framework WebKit
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>

// cfNavigationVerdict is Go's (navguard_export_darwin.go): navigationVerdict, plus the
// browser and the log line for a navigation it does not allow.
extern int cfNavigationVerdict(char* appURL, char* target, int mainFrame);

// The key of a guarded webview's app URL (an associated object). A webview without one is
// not guarded: the method below is added to the delegate's class, which every Wails window
// shares, so it must leave the others' navigations as they were.
static char cfNavGuardKey;

// webView:decidePolicyForNavigationAction:decisionHandler:, added to Wails' navigation
// delegate. Wails implements none of the delegate's policy methods, so this is the only
// decision. A navigation with no target frame asks for a new window, which Wails never
// opens (it has no createWebViewWithConfiguration); it is allowed, as before.
static void cfNavDecide(id self, SEL _cmd, WKWebView* webView, WKNavigationAction* action, void (^decisionHandler)(WKNavigationActionPolicy)) {
	NSString* appURL = objc_getAssociatedObject(webView, &cfNavGuardKey);
	WKFrameInfo* frame = action.targetFrame;
	if (appURL == nil || frame == nil) {
		decisionHandler(WKNavigationActionPolicyAllow);
		return;
	}
	NSString* target = action.request.URL.absoluteString ?: @"";
	int verdict = cfNavigationVerdict((char*)appURL.UTF8String, (char*)target.UTF8String, frame.isMainFrame ? 1 : 0);
	decisionHandler(verdict == 0 ? WKNavigationActionPolicyAllow : WKNavigationActionPolicyCancel);
}

static WKWebView* cfNavFindWebView(NSView* v) {
	if ([v isKindOfClass:[WKWebView class]]) return (WKWebView*)v;
	for (NSView* s in v.subviews) {
		WKWebView* w = cfNavFindWebView(s);
		if (w != nil) return w;
	}
	return nil;
}

// cfGuardNavigation guards the window's webview, at the page it shows now (the app's).
// Returns NULL, or why it could not; the window then stays as Wails left it.
static const char* cfGuardNavigation(void* nsWindow) {
	NSWindow* w = (__bridge NSWindow*)nsWindow;
	WKWebView* view = w == nil ? nil : cfNavFindWebView(w.contentView);
	if (view == nil) return "no webview";
	NSString* appURL = view.URL.absoluteString;
	if (appURL.length == 0) return "the webview has no page yet";
	id delegate = view.navigationDelegate;
	if (delegate == nil) return "the webview has no navigation delegate";
	SEL sel = @selector(webView:decidePolicyForNavigationAction:decisionHandler:);
	SEL withPrefs = @selector(webView:decidePolicyForNavigationAction:preferences:decisionHandler:);
	Class cls = [delegate class];
	Method existing = class_getInstanceMethod(cls, sel);
	if (existing == NULL) {
		if ([delegate respondsToSelector:withPrefs]) return "the delegate already decides navigation policy (with preferences)";
		if (!class_addMethod(cls, sel, (IMP)cfNavDecide, "v@:@@@?")) return "could not add the policy method";
	} else if (method_getImplementation(existing) != (IMP)cfNavDecide) {
		return "the delegate already decides navigation policy";
	}
	objc_setAssociatedObject(view, &cfNavGuardKey, appURL, OBJC_ASSOCIATION_COPY_NONATOMIC);
	// WebKit reads which methods a delegate has when it is set, so set it again.
	view.navigationDelegate = delegate;
	return NULL;
}
*/
import "C"

import (
	"errors"
	"log/slog"
	"sync/atomic"
	"unsafe"
)

// navGuard is what a refused navigation needs: the log, and the browser.
type navGuard struct {
	log  *slog.Logger
	open func(url string) error
}

var navGuardCurrent atomic.Pointer[navGuard]

// setNavGuard sets the log and browser the guard uses. Call once, before the app runs.
func setNavGuard(log *slog.Logger, open func(url string) error) {
	navGuardCurrent.Store(&navGuard{log: log, open: open})
}

// guardNavigation keeps the window's webview on the app (navguard.go), and logs whether it
// could. Main thread only, once the window's page has loaded: the page it shows then is
// the app's origin.
func guardNavigation(nsWindow unsafe.Pointer, window string, log *slog.Logger) {
	if reason := C.cfGuardNavigation(nsWindow); reason != nil {
		log.Error("navigation guard not installed", "window", window, "err", errors.New(C.GoString(reason)))
		return
	}
	log.Info("navigation guard installed", "window", window)
}

// decideNavigation runs on the main thread, inside WebKit's policy callback: it must not
// wait on anything, so the browser opens off it.
func decideNavigation(appURL, target string, mainFrame bool) navVerdict {
	v := navigationVerdict(appURL, target, mainFrame)
	if v == navAllow {
		return v
	}
	g := navGuardCurrent.Load()
	if g == nil {
		return v
	}
	g.log.Info("navigation away from the app refused", "url", target, "verdict", v.String())
	if v == navOpenInBrowser && g.open != nil {
		go func() {
			if err := g.open(target); err != nil {
				g.log.Error("open a refused navigation in the browser", "url", target, "err", err)
			}
		}()
	}
	return v
}
