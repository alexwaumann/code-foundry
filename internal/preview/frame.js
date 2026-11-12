// What a page in Code Foundry's frame cannot do by itself (internal/preview frame.go
// writes this into every HTML document the frame loads; docs/notes/page-frame-links.md).
// The frame is a sandboxed iframe in the app's window: it cannot open a window, show a
// dialog or save a file, and a link that left it would show a site that cannot sign in
// with no way back. So a link to another site, and window.open, go to the user's browser
// through the app ({ type: "cf:open", url }), and alert, confirm, prompt and downloads
// tell the app they did nothing ({ type: "cf:unsupported", what, text }), which the
// page's strip shows. A form sent to another site goes the same ways: a GET to the browser
// after a press, a POST reported. Where the browser has the Navigation API, a script's own
// location = … (or a refresh) to another site is caught too. Every document answers the
// app's { type: "cf:ping", seq } after a load with { type: "cf:here", seq }, and says when it
// goes on to a document at its own origin ({ type: "cf:going" }): a frame whose document
// answers nothing went to another site, and the app offers to load the page again
// (docs/notes/leftovers-pages.md). No bridge is needed: a page that never loads
// /cf/bridge.js gets this too.
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
  // The next document is at this origin: one without this script (a page's own JSON or
  // picture) is not another site.
  function going() {
    post({ type: "cf:going" });
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
      return;
    }
    going();
    if ((a.getAttribute("target") || "").toLowerCase() === "_blank") {
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

  // A form to another site: a GET is a link with the form's fields, to the browser after a
  // press; a POST cannot be taken there. True when it was taken care of here.
  function sentElsewhere(form, submitter, trusted) {
    var s = submitter && typeof submitter.hasAttribute === "function" ? submitter : null;
    var method = String((s && s.getAttribute("formmethod")) || form.method || "get").toLowerCase();
    if (method === "dialog") return false;
    var u = resolve((s && s.getAttribute("formaction")) || form.action || location.href);
    if (!u || !elsewhere(u)) return false;
    if (method !== "get") {
      unsupported("form", u.host);
      return true;
    }
    var data;
    try {
      data = s ? new FormData(form, s) : new FormData(form);
    } catch (_) {
      data = new FormData(form);
    }
    u.search = new URLSearchParams(data).toString();
    if (trusted || pressed()) open(u);
    else unsupported("form", u.host);
    return true;
  }
  // In the bubble phase: a form the page sends itself (fetch, then preventDefault) is the page's.
  window.addEventListener("submit", function (e) {
    if (e.defaultPrevented || !e.target || e.target.localName !== "form") return;
    if (sentElsewhere(e.target, e.submitter, e.isTrusted)) e.preventDefault();
  });
  // form.submit() fires no submit event.
  var submit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function () {
    if (sentElsewhere(this, null, false)) return;
    return submit.apply(this, arguments);
  };

  // Every other way a page sends its frame on (location = …, location.assign or replace,
  // a refresh): to another site it is caught, where the browser says where it goes.
  var nav = window.navigation;
  if (nav && typeof nav.addEventListener === "function") {
    nav.addEventListener("navigate", function (e) {
      if (!e.cancelable || e.destination.sameDocument || e.downloadRequest) return;
      var u = resolve(e.destination.url);
      if (!u) return;
      if (!elsewhere(u)) {
        going();
        return;
      }
      e.preventDefault();
      if (e.formData) unsupported("form", u.host);
      else if (e.userInitiated || pressed()) open(u);
      else unsupported("navigation", u.host);
    });
  }

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

  window.addEventListener("message", function (e) {
    var m = e.data;
    if (e.source !== parent || !m || m.type !== "cf:ping" || typeof m.seq !== "number") return;
    post({ type: "cf:here", seq: m.seq });
  });
})();
