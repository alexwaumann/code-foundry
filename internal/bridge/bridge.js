/*
 * Code Foundry's page bridge, protocol 1 (docs/notes/bridge-1-daemon.md).
 *
 *   <script src="/cf/bridge.js"></script>
 *
 * gives the page window.cf:
 *   cf.ready                      Promise, resolved once the app said hello (cf:ready)
 *   cf.thread {id, name}          the thread the page is shown in
 *   cf.theme {id, scheme, vars}   the app's theme; cf.onTheme(fn) on every change
 *   cf.run(verb, args?, opts?)    Promise of {text, json}; rejects with {code, message}
 *   cf.on(source, fn) / cf.off    live data, fn(value, source): now, then on change; on returns an unsubscribe
 *   cf.resize(height?)            the card follows the page's height by itself
 *   cf.storage(prefix?)           the thread's page storage, kept across app restarts
 *   cf.fetch(url, init?)          Promise of {status, ok, headers, text(), json()}; the app makes it: no CORS
 *
 * A verb that is not read-only runs only from a user gesture in the page (a click, a key).
 * Every call is a postMessage to the app, which runs it as the page's thread would. A call
 * waiting on the app's confirm dialog does not time out; cf.on throws for an unknown source.
 * At most 32 runs and fetches are at the app at once (more wait here, their timeouts running)
 * and 16 subscriptions; a call's args, or a stored value, may be up to 256 KiB.
 *
 * The app opens the page with a nonce in its URL's fragment (#cf=<nonce>), sent back on
 * every message (docs/notes/bridge-fix-frames.md): a page reached any other way (a link
 * followed in the frame, another tab) has no bridge, and cf.ready rejects at once.
 */
(function () {
  "use strict";
  if (window.cf && window.cf.version) return;

  var VERSION = 1;
  var GESTURE_MS = 5000; // how long after a press, click or key a call counts as the user's
  var READY_MS = 10000; // how long cf.run waits for the app to say hello
  var RUN_MS = 60000; // cf.run's default timeout; opts.timeout overrides it, 0 waits forever
  var MAX_RUNS = 32; // runs at the app at once; the app refuses more
  var MAX_CHARS = 256 * 1024; // the largest call the app hears
  var FETCH_MS = 30000; // cf.fetch's default timeout; init.timeout overrides it
  var FETCH_MAX_MS = 120000; // the longest a fetch may take
  var FETCH_GRACE_MS = 5000; // how long past its timeout a fetch waits for the app's own timeout
  var FETCH_BODY = 1024 * 1024; // the largest request body, in UTF-8 bytes
  var FETCH_CHARS = FETCH_BODY + 64 * 1024; // the largest cf:fetch the app hears
  // The sources a page may subscribe to, until cf:ready names them (internal/bridge Sources).
  var SOURCES = ["thread-list", "thread", "gh", "action", "plugin", "terminal", "project", "workspace", "settings", "update", "ui", "ember"];

  var host = window.parent;
  var embedded = !!host && host !== window;
  // The frame's nonce, from the fragment the app opened the page with; "" for none.
  var nonceMatch = /(?:^#|&)cf=([A-Za-z0-9_-]+)/.exec(location.hash || "");
  var NONCE = nonceMatch ? nonceMatch[1] : "";
  // Whether the app hears this page's calls: a frame the app opened for it, nonce and all.
  var bridged = embedded && NONCE !== "";
  var seq = 0;
  var idBase = "cf" + Math.random().toString(36).slice(2, 10) + "-";
  var pending = {}; // run id -> {resolve, reject, timer, left, until, verb, total, msg, sent, fetch}
  var queue = []; // run ids waiting for one of the MAX_RUNS places, oldest first
  var sending = 0; // runs posted and not answered
  var stores = {}; // storage write id -> {key, resolve, reject}
  var stored = {}; // the thread's page storage: key -> the value's JSON text
  var writing = {}; // key -> writes not answered yet; cf:storage leaves those keys alone
  var subs = {}; // subscription id -> {source, fn, onError}
  var themeFns = [];
  var readyMsg = null;
  var readyWaiters = [];
  var readOnly = {};
  var lastGesture = 0;
  var lastHeight = 0;

  function nextId() {
    seq += 1;
    return idBase + seq;
  }

  // Bridge messages go only from a page the app opened (bridged); cf:resize and
  // cf:theme:ack from any embedded page, which the app hears without a nonce.
  function post(msg) {
    if (!embedded) return;
    msg.cf = VERSION;
    if (NONCE) msg.nonce = NONCE;
    else if (msg.type !== "cf:resize" && msg.type !== "cf:theme:ack") return;
    try {
      host.postMessage(msg, "*");
    } catch (e) {
      // A message that does not clone (a function in args) never leaves; cf.run checks first.
    }
  }

  function cfError(code, message) {
    var e = new Error(message);
    e.name = "CfError";
    e.code = code;
    return e;
  }

  // Gestures: transient user activation, or a real press, click or key in the page in the
  // last 5 s. Either is enough: in the app's side panel WebKit reported isActive false
  // inside a genuine click's handler (docs/notes/bridge-fix-c-gui.md), so the API alone
  // refused it. Only trusted events count: a page's own el.click() is not the user.
  function noteGesture(e) {
    if (e && e.isTrusted === false) return;
    lastGesture = Date.now();
  }
  ["pointerdown", "mousedown", "pointerup", "click", "keydown"].forEach(function (t) {
    window.addEventListener(t, noteGesture, true);
  });
  function inGesture() {
    var ua = navigator.userActivation;
    if (ua && ua.isActive === true) return true;
    return lastGesture > 0 && Date.now() - lastGesture < GESTURE_MS;
  }

  function whenReady(ms) {
    if (readyMsg) return Promise.resolve(readyMsg);
    if (!bridged) return Promise.reject(notShown());
    return new Promise(function (resolve, reject) {
      var w = { resolve: resolve, reject: reject, timer: 0 };
      if (ms > 0) {
        w.timer = setTimeout(function () {
          readyWaiters = readyWaiters.filter(function (x) { return x !== w; });
          reject(cfError("unavailable", "Code Foundry did not answer this page"));
        }, ms);
      }
      readyWaiters.push(w);
    });
  }

  function notShown() {
    return embedded
      ? cfError("unavailable", "this page was not opened by Code Foundry in this frame (a link followed here has no bridge)")
      : cfError("unavailable", "this page is not shown in Code Foundry");
  }

  // A rough size of what a call sends: the app ignores anything past MAX_CHARS.
  function tooLarge(verb, args) {
    var n = verb.length;
    var keys = Object.keys(args);
    for (var i = 0; i < keys.length; i++) n += keys[i].length + args[keys[i]].length;
    return n > MAX_CHARS;
  }

  function normalizeArgs(args) {
    var out = {};
    if (args === undefined || args === null) return out;
    if (typeof args !== "object" || Array.isArray(args)) throw cfError("invalid", "args must be an object of strings");
    Object.keys(args).forEach(function (k) {
      var v = args[k];
      if (v === undefined || v === null) return;
      if (typeof v === "string") out[k] = v;
      else if (typeof v === "boolean" || (typeof v === "number" && isFinite(v))) out[k] = String(v);
      else throw cfError("invalid", "arg " + k + " must be a string, number or boolean");
    });
    return out;
  }

  function run(verb, args, opts) {
    // Decided now: an await before the check would let the gesture expire.
    var gesture = inGesture();
    var timeout = opts && typeof opts.timeout === "number" ? opts.timeout : RUN_MS;
    var clean;
    try {
      if (typeof verb !== "string" || verb === "") throw cfError("invalid", "verb must be a command name");
      clean = normalizeArgs(args);
      if (tooLarge(verb, clean)) throw cfError("invalid", verb + ": the args are too large (256 KiB at most)");
    } catch (e) {
      return Promise.reject(e);
    }
    return whenReady(READY_MS).then(function () {
      if (!readOnly[verb] && !gesture) {
        throw cfError("gesture", verb + " changes something, so it runs only from a click or key press in the page");
      }
      return new Promise(function (resolve, reject) {
        var id = nextId();
        var p = { resolve: resolve, reject: reject, timer: 0, left: timeout, until: 0, verb: verb, total: timeout, msg: { type: "cf:run", id: id, verb: verb, args: clean }, sent: false };
        pending[id] = p;
        arm(id, p);
        queue.push(id);
        pump();
      });
    });
  }

  // Posts waiting runs while fewer than MAX_RUNS are at the app.
  function pump() {
    while (sending < MAX_RUNS && queue.length > 0) {
      var id = queue.shift();
      var p = pending[id];
      if (!p || p.sent) continue;
      p.sent = true;
      sending += 1;
      post(p.msg);
    }
  }

  // A run is over (answered or given up): its place at the app goes to the next one.
  function done(id, p) {
    delete pending[id];
    clearTimeout(p.timer);
    if (p.sent) {
      sending -= 1;
      pump();
    } else {
      queue = queue.filter(function (x) { return x !== id; });
    }
  }

  // Starts (or, after the app's confirm dialog, resumes) a run's timeout with what is left
  // of it. Giving up tells the app, which aborts the call and never runs a command still
  // waiting to ask.
  function arm(id, p) {
    if (!(p.left > 0)) return;
    p.until = Date.now() + p.left;
    p.timer = setTimeout(function () {
      if (pending[id] !== p) return;
      if (p.sent) post({ type: "cf:cancel", id: id });
      done(id, p);
      p.reject(cfError("timeout", p.verb + " did not answer in " + Math.round(p.total / 1000) + " s"));
    }, p.left);
  }

  // cf:pending: the call waits on the user, so its clock stops until cf:resume.
  function pause(id) {
    var p = pending[id];
    if (!p || !p.timer) return;
    clearTimeout(p.timer);
    p.timer = 0;
    p.left = Math.max(1, p.until - Date.now());
  }

  function hasHeader(headers, name) {
    return Object.keys(headers).some(function (k) { return k.toLowerCase() === name; });
  }

  // The cf:fetch for cf.fetch(url, init), shaped like the Fetch API's: a body that is not a
  // string is sent as JSON (or a form, for URLSearchParams) with its content-type.
  function fetchMessage(url, init) {
    if (url && typeof url === "object" && typeof url.href === "string") url = url.href;
    if (typeof url !== "string") throw cfError("invalid", "cf.fetch(url, init?): url must be a string");
    var u;
    try {
      u = new URL(url);
    } catch (e) {
      throw cfError("invalid", "cf.fetch: " + url.slice(0, 80) + " is not an absolute URL");
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw cfError("invalid", "cf.fetch: only http and https URLs, not " + u.protocol);
    if (init === undefined || init === null) init = {};
    if (typeof init !== "object") throw cfError("invalid", "cf.fetch(url, init?): init must be an object");
    var method = init.method === undefined ? "GET" : String(init.method).toUpperCase();
    var headers = {};
    var h = init.headers;
    if (Array.isArray(h)) h.forEach(function (pair) { headers[String(pair[0])] = String(pair[1]); });
    else if (h && typeof h.forEach === "function") h.forEach(function (v, k) { headers[k] = String(v); });
    else if (h && typeof h === "object") Object.keys(h).forEach(function (k) { if (h[k] !== undefined && h[k] !== null) headers[k] = String(h[k]); });
    else if (h !== undefined && h !== null) throw cfError("invalid", "cf.fetch: headers must be an object of strings");
    var body = init.body;
    var type = null;
    if (body === undefined || body === null) body = "";
    else if (typeof URLSearchParams === "function" && body instanceof URLSearchParams) {
      body = body.toString();
      type = "application/x-www-form-urlencoded;charset=UTF-8";
    } else if (typeof body === "object") {
      var kind = Object.prototype.toString.call(body);
      if (kind !== "[object Object]" && kind !== "[object Array]") throw cfError("invalid", "cf.fetch: body must be a string, or an object sent as JSON (not " + kind.slice(8, -1) + ")");
      body = JSON.stringify(body);
      type = "application/json";
    } else if (typeof body !== "string") throw cfError("invalid", "cf.fetch: body must be a string, or an object sent as JSON");
    if (type && !hasHeader(headers, "content-type")) headers["Content-Type"] = type;
    if (body !== "" && (method === "GET" || method === "HEAD")) throw cfError("invalid", "cf.fetch: a " + method + " request has no body");
    if (new TextEncoder().encode(body).length > FETCH_BODY) throw cfError("invalid", "cf.fetch: the body is too large (1 MiB at most)");
    var n = u.href.length + method.length + body.length;
    Object.keys(headers).forEach(function (k) { n += k.length + headers[k].length; });
    if (n > FETCH_CHARS) throw cfError("invalid", "cf.fetch: the request is too large");
    var t = init.timeout;
    var timeout = typeof t === "number" && t > 0 ? Math.min(t, FETCH_MAX_MS) : FETCH_MS;
    return { type: "cf:fetch", id: "", url: u.href, method: method, headers: headers, body: body, timeout: timeout, host: u.host };
  }

  // cf.fetch: the app makes the request (ThreadService.ProxyFetch), so the API's CORS rules
  // do not apply. Any status resolves; no gesture needed: it changes nothing in the app.
  function fetchVia(url, init) {
    var msg;
    try {
      msg = fetchMessage(url, init);
    } catch (e) {
      return Promise.reject(e);
    }
    return whenReady(READY_MS).then(function () {
      if (!cf.thread) throw cfError("unavailable", "cf.fetch needs the page's thread: this page is not shown in one");
      return new Promise(function (resolve, reject) {
        var id = nextId();
        var host = msg.host;
        delete msg.host;
        msg.id = id;
        var p = { resolve: resolve, reject: reject, timer: 0, left: msg.timeout + FETCH_GRACE_MS, until: 0, verb: "cf.fetch " + host, total: msg.timeout, msg: msg, sent: false, fetch: host };
        pending[id] = p;
        arm(id, p);
        queue.push(id);
        pump();
      });
    });
  }

  // A fetch's answer: text() and json() read the body, which came back whole.
  function fetched(host, r) {
    var text = typeof r.body === "string" ? r.body : "";
    var status = typeof r.status === "number" ? r.status : 0;
    return {
      status: status,
      statusText: typeof r.statusText === "string" ? r.statusText : "",
      ok: status >= 200 && status < 300,
      url: typeof r.url === "string" ? r.url : "",
      headers: r.headers && typeof r.headers === "object" ? r.headers : {},
      text: function () {
        return text;
      },
      json: function () {
        try {
          return JSON.parse(text);
        } catch (e) {
          throw new SyntaxError("cf.fetch: " + host + "'s answer (" + status + ") is not JSON: " + text.slice(0, 80));
        }
      },
    };
  }

  function on(source, fn, onError) {
    if (typeof source !== "string" || source === "" || typeof fn !== "function") {
      throw cfError("invalid", "cf.on(source, fn): a source name and a function");
    }
    var known = readyMsg && cf.thread ? cf.sources : SOURCES;
    if (known.indexOf(source) < 0) {
      throw cfError("invalid", "cf.on: no source " + source + "; the sources are " + known.join(", "));
    }
    var id = nextId();
    subs[id] = { source: source, fn: fn, onError: typeof onError === "function" ? onError : null };
    post({ type: "cf:on", id: id, source: source });
    return function () {
      offId(id);
    };
  }

  function offId(id) {
    if (!subs[id]) return;
    delete subs[id];
    post({ type: "cf:off", id: id });
  }

  // cf.off(source, fn) ends that subscription; cf.off(source) every one to source.
  function off(source, fn) {
    Object.keys(subs).forEach(function (id) {
      var s = subs[id];
      if (s.source === source && (fn === undefined || s.fn === fn)) offId(id);
    });
  }

  // The scheme a page pinned with /cf/theme.css?scheme=light (or dark), or "".
  function pinnedScheme() {
    var link = document.querySelector('link[href*="/cf/theme.css"]');
    var m = /[?&]scheme=(dark|light)\b/.exec(String((link && link.href) || ""));
    return m ? m[1] : "";
  }

  // The new slots on :root, over the stylesheet's, so a page that only links /cf/theme.css
  // repaints without the reload a missing ack would cost it. A page pinned to a scheme keeps
  // its stylesheet's slots while the app shows the other (cf.theme still says what it shows).
  function applyTheme(t) {
    if (!t || typeof t !== "object") return;
    cf.theme = { id: t.id, scheme: t.scheme, vars: t.vars || {} };
    var root = document.documentElement;
    var pinned = pinnedScheme();
    if (pinned && pinned !== t.scheme) {
      if (root) {
        Object.keys(t.vars || {}).forEach(function (k) {
          if (k.indexOf("--") === 0) root.style.removeProperty(k);
        });
        root.style.colorScheme = "";
      }
      return;
    }
    if (root && t.vars && typeof t.vars === "object") {
      Object.keys(t.vars).forEach(function (k) {
        if (k.indexOf("--") === 0) root.style.setProperty(k, String(t.vars[k]));
      });
    }
    // The stylesheet sets color-scheme with the slots; a page without it keeps its own.
    if (root && (t.scheme === "dark" || t.scheme === "light") && document.querySelector('link[href*="/cf/theme.css"]')) {
      root.style.colorScheme = t.scheme;
    }
  }

  function onTheme(fn) {
    if (typeof fn !== "function") throw cfError("invalid", "cf.onTheme(fn): a function");
    themeFns.push(fn);
    return function () {
      themeFns = themeFns.filter(function (x) { return x !== fn; });
    };
  }

  function px(v) {
    return parseFloat(v) || 0;
  }

  // The page's height: the body's, with its margins, or further down the margin box of
  // its last in-flow child. A first or last child's vertical margin collapses out of a body
  // with no padding or border (ui.css's body has no margin either), and scrollHeight misses
  // it: `<Card className="m-3">` alone would be cut by 24px. Fixed and absolute children
  // are left out: an overlay is the frame's height, and scrollHeight counts the rest.
  function measure() {
    var b = document.body;
    if (!b) return 0;
    var cs = window.getComputedStyle(b);
    var h = b.scrollHeight + px(cs.marginTop) + px(cs.marginBottom);
    var y = window.scrollY || 0;
    var kids = b.children || [];
    for (var i = 0; i < kids.length; i++) {
      var ks = window.getComputedStyle(kids[i]);
      if (ks.position === "fixed" || ks.position === "absolute" || ks.display === "none") continue;
      var edge = kids[i].getBoundingClientRect().bottom + y;
      var below = px(cs.paddingBottom) + px(cs.borderBottomWidth);
      // With nothing between them, the child's and the body's bottom margins collapse to the larger.
      var gap = below > 0 ? px(ks.marginBottom) + below + px(cs.marginBottom) : Math.max(px(ks.marginBottom), px(cs.marginBottom));
      h = Math.max(h, edge + gap);
    }
    return Math.ceil(h);
  }

  function resize(height) {
    var h = typeof height === "number" && isFinite(height) && height > 0 ? Math.ceil(height) : measure();
    if (h <= 0) return;
    lastHeight = h;
    post({ type: "cf:resize", height: h });
  }

  var resizeQueued = false;
  function queueResize() {
    if (resizeQueued) return;
    resizeQueued = true;
    window.requestAnimationFrame(function () {
      resizeQueued = false;
      var h = measure();
      if (h > 0 && h !== lastHeight) resize(h);
    });
  }

  // One write through to the app (cf:store; text null removes), applied here at once. A
  // refusal (the storage is full) rejects, and the app's cf:storage after it puts back
  // what is stored.
  function write(key, text) {
    if (text === null) delete stored[key];
    else stored[key] = text;
    writing[key] = (writing[key] || 0) + 1;
    var id = nextId();
    var done = new Promise(function (resolve, reject) {
      stores[id] = { key: key, resolve: resolve, reject: reject };
    });
    done.catch(function (e) {
      if (window.console) console.error("cf.storage: " + e.message);
    });
    post({ type: "cf:store", id: id, key: key, value: text });
    return done;
  }

  function storage(prefix) {
    if (!readyMsg || !cf.thread) throw cfError("unavailable", "cf.storage needs the page's thread: await cf.ready first");
    var base = prefix ? String(prefix) + ":" : "";
    function own() {
      return Object.keys(stored).filter(function (k) { return k.indexOf(base) === 0; });
    }
    return {
      get: function (key) {
        var raw = stored[base + key];
        if (raw === undefined) return null;
        try {
          return JSON.parse(raw);
        } catch (e) {
          return raw;
        }
      },
      set: function (key, value) {
        var text = JSON.stringify(value);
        if (text !== undefined && tooLarge(base + key, { v: text })) return Promise.reject(cfError("invalid", "cf.storage: " + key + " is too large (256 KiB at most)"));
        return write(base + key, text === undefined ? null : text);
      },
      remove: function (key) {
        return write(base + key, null);
      },
      keys: function () {
        return own().map(function (k) { return k.slice(base.length); });
      },
      clear: function () {
        return Promise.all(own().map(function (k) { return write(k, null); }));
      },
    };
  }

  // cf:storage: the thread's whole storage, after another page wrote or a write was refused.
  function restore(values) {
    if (!values || typeof values !== "object") return;
    Object.keys(stored).forEach(function (k) {
      if (!writing[k] && typeof values[k] !== "string") delete stored[k];
    });
    Object.keys(values).forEach(function (k) {
      if (!writing[k] && typeof values[k] === "string") stored[k] = values[k];
    });
  }

  function settle(id, msg) {
    var w = stores[id];
    if (w) {
      delete stores[id];
      if (--writing[w.key] <= 0) delete writing[w.key];
      if (msg.ok) w.resolve();
      else w.reject(cfError((msg.error && msg.error.code) || "failed", (msg.error && msg.error.message) || "cannot store " + w.key));
      return;
    }
    var p = pending[id];
    if (p && p.sent) {
      done(id, p);
      if (msg.ok && p.fetch) {
        p.resolve(fetched(p.fetch, msg.result || {}));
      } else if (msg.ok) {
        var r = msg.result || {};
        var json = r.json;
        if (typeof json === "string" && json !== "") {
          try {
            json = JSON.parse(json);
          } catch (e) {
            // Leave it as the text it is.
          }
        }
        p.resolve({ text: typeof r.text === "string" ? r.text : "", json: json === undefined || json === "" ? null : json });
      } else {
        var err = msg.error || {};
        p.reject(cfError(typeof err.code === "string" ? err.code : "failed", typeof err.message === "string" ? err.message : "the command failed"));
      }
      return;
    }
    // A refused subscription: drop it and tell its owner.
    var s = subs[id];
    if (s && !msg.ok) {
      delete subs[id];
      var e = msg.error || {};
      var ce = cfError(typeof e.code === "string" ? e.code : "failed", typeof e.message === "string" ? e.message : "cannot subscribe to " + s.source);
      if (s.onError) s.onError(ce);
      else if (window.console) console.error("cf.on(" + s.source + "): " + ce.message);
    }
  }

  function receive(e) {
    if (e.source !== host || !embedded) return;
    var m = e.data;
    if (!m || typeof m !== "object" || typeof m.type !== "string") return;
    switch (m.type) {
      case "cf:ready":
        readyMsg = m;
        cf.thread = m.thread && typeof m.thread === "object" ? { id: String(m.thread.id || ""), name: String(m.thread.name || "") } : null;
        readOnly = {};
        (Array.isArray(m.readOnly) ? m.readOnly : []).forEach(function (v) { readOnly[v] = true; });
        cf.readOnly = Object.keys(readOnly);
        cf.sources = Array.isArray(m.sources) ? m.sources.slice() : [];
        restore(m.storage);
        if (m.theme) applyTheme(m.theme);
        readyWaiters.splice(0).forEach(function (w) {
          clearTimeout(w.timer);
          w.resolve(m);
        });
        resolveReady(cf);
        queueResize();
        break;
      case "cf:result":
        settle(m.id, m);
        break;
      case "cf:pending":
        pause(m.id);
        break;
      case "cf:resume":
        var r = pending[m.id];
        if (r && !r.timer) arm(m.id, r);
        break;
      case "cf:storage":
        restore(m.values);
        break;
      case "cf:event":
        var s = subs[m.id];
        if (!s) return;
        try {
          s.fn(m.event, m.source);
        } catch (err) {
          if (window.console) console.error(err);
        }
        break;
      case "cf:theme":
        applyTheme(m);
        themeFns.slice().forEach(function (fn) {
          try {
            fn(cf.theme);
          } catch (err) {
            if (window.console) console.error(err);
          }
        });
        post({ type: "cf:theme:ack" });
        break;
    }
  }

  var resolveReady;
  var rejectReady;
  var ready = new Promise(function (resolve, reject) {
    resolveReady = resolve;
    rejectReady = reject;
  });
  ready.catch(function () {}); // a page that never awaits it outside the app logs nothing
  if (!bridged) rejectReady(notShown());
  else {
    setTimeout(function () {
      if (!readyMsg) rejectReady(cfError("unavailable", "Code Foundry did not answer this page"));
    }, READY_MS);
  }

  var cf = {
    version: VERSION,
    ready: ready,
    thread: null,
    theme: null,
    readOnly: [],
    sources: [],
    run: run,
    on: on,
    off: off,
    onTheme: onTheme,
    resize: resize,
    storage: storage,
    fetch: fetchVia,
  };
  window.cf = cf;

  window.addEventListener("message", receive);
  // A reload keeps the frame's window, so the app could keep feeding the new document what
  // this one asked for: tell it this one goes, so its calls and subscriptions end.
  window.addEventListener("pagehide", function () {
    subs = {};
    post({ type: "cf:bye" });
  });

  function observe() {
    if (typeof ResizeObserver === "function") {
      var ro = new ResizeObserver(queueResize);
      ro.observe(document.documentElement);
      if (document.body) ro.observe(document.body);
    }
    queueResize();
  }
  if (document.body) observe();
  else document.addEventListener("DOMContentLoaded", observe);
  window.addEventListener("load", queueResize);

  post({ type: "cf:hello" });
})();

// Escape the page left alone goes to the app (docs/notes/page-library-fixes-b.md): keys in
// the frame never reach the app's document, so the lightbox could not close on Escape
// once the page had focus. A keydown Escape that nothing in the page consumed (default
// not prevented: an open dialog or menu prevents it) posts {type: "cf:key", key:
// "Escape"} with the frame's nonce; the app closes the lightbox showing this frame and
// ignores it anywhere else. Its own block, apart from the bridge above.
(function () {
  "use strict";
  var host = window.parent;
  var nonceMatch = /(?:^#|&)cf=([A-Za-z0-9_-]+)/.exec(location.hash || "");
  if (!host || host === window || !nonceMatch || window.__cfKeys) return;
  window.__cfKeys = true;
  // Bubble phase on the window: every handler in the page has had the event by then.
  window.addEventListener("keydown", function (e) {
    if (e.key !== "Escape" || e.defaultPrevented || e.isComposing || e.repeat) return;
    try {
      host.postMessage({ type: "cf:key", key: "Escape", cf: 1, nonce: nonceMatch[1] }, "*");
    } catch (err) {
      // The app is gone.
    }
  });
})();
