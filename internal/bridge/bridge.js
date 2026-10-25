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
 *
 * A verb that is not read-only runs only from a user gesture in the page (a click, a key).
 * Every call is a postMessage to the app, which runs it as the page's thread would. A call
 * waiting on the app's confirm dialog does not time out; cf.on throws for an unknown source.
 */
(function () {
  "use strict";
  if (window.cf && window.cf.version) return;

  var VERSION = 1;
  var GESTURE_MS = 5000; // how long after a press, click or key a call counts as the user's
  var READY_MS = 10000; // how long cf.run waits for the app to say hello
  var RUN_MS = 60000; // cf.run's default timeout; opts.timeout overrides it, 0 waits forever
  // The sources a page may subscribe to, until cf:ready names them (internal/bridge Sources).
  var SOURCES = ["thread-list", "thread", "gh", "action", "plugin", "terminal", "project", "workspace", "settings", "update", "ui", "ember"];

  var host = window.parent;
  var embedded = !!host && host !== window;
  var seq = 0;
  var idBase = "cf" + Math.random().toString(36).slice(2, 10) + "-";
  var pending = {}; // run id -> {resolve, reject, timer, left, until, verb, total}
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

  function post(msg) {
    if (!embedded) return;
    msg.cf = VERSION;
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
    if (!embedded) return Promise.reject(cfError("unavailable", "this page is not shown in Code Foundry"));
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
    } catch (e) {
      return Promise.reject(e);
    }
    return whenReady(READY_MS).then(function () {
      if (!readOnly[verb] && !gesture) {
        throw cfError("gesture", verb + " changes something, so it runs only from a click or key press in the page");
      }
      return new Promise(function (resolve, reject) {
        var id = nextId();
        var p = { resolve: resolve, reject: reject, timer: 0, left: timeout, until: 0, verb: verb, total: timeout };
        pending[id] = p;
        arm(id, p);
        post({ type: "cf:run", id: id, verb: verb, args: clean });
      });
    });
  }

  // Starts (or, after the app's confirm dialog, resumes) a run's timeout with what is left
  // of it. Giving up tells the app, which then never runs a command still waiting to ask.
  function arm(id, p) {
    if (!(p.left > 0)) return;
    p.until = Date.now() + p.left;
    p.timer = setTimeout(function () {
      if (pending[id] !== p) return;
      delete pending[id];
      post({ type: "cf:cancel", id: id });
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

  // The new slots on :root, over the stylesheet's, so a page that only links /cf/theme.css
  // repaints without the reload a missing ack would cost it.
  function applyTheme(t) {
    if (!t || typeof t !== "object") return;
    cf.theme = { id: t.id, scheme: t.scheme, vars: t.vars || {} };
    var root = document.documentElement;
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

  function measure() {
    var b = document.body;
    if (!b) return 0;
    var cs = window.getComputedStyle(b);
    var h = b.scrollHeight + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
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
    if (p) {
      delete pending[id];
      clearTimeout(p.timer);
      if (msg.ok) {
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
  if (!embedded) rejectReady(cfError("unavailable", "this page is not shown in Code Foundry"));
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
  };
  window.cf = cf;

  window.addEventListener("message", receive);
  // A reload keeps the frame's window, so the app could keep feeding a subscription the new
  // document never made: end them as the page goes.
  window.addEventListener("pagehide", function () {
    Object.keys(subs).forEach(offId);
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
