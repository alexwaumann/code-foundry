// What a page in Code Foundry's frame cannot do by itself (internal/preview frame.go
// writes this into every HTML document the frame loads; docs/notes/page-frame-links.md).
// The frame is a sandboxed iframe in the app's window: it cannot open a window, show a
// dialog or save a file, and a link that left it would show a site that cannot sign in
// with no way back. So a link to another site, and window.open, go to the user's browser
// through the app ({ type: "cf:open", url }), and alert, confirm, prompt and downloads
// tell the app they did nothing ({ type: "cf:unsupported", what, text }), which the
// page's strip shows. A form sent to another site goes the same ways: a GET to the browser
// after a press, a POST reported; a POST to the page's own files, which nothing answers, is
// reported too. A link or form whose target would open a window (_blank, <base target>, a
// name no frame has, _top) loads in the frame instead. Where the browser has the Navigation
// API, a script's own location = … (or a refresh) to another site is caught too. A frame
// inside the page posts to the page, not the app, so the page's script sends on what its
// own frames report. Every document answers the
// app's { type: "cf:ping", seq } after a load with { type: "cf:here", seq }, and says when it
// goes on to a document at its own origin ({ type: "cf:going" }): a frame whose document
// answers nothing went to another site, and the app offers to load the page again
// (docs/notes/leftovers-pages.md). The answer also says what the document loaded from its
// own origin and whether it uses the app's theme, so the app reloads it ({ type: "cf:reload" })
// when one of its files is written, and on a theme change only when it uses the theme; a page
// in an opaque origin keeps localStorage, sessionStorage and cookies in memory until it
// reloads (docs/notes/page-frame-states.md). It says where the page is scrolled to
// ({ type: "cf:scroll" }) and goes back there when the app's ping hands that back, so a page
// loaded again where it was shown before opens where the reader left it
// (docs/notes/pages-tab-polish.md). No bridge is needed: a page that never loads
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

  // Whether this document is the page itself, in the app's frame, rather than a frame inside it.
  var pageTop = parent === window.top;
  // The target a link or form names: its own, else the document's <base target>.
  function targetOf(el, own) {
    var t = own;
    if (t === null || t === undefined) t = el.getAttribute("target");
    if (t === null) {
      var base = document.querySelector("base[target]");
      t = base ? base.getAttribute("target") : "";
    }
    return String(t || "");
  }
  // A frame of the page named name, from this document up to the page; null for none. A
  // window's named property may be an element with that id, which is not a frame.
  function namedFrame(name) {
    var w = window;
    for (var depth = 0; depth < 16; depth++) {
      try {
        var f = w[name];
        if (f && f.window === f && f !== w) return f;
      } catch (_) {
        // Not reachable from here.
      }
      if (w.parent === window.top || w.parent === w) return null;
      w = w.parent;
    }
    return null;
  }
  // Whether target is this document's own (a keyword's case does not count; a name's does).
  function ownTarget(t) {
    return t === "" || t.toLowerCase() === "_self";
  }
  // Whether going to target would open a window, which the app has none of for a frame, or
  // replace the app's own: then the page's own file loads in this frame instead.
  function opensWindow(t) {
    var k = t.toLowerCase();
    if (ownTarget(t)) return false;
    if (k === "_parent") return pageTop;
    if (k === "_blank" || k === "_top") return true;
    return t !== String(window.name || "") && !namedFrame(t);
  }

  // The user's own hand in the document: a press or key (a window.open soon after is theirs),
  // or a wheel or touch too (a scroll the app puts back stops).
  var touched = false;
  ["pointerdown", "keydown", "wheel", "touchstart"].forEach(function (t) {
    window.addEventListener(
      t,
      function (e) {
        if (!e.isTrusted) return;
        touched = true;
        if (t === "pointerdown" || t === "keydown") pressedAt = performance.now();
      },
      { capture: true, passive: true },
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
    var t = targetOf(a);
    if (opensWindow(t)) {
      // No window to open: the page's own other file shows in the frame.
      e.preventDefault();
      going();
      location.href = u.href;
    } else if (ownTarget(t)) {
      going();
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
  // press; a POST cannot be taken there. A POST to the page's own files: nothing there
  // answers one. A GET to its own file in a window: it loads in the frame. True when it was
  // taken care of here.
  function sentElsewhere(form, submitter, trusted) {
    var s = submitter && typeof submitter.hasAttribute === "function" ? submitter : null;
    var method = String((s && s.getAttribute("formmethod")) || form.method || "get").toLowerCase();
    if (method === "dialog") return false;
    var u = resolve((s && s.getAttribute("formaction")) || form.action || location.href);
    if (!u) return false;
    var away = elsewhere(u);
    if (method !== "get") {
      unsupported(away ? "form" : "post", away ? u.host : u.pathname);
      return true;
    }
    var inFrame = !away && opensWindow(targetOf(form, s && s.getAttribute("formtarget")));
    if (!away && !inFrame) return false;
    var data;
    try {
      data = s ? new FormData(form, s) : new FormData(form);
    } catch (_) {
      data = new FormData(form);
    }
    u.search = new URLSearchParams(data).toString();
    if (inFrame) {
      going();
      location.href = u.href;
    } else if (trusted || pressed()) open(u);
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
        if (e.formData) {
          e.preventDefault();
          unsupported("post", u.pathname);
          return;
        }
        going();
        return;
      }
      e.preventDefault();
      if (e.formData) unsupported("form", u.host);
      else if (e.userInitiated || pressed()) open(u);
      else unsupported("navigation", u.host);
    });
  }

  // A window to fill in script (window.open() or "about:blank", then document.write) has
  // nowhere to open, and the page is told it got none.
  var realOpen = window.open;
  window.open = function (href, name) {
    var u = href === undefined || href === null || href === "" ? null : resolve(href);
    var t = String(name === undefined || name === null ? "" : name);
    if (u && elsewhere(u)) {
      if (pressed()) open(u);
    } else if (u && !ownTarget(t) && !opensWindow(t) && typeof realOpen === "function") {
      // A frame of the page by its name, or this one's parent in the page.
      return realOpen.apply(window, arguments);
    } else if (u) {
      going();
      location.href = u.href;
    } else {
      unsupported("window", href);
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

  // A page no thread owns runs in an opaque origin (the File tab's frame has no
  // allow-same-origin), where every storage API throws, which stops most pages that keep
  // state. localStorage, sessionStorage and document.cookie live in memory instead, until the
  // page reloads, and the first use of each tells the app ({ what: "storage" }), which says
  // the data is not kept. indexedDB.open still throws, told first. A service worker and the
  // Cache API are taken away, so a page that looks for them goes on without. A use before the
  // app's ping (the page's first script) is told after the answer: the frame's load, which
  // comes between, clears what the page's strip had. So is one a frame inside the page sends
  // on before then. A frame inside the page is never pinged: it tells the page at once.
  var answered = false;
  var early = [];
  function report(what, text) {
    if (answered || !pageTop) unsupported(what, text);
    else early.push([what, text]);
  }
  var opaque = false;
  try {
    void window.localStorage;
  } catch (_) {
    opaque = true;
  }
  if (opaque) {
    var told = {};
    var tell = function (name) {
      if (told[name]) return;
      told[name] = true;
      report("storage", name);
    };
    var memoryStorage = function (name) {
      var data = Object.create(null);
      var api = {};
      var method = function (k, fn) {
        Object.defineProperty(api, k, {
          configurable: true,
          value: function () {
            tell(name);
            return fn.apply(null, arguments);
          },
        });
      };
      method("getItem", function (k) {
        k = String(k);
        return k in data ? data[k] : null;
      });
      method("setItem", function (k, v) {
        data[String(k)] = String(v);
      });
      method("removeItem", function (k) {
        delete data[String(k)];
      });
      method("clear", function () {
        data = Object.create(null);
      });
      method("key", function (i) {
        var keys = Object.keys(data);
        return i >= 0 && i < keys.length ? keys[i] : null;
      });
      Object.defineProperty(api, "length", {
        configurable: true,
        get: function () {
          tell(name);
          return Object.keys(data).length;
        },
      });
      if (typeof Proxy !== "function") return api;
      // Pages also read and write it as properties (localStorage.todos = …).
      var own = function (t, k) {
        return typeof k !== "string" || k in t;
      };
      return new Proxy(api, {
        get: function (t, k) {
          if (own(t, k)) return t[k];
          tell(name);
          return k in data ? data[k] : undefined;
        },
        set: function (t, k, v) {
          if (own(t, k)) return false;
          tell(name);
          data[k] = String(v);
          return true;
        },
        has: function (t, k) {
          return own(t, k) || k in data;
        },
        deleteProperty: function (t, k) {
          if (own(t, k)) return false;
          tell(name);
          delete data[k];
          return true;
        },
        ownKeys: function () {
          return Object.keys(data);
        },
        getOwnPropertyDescriptor: function (t, k) {
          if (own(t, k) || !(k in data)) return undefined;
          return { value: data[k], writable: true, enumerable: true, configurable: true };
        },
      });
    };
    var replace = function (obj, key, desc) {
      try {
        desc.configurable = true;
        Object.defineProperty(obj, key, desc);
      } catch (_) {
        // Not ours to replace here: the page meets the browser's own.
      }
    };
    ["localStorage", "sessionStorage"].forEach(function (k) {
      var store = memoryStorage(k);
      replace(window, k, {
        get: function () {
          return store;
        },
      });
    });
    var cookies = Object.create(null);
    replace(document, "cookie", {
      get: function () {
        tell("document.cookie");
        return Object.keys(cookies)
          .map(function (k) {
            return k + "=" + cookies[k];
          })
          .join("; ");
      },
      set: function (v) {
        tell("document.cookie");
        var parts = String(v).split(";");
        var eq = parts[0].indexOf("=");
        var k = (eq < 0 ? "" : parts[0].slice(0, eq)).trim();
        var val = (eq < 0 ? parts[0] : parts[0].slice(eq + 1)).trim();
        var gone = parts.slice(1).some(function (p) {
          var a = p.trim().toLowerCase();
          if (a.indexOf("max-age=") === 0) return Number(a.slice(8)) <= 0;
          if (a.indexOf("expires=") === 0) return Date.parse(p.trim().slice(8)) <= Date.now();
          return false;
        });
        if (gone) delete cookies[k];
        else cookies[k] = val;
      },
    });
    var idb = null;
    try {
      idb = window.indexedDB;
    } catch (_) {
      idb = null;
    }
    if (idb) {
      ["open", "deleteDatabase"].forEach(function (k) {
        var real = idb[k];
        if (typeof real !== "function") return;
        replace(idb, k, {
          writable: true,
          value: function () {
            tell("indexedDB");
            return real.apply(idb, arguments);
          },
        });
      });
    }
    var drop = function (obj, key) {
      for (var o = obj; o; o = Object.getPrototypeOf(o)) {
        var d = Object.getOwnPropertyDescriptor(o, key);
        if (!d) continue;
        try {
          if (d.configurable) delete o[key];
        } catch (_) {
          // Left as the browser has it.
        }
        return;
      }
    };
    drop(navigator, "serviceWorker");
    drop(window, "caches");
  }

  // What the document loaded from its own origin, as paths (itself first), at most MAX_FILES:
  // the app watches those under the page's grant and reloads the document when one is written.
  var MAX_FILES = 64;
  var files = [];
  function noteFile(href) {
    if (files.length >= MAX_FILES) return false;
    var u;
    try {
      u = new URL(String(href), document.baseURI);
    } catch (_) {
      return false;
    }
    if (u.host !== location.host || files.indexOf(u.pathname) >= 0) return false;
    files.push(u.pathname);
    return true;
  }
  function noteLoaded() {
    var grew = noteFile(location.href);
    var perf = window.performance;
    var entries = perf && typeof perf.getEntriesByType === "function" ? perf.getEntriesByType("resource") : [];
    for (var i = 0; i < entries.length; i++) grew = noteFile(entries[i].name) || grew;
    var els = document.querySelectorAll ? document.querySelectorAll("link[href], script[src]") : [];
    for (var j = 0; j < els.length; j++) grew = noteFile(els[j].href || els[j].src) || grew;
    return grew;
  }
  // Whether the document uses the app's theme: its stylesheet, or the bridge, which hands it.
  function themed() {
    return files.indexOf("/cf/theme.css") >= 0 || files.indexOf("/cf/bridge.js") >= 0 || !!(window.cf && window.cf.version);
  }
  var Observer = window.PerformanceObserver;
  if (typeof Observer === "function") {
    try {
      new Observer(function () {
        // Files fetched after the load (a lazy script, the page's data): the app watches them too.
        if (noteLoaded() && answered) post({ type: "cf:files", files: files.slice(), theme: themed() });
      }).observe({ type: "resource", buffered: false });
    } catch (_) {
      // No resource timing: the load's own list is all the app gets.
    }
  }

  // Where the reader is in the page's own document: { type: "cf:scroll", x, y, path } at most
  // once a frame while it scrolls, so the app can put it back when it loads the page again (a
  // tab shown again, a card scrolled back to; docs/notes/pages-tab-polish.md). The app hands
  // it back with its ping after the load ({ scroll: { x, y, path } }), and it goes back only
  // into the same file, with no fragment (a hash route or an anchor places the page itself),
  // still at the top (the page did not place itself), and only until the user scrolls,
  // presses or types, the page scrolls itself, or RESTORE_MS pass: it is tried again as the
  // document grows (a page drawn after its data came). Only the document's own scroll: a
  // region that scrolls inside the page is the page's.
  var RESTORE_MS = 3000;
  var scrollQueued = false;
  function px(v) {
    var n = Math.round(Number(v));
    return isFinite(n) && n > 0 ? n : 0;
  }
  function sendScroll() {
    scrollQueued = false;
    post({ type: "cf:scroll", x: px(window.scrollX), y: px(window.scrollY), path: location.pathname });
  }
  if (pageTop) {
    window.addEventListener(
      "scroll",
      function () {
        if (scrollQueued) return;
        scrollQueued = true;
        if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(sendScroll);
        else setTimeout(sendScroll, 16);
      },
      { passive: true },
    );
  }
  function restoreScroll(want) {
    var x = px(want.x);
    var y = px(want.y);
    if (touched || location.hash || location.pathname !== want.path || (x === 0 && y === 0)) return;
    if (px(window.scrollX) !== 0 || px(window.scrollY) !== 0) return;
    var at = { x: 0, y: 0 };
    var until = performance.now() + RESTORE_MS;
    var done = false;
    var ro = null;
    function stop() {
      if (done) return;
      done = true;
      if (ro) ro.disconnect();
    }
    // Moved from where it was put: the page or the user scrolled it.
    function moved() {
      return Math.abs(px(window.scrollX) - at.x) > 1 || Math.abs(px(window.scrollY) - at.y) > 1;
    }
    function step() {
      if (done) return;
      if (touched || moved() || performance.now() > until) {
        stop();
        return;
      }
      try {
        window.scrollTo({ left: x, top: y, behavior: "instant" });
      } catch (_) {
        window.scrollTo(x, y);
      }
      at = { x: px(window.scrollX), y: px(window.scrollY) };
      if (Math.abs(at.x - x) <= 1 && Math.abs(at.y - y) <= 1) stop();
    }
    step();
    if (done) return;
    window.addEventListener(
      "scroll",
      function () {
        if (!done && moved()) stop();
      },
      { passive: true },
    );
    window.addEventListener("resize", step);
    var Resize = window.ResizeObserver;
    if (typeof Resize === "function") {
      ro = new Resize(step);
      ro.observe(document.documentElement);
      if (document.body) ro.observe(document.body);
    }
    setTimeout(stop, RESTORE_MS);
  }

  // Whether source is the window of one of this document's own frames.
  function child(source) {
    var frames = window.frames;
    if (!source || !frames) return false;
    for (var i = 0; i < frames.length; i++) if (frames[i] === source) return true;
    return false;
  }
  window.addEventListener("message", function (e) {
    var m = e.data;
    if (!m || typeof m !== "object") return;
    if (e.source === parent) {
      if (m.type === "cf:reload") {
        location.reload();
        return;
      }
      if (m.type !== "cf:ping" || typeof m.seq !== "number") return;
      noteLoaded();
      answered = true;
      post({ type: "cf:here", seq: m.seq, files: files.slice(), theme: themed() });
      early.splice(0).forEach(function (r) {
        unsupported(r[0], r[1]);
      });
      var at = m.scroll;
      if (pageTop && at && typeof at === "object" && typeof at.path === "string") restoreScroll(at);
      return;
    }
    // What a frame inside the page asked of the app, sent on to it from here.
    if (!child(e.source)) return;
    if (m.type === "cf:open" && typeof m.url === "string") {
      var u = resolve(m.url);
      if (u) open(u);
    } else if (m.type === "cf:unsupported" && typeof m.what === "string") {
      report(m.what, m.text);
    }
  });
})();
