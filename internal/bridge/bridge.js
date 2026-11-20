/*
 * Code Foundry's page bridge, protocol 1 (docs/notes/bridge-1-daemon.md).
 *
 *   <script src="/cf/bridge.js"></script>
 *
 * gives the page window.cf:
 *   cf.ready                      Promise, resolved once the app said hello (cf:ready)
 *   cf.thread {id, name} | null   the thread the page acts for; null: none (errors-and-limits.md)
 *   cf.theme {id, scheme, vars}   the app's theme; cf.onTheme(fn) on every change
 *   cf.run(verb, args?, opts?)    Promise of {text, json}; rejects with {code, message}
 *   cf.on(source, fn) / cf.off    live data, fn(value, source): now, then on change; on returns an unsubscribe
 *   cf.resize(height?)            the card follows the page's height by itself
 *   cf.storage(prefix?)           the page file's storage, kept across restarts; .onChange(fn) hears other copies
 *   cf.fetch(url, init?)          Promise of {status, ok, headers, text(), json()}; the app makes it: no CORS
 *
 * A verb that is not read-only runs only within 5 s of a click or key press in the page.
 * Every call is a postMessage to the app, which runs it as the page's thread would. A call
 * waiting on the app's confirm dialog does not time out; cf.on throws for an unknown source.
 * At most 32 runs and fetches are at the app at once (more wait here, their timeouts running)
 * and 16 subscriptions; a call's args, or a stored value, may be up to 256 KiB.
 *
 * A page no thread owns asks the user once whether it may use Code Foundry: until they answer,
 * cf.ready waits (the app said cf:asking), and nothing times out. Allowed, it has storage, fetch,
 * the verbs that need no thread and every source but "thread"; refused, every call says so.
 *
 * The app opens the page with a nonce in its URL's query (?cf-nonce=<nonce>; the fragment
 * stays the page's own), sent back on every message (docs/notes/bridge-fix-frames.md,
 * page-frame-states.md), and carried on to the page's own other files when it goes to one
 * in its frame (the last block below). A page reached any other way (another site's or
 * another grant's link, another tab) has no bridge, and cf.ready rejects at once.
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
  // The frame's nonce, from the query the app opened the page with; "" for none.
  var nonceMatch = /[?&]cf-nonce=([A-Za-z0-9_-]+)/.exec(location.search || "");
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
  var watchers = []; // cf.storage(prefix).onChange: {base, fn}, in the order added
  var themeFns = [];
  var readyMsg = null;
  var readyWaiters = [];
  var readyTimer = 0;
  // The app holds cf:ready while it asks the user about this page (cf:asking): no wait for
  // it times out, however long the user takes to answer.
  var holding = false;
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

  // A call refused here, before it reached the app (no click for a verb that changes
  // something, args it cannot send, no such source): the page gets the error as before, and
  // the app is told, for a page check (cf:refused; docs/notes/page-self-check.md).
  function refused(call, e) {
    if (e && e.name === "CfError") post({ type: "cf:refused", call: String(call).slice(0, 200), code: String(e.code), message: String(e.message).slice(0, 500) });
    return e;
  }

  // Gestures: transient user activation, or a real press, click or key in the page in the
  // last 5 s. Either is enough: in the app's old side panel WebKit reported isActive false
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
      if (ms > 0 && !holding) {
        w.timer = setTimeout(function () {
          readyWaiters = readyWaiters.filter(function (x) { return x !== w; });
          reject(cfError("unavailable", "Code Foundry did not answer this page"));
        }, ms);
      }
      readyWaiters.push(w);
    });
  }

  // Whether the app gave this page `what` ("storage", "fetch") in its cf:ready. An app from
  // before pages without a thread sends no `can`: then a page has them only with a thread.
  function may(what) {
    if (!readyMsg) return false;
    var can = readyMsg.can;
    if (can && typeof can === "object") return can[what] === true;
    return !!cf.thread;
  }

  // The refusal of `call` the app gave no `may` for: its reason (the user has not allowed the
  // page, it is not a page the app gives a bridge), or no thread from an older app.
  function denied(call) {
    var why = typeof readyMsg.refusal === "string" && readyMsg.refusal !== "" ? readyMsg.refusal : "this page is not shown in a thread";
    return cfError("unavailable", call + ": " + why);
  }

  function notShown() {
    return embedded
      ? cfError("unavailable", "this page was not opened by Code Foundry in this frame (a link followed here has no bridge)")
      : cfError("unavailable", "this page is not shown in Code Foundry");
  }

  // Whether the app would ignore msg: it counts the type, id, verb, key, value and each
  // arg's name and value against MAX_CHARS. The id is not made yet, so its longest.
  function tooLarge(msg) {
    var n = msg.type.length + idBase.length + 16;
    ["verb", "key", "value"].forEach(function (k) {
      if (typeof msg[k] === "string") n += msg[k].length;
    });
    var args = msg.args || {};
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
      if (tooLarge({ type: "cf:run", verb: verb, args: clean })) throw cfError("invalid", verb + ": the args are too large: 256 KiB of text at most, all together (base64 makes bytes a third larger)");
    } catch (e) {
      return Promise.reject(refused(typeof verb === "string" && verb ? verb : "cf.run", e));
    }
    return whenReady(READY_MS).then(function () {
      // Only a command the app has (cf:ready's verbs; none from an older app, or one that could
      // not list them, and then every name) needs the gesture: the app answers a name that is
      // no command, and every call of a page it refused, saying so, instead of sending the
      // page after a click it does not need.
      var verbs = readyMsg.verbs;
      var known = !Array.isArray(verbs) || verbs.length === 0 || verbs.indexOf(verb) >= 0;
      if (!readOnly[verb] && !gesture && known && !readyMsg.refusal) throw refused(verb, gestureError(verb));
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

  function gestureError(verb) {
    return cfError("gesture", verb + " changes something, so it runs only within 5 s of a click or key press in the page: start it in the handler, before slow awaits");
  }

  // A run's timeout as its error says it: whole seconds, tenths under 10 s ("1.5 s", not "2 s").
  function seconds(ms) {
    return ms >= 10000 ? String(Math.round(ms / 1000)) : String(Math.round(ms / 100) / 10);
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
      p.reject(cfError("timeout", p.verb + " did not answer in " + seconds(p.total) + " s"));
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
      return Promise.reject(refused("cf.fetch", e));
    }
    return whenReady(READY_MS).then(function () {
      if (!may("fetch")) throw denied("cf.fetch");
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
      throw refused("cf.on", cfError("invalid", "cf.on(source, fn): a source name and a function"));
    }
    // Before cf:ready, and on a page given no sources (the app refuses its calls, saying why), every name.
    var known = readyMsg && cf.sources.length > 0 ? cf.sources : SOURCES;
    if (known.indexOf(source) < 0) {
      throw refused('cf.on("' + source + '")', cfError("invalid", "cf.on: no source " + source + "; the sources are " + known.join(", ")));
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
  // refusal (the storage is full, the key too long) rejects with what was there put back,
  // so keys() and clear() right after it do not see the refused key; the app's cf:storage
  // after it puts back what is stored.
  function write(key, text) {
    var before = stored[key];
    if (text === null) delete stored[key];
    else stored[key] = text;
    writing[key] = (writing[key] || 0) + 1;
    var id = nextId();
    var done = new Promise(function (resolve, reject) {
      stores[id] = { key: key, before: before, resolve: resolve, reject: reject };
    });
    done.catch(function (e) {
      if (window.console) console.error("cf.storage: " + e.message);
    });
    post({ type: "cf:store", id: id, key: key, value: text });
    return done;
  }

  function storage(prefix) {
    if (!readyMsg) throw cfError("unavailable", "cf.storage: Code Foundry has not answered this page yet; await cf.ready first");
    if (!may("storage")) throw denied("cf.storage");
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
        if (text !== undefined && tooLarge({ type: "cf:store", key: base + key, value: text })) return Promise.reject(cfError("invalid", "cf.storage: " + key + " is too large (256 KiB at most)"));
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
      onChange: function (fn) {
        return watch(base, function () {
          return own().map(function (k) { return k.slice(base.length); });
        }, fn);
      },
    };
  }

  // cf:storage: the whole storage, after another copy of the page wrote (in this window or
  // another), or a write was refused. The keys whose value it changed here are announced.
  function restore(values) {
    if (!values || typeof values !== "object") return;
    var changed = [];
    Object.keys(stored).forEach(function (k) {
      if (!writing[k] && typeof values[k] !== "string") {
        delete stored[k];
        changed.push(k);
      }
    });
    Object.keys(values).forEach(function (k) {
      if (!writing[k] && typeof values[k] === "string" && stored[k] !== values[k]) {
        stored[k] = values[k];
        changed.push(k);
      }
    });
    announce(changed);
  }

  // Tells each onChange watcher the keys of its prefix among `keys` (whole keys), without
  // the prefix. Never for the page's own write: write() changes `stored` without announcing,
  // and the app's map after it holds what the page wrote, which changes nothing here.
  function announce(keys) {
    if (keys.length === 0) return;
    watchers.slice().forEach(function (w) {
      if (watchers.indexOf(w) < 0) return;
      var mine = keys.filter(function (k) { return k.indexOf(w.base) === 0; }).map(function (k) { return k.slice(w.base.length); });
      if (mine.length > 0) tell(w, mine);
    });
  }

  function tell(w, keys) {
    try {
      w.fn(keys);
    } catch (err) {
      if (window.console) console.error(err);
    }
  }

  // cf.storage(prefix).onChange(fn): fn(keys) once now (a microtask later) with every key the
  // prefix holds, as cf.on calls with the value now, then with the keys another copy of the
  // page or the app changed (set or removed); the storage holds the new values when fn runs.
  // Returns an unsubscribe.
  function watch(base, keysNow, fn) {
    if (typeof fn !== "function") throw cfError("invalid", "cf.storage().onChange(fn): a function");
    var w = { base: base, fn: fn };
    watchers.push(w);
    Promise.resolve().then(function () {
      if (watchers.indexOf(w) >= 0) tell(w, keysNow());
    });
    return function () {
      watchers = watchers.filter(function (x) { return x !== w; });
    };
  }

  function settle(id, msg) {
    var w = stores[id];
    if (w) {
      delete stores[id];
      if (--writing[w.key] <= 0) delete writing[w.key];
      if (msg.ok) {
        w.resolve();
        return;
      }
      // Refused, and no later write of the key in flight (its value stays): the key as it
      // was, announced, since the page may have drawn the value it set.
      if (!writing[w.key]) {
        var refused = stored[w.key];
        if (w.before === undefined) delete stored[w.key];
        else stored[w.key] = w.before;
        if (stored[w.key] !== refused) announce([w.key]);
      }
      w.reject(cfError((msg.error && msg.error.code) || "failed", (msg.error && msg.error.message) || "cannot store " + w.key));
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
        clearTimeout(readyTimer);
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
      case "cf:asking":
        if (readyMsg) break;
        holding = true;
        clearTimeout(readyTimer);
        readyWaiters.forEach(function (w) {
          clearTimeout(w.timer);
          w.timer = 0;
        });
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
    readyTimer = setTimeout(function () {
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
    watchers = [];
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
  var nonceMatch = /[?&]cf-nonce=([A-Za-z0-9_-]+)/.exec(location.search || "");
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

// A page's own next document keeps the bridge (docs/notes/leftovers-pages.md). A navigation
// the page makes to another file of its own (at this origin, which is its grant's own host,
// or under its own grant's /preview/<grant>/ on the preview route) is sent on with the
// frame's nonce in its query, so that document's bridge works too. A navigation to another
// site or another grant goes as it is, without the nonce, so it has no bridge there. With
// the Navigation API every such navigation (a link, location = …, location.assign or
// replace) is seen with where it goes; without it, a followed link is. Its own block, apart
// from the bridge above.
(function () {
  "use strict";
  var nonceMatch = /[?&]cf-nonce=([A-Za-z0-9_-]+)/.exec(location.search || "");
  var grant = /^[0-9a-f]{32}\.localhost$/.test(location.hostname) ? ["/"] : /^\/preview\/[^/]+\//.exec(location.pathname || "");
  if (window.parent === window || !nonceMatch || !grant || window.__cfFollow) return;
  window.__cfFollow = true;
  var nonce = nonceMatch[1];

  // The URL to load in place of href: the same with the nonce, or "" to let it go as it is.
  function carried(href) {
    var u;
    try {
      u = new URL(String(href), location.href);
    } catch (_) {
      return "";
    }
    if (u.origin !== location.origin || u.pathname.indexOf(grant[0]) !== 0) return "";
    if (/[?&]cf-nonce=/.test(u.search)) return "";
    u.search = (u.search ? u.search + "&" : "?") + "cf-nonce=" + nonce;
    return u.href;
  }

  // A document of an opaque origin (the sandbox of a page no thread owns) has the Navigation
  // API's events turned off (HTML: "has entries and events disabled"): no navigate event comes,
  // so it carries the nonce on a followed link, as a browser without the API does.
  var nav = window.origin === "null" ? null : window.navigation;
  if (nav && typeof nav.addEventListener === "function") {
    nav.addEventListener("navigate", function (e) {
      // A form's POST would turn into a GET; a reload or a step back keeps its own URL.
      if (!e.cancelable || e.destination.sameDocument || e.formData || e.downloadRequest) return;
      if (e.navigationType !== "push" && e.navigationType !== "replace") return;
      var next = carried(e.destination.url);
      if (!next) return;
      e.preventDefault();
      if (e.navigationType === "replace") location.replace(next);
      else location.assign(next);
    });
    return;
  }
  // In the bubble phase, after the page's own handlers: a click the page took is the page's.
  window.addEventListener("click", function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target && typeof e.target.closest === "function" ? e.target.closest("a[href], area[href]") : null;
    if (!a || a.hasAttribute("download")) return;
    var target = (a.getAttribute("target") || "").toLowerCase();
    if (target && target !== "_self") return;
    var next = carried(a.href);
    if (!next) return;
    e.preventDefault();
    location.assign(next);
  });
})();
