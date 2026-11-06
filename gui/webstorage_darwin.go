package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Foundation -framework WebKit
#include <stdlib.h>
#import <Foundation/Foundation.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>

static NSUUID* cfStoreID;
static WKWebsiteDataStore* cfStore;
static id (*cfWebViewInit)(id, SEL, CGRect, WKWebViewConfiguration*);

// Made on first use, not at install: the first webview's init runs on the main thread,
// which is where WebKit wants it. Every webview of the process shares the one store. Before
// macOS 14 a store can only be named by private API, so there it lasts the run instead.
static WKWebsiteDataStore* cfHomeStore(void) {
	if (cfStore == nil) {
		if (@available(macOS 14.0, *)) {
			cfStore = [[WKWebsiteDataStore dataStoreForIdentifier:cfStoreID] retain];
		} else {
			cfStore = [[WKWebsiteDataStore nonPersistentDataStore] retain];
		}
	}
	return cfStore;
}

static id cfInitWebView(id self, SEL cmd, CGRect frame, WKWebViewConfiguration* config) {
	config.websiteDataStore = cfHomeStore();
	return cfWebViewInit(self, cmd, frame, config);
}

// Wails builds its own WKWebViewConfiguration and offers no way to set the store, so this
// wraps the one init it calls. false, with nothing changed, if the uuid is bad or the init is gone.
static bool cfUseWebStorage(const char* uuid) {
	cfStoreID = [[NSUUID alloc] initWithUUIDString:[NSString stringWithUTF8String:uuid]];
	Method init = class_getInstanceMethod([WKWebView class], @selector(initWithFrame:configuration:));
	if (cfStoreID == nil || init == NULL) return false;
	cfWebViewInit = (id (*)(id, SEL, CGRect, WKWebViewConfiguration*))method_setImplementation(init, (IMP)cfInitWebView);
	return true;
}
*/
import "C"

import (
	"errors"
	"unsafe"
)

// useWebStorage makes every webview this process creates from now on use the data store
// named id. It has to run before the first window.
func useWebStorage(id string) error {
	cid := C.CString(id)
	defer C.free(unsafe.Pointer(cid))
	if !C.cfUseWebStorage(cid) {
		return errors.New("cannot set the webview's data store")
	}
	return nil
}
