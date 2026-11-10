// What a page in Code Foundry's frame cannot do by itself (internal/preview frame.go
// writes this into every HTML document the frame loads; docs/notes/page-frame-links.md).
// The frame is a sandboxed iframe in the app's window: it cannot open a window, show a
// dialog or save a file, and a link that left it would show a site that cannot sign in
// with no way back. So a link to another site, and window.open, go to the user's browser
// through the app ({ type: "cf:open", url }), and alert, confirm, prompt and downloads
// tell the app they did nothing ({ type: "cf:unsupported", what, text }), which the
// page's strip shows. No bridge is needed: a page that never loads /cf/bridge.js gets
// this too.
(function () {
  if (window.parent === window || window.__cfFrame) return;
  window.__cfFrame = true;
  var parent = window.parent;
  var GESTURE_MS = 5000; // how long after a press or key a window.open counts as the user's
  var MAX_URL = 2048;
  var MAX_TEXT = 200;
  var pressedAt = -Infinity;

  function post(msg) {
    try {
      parent.postMessage(msg, "*");
    } catch (_) {
      // The app is gone: nothing to tell.
    }
  }
  function unsupported(what, text) {
    post({ type: "cf:unsupported", what: what, text: String(text === undefined || text === null ? "" : text).slice(0, MAX_TEXT) });
  }
  // The absolute URL of a link, or null when it is not one a browser opens.
  function resolve(href) {
    try {
      var u = new URL(String(href), document.baseURI);
      return u.protocol === "http:" || u.protocol === "https:" ? u : null;
    } catch (_) {
      return null;
    }
  }
  function elsewhere(u) {
    return u.host !== location.host;
  }
  function open(u) {
    if (u.href.length > MAX_URL) return;
    post({ type: "cf:open", url: u.href });
  }
  function anchorOf(e) {
    var path = typeof e.composedPath === "function" ? e.composedPath() : [e.target];
    for (var i = 0; i < path.length; i++) {
      var el = path[i];
      if (el && el.nodeType === 1 && (el.localName === "a" || el.localName === "area") && el.hasAttribute("href")) return el;
    }
    return null;
  }

  ["pointerdown", "keydown"].forEach(function (t) {
    window.addEventListener(
      t,
      function (e) {
        if (e.isTrusted) pressedAt = performance.now();
      },
      true,
    );
  });
  function pressed() {
    var ua = navigator.userActivation;
    return (ua && ua.isActive) || performance.now() - pressedAt < GESTURE_MS;
  }

  // In the bubble phase, after the page's own handlers: a click the page took for itself
  // (a router, a button drawn as a link) is the page's.
  function onClick(e) {
    if (e.defaultPrevented) return;
    var a = anchorOf(e);
    if (!a) return;
    if (a.hasAttribute("download")) {
      e.preventDefault();
      unsupported("download", a.getAttribute("download") || a.getAttribute("href"));
      return;
    }
    if (!e.isTrusted) return;
    var u = resolve(a.href);
    if (!u) return;
    if (elsewhere(u)) {
      e.preventDefault();
      open(u);
    } else if ((a.getAttribute("target") || "").toLowerCase() === "_blank") {
      // No window to open: the page's own other file shows in the frame.
      e.preventDefault();
      location.href = u.href;
    }
  }
  window.addEventListener("click", onClick);
  window.addEventListener("auxclick", function (e) {
    if (e.button === 1) onClick(e);
  });

  // A file made in script is saved by clicking a link that is not in the document, which
  // no listener hears.
  var click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.hasAttribute("download") && !this.isConnected) {
      unsupported("download", this.getAttribute("download"));
      return;
    }
    return click.apply(this, arguments);
  };

  window.open = function (href) {
    var u = href === undefined || href === null || href === "" ? null : resolve(href);
    if (u && elsewhere(u)) {
      if (pressed()) open(u);
    } else if (u) {
      location.href = u.href;
    }
    return null;
  };

  window.alert = function (text) {
    unsupported("alert", text);
  };
  window.confirm = function (text) {
    unsupported("confirm", text);
    return false;
  };
  window.prompt = function (text) {
    unsupported("prompt", text);
    return null;
  };
})();
