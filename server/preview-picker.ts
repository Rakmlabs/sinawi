import { accessibleRole, formatNode } from "./browser-snapshot.js";
import { cssSelectorFor, trimOuterHtml } from "./preview-selector.js";

// Injected into every proxied HTML page. Talks to the Sinawi window via postMessage.
const body = String.raw`
(function () {
  if (window.__orchestraPicker) return;
  window.__orchestraPicker = true;
  var cssSelectorFor = __CSS_SELECTOR__;
  var trimOuterHtml = __TRIM__;
  var accessibleRole = __ROLE__;
  var formatNode = __NODE__;
  var parentWin = window.parent;
  if (!parentWin || parentWin === window) return;
  function post(msg) { msg.source = "orchestra-preview"; try { parentWin.postMessage(msg, "*"); } catch (e) {} }

  // ---- location reporting ----
  var lastHref = "";
  function report() {
    if (location.href === lastHref && document.title === report.t) return;
    lastHref = location.href; report.t = document.title;
    post({ type: "location", href: location.href, title: document.title });
  }
  ["pushState", "replaceState"].forEach(function (name) {
    var original = history[name];
    history[name] = function () { var r = original.apply(this, arguments); setTimeout(report, 0); return r; };
  });
  addEventListener("popstate", report); addEventListener("hashchange", report);
  addEventListener("DOMContentLoaded", report); addEventListener("load", report);
  setInterval(report, 1000); report();

  // ---- mouse back/forward buttons → app-managed tab history ----
  ["mousedown", "mouseup", "auxclick"].forEach(function (type) {
    addEventListener(type, function (e) {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault(); e.stopPropagation();
      if (type === "mouseup") post({ type: "shortcut", key: e.button === 3 ? "[" : "]", code: e.button === 3 ? "BracketLeft" : "BracketRight", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false });
    }, true);
  });

  // ---- shortcut forwarding (keys never reach the app while the iframe has focus) ----
  addEventListener("keydown", function (e) {
    var k = (e.key || "").toLowerCase();
    var meta = e.metaKey && !e.altKey;
    var forward = (meta && !e.ctrlKey && (/^[1-9]$/.test(k) || ["t", "w", "l", "r", "["," ]".trim(), "]"].indexOf(k) >= 0 || (e.shiftKey && (k === "c" || k === "b" || k === "t"))))
      || (e.ctrlKey && !e.metaKey && (e.key === "Tab" || e.code === "Backquote"))
      || (e.metaKey && e.altKey && e.code === "KeyI")
      || (e.ctrlKey && e.altKey && !e.metaKey && !e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp"))
      || (e.metaKey && e.shiftKey && !e.altKey && !e.ctrlKey && e.code === "KeyJ");
    if (picking && e.key === "Escape" && !(e.target && e.target.closest && e.target.closest("[data-orchestra-ui]"))) { e.preventDefault(); e.stopPropagation(); stopPicking(); return; }
    if (!forward) return;
    e.preventDefault(); e.stopPropagation();
    post({ type: "shortcut", key: e.key, code: e.code, metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey });
  }, true);
  addEventListener("focus", function () { post({ type: "focus" }); });
  addEventListener("pointerdown", function () { post({ type: "focus" }); }, true);

  // ---- picker UI ----
  var picking = false, hoverEl = null, selected = [], host = null, shadow = null, hoverBox = null, hoverLabel = null, toolbar = null, layer = null;
  function designTokens() {
    return ":host{--font-sans:\"Pretendard Variable\",Pretendard,-apple-system,BlinkMacSystemFont,\"Apple SD Gothic Neo\",\"Malgun Gothic\",\"Segoe UI\",sans-serif;--font-mono:ui-monospace,SFMono-Regular,monospace;--text-title:12px;--text-body-large:13px;--text-body:15px;--text-dialog:16px;--text-heading:19px;--radius-micro:4px;--radius-activity-tab:6px;--radius-compact:8px;--radius-control:9px;--radius-suggestion:11px;--radius-composer:12px;--radius-mobile-team:13px;--radius-pill:40px;--radius-round:50%}";
  }
  function css() {
    return designTokens() + ".box{position:fixed;pointer-events:none;border:2px solid #4f8cff;background:rgba(79,140,255,.12);border-radius:var(--radius-micro);z-index:1;transition:all .06s}" +
      ".sel{border-color:#ff8a3d;background:rgba(255,138,61,.10)}" +
      ".label{position:fixed;pointer-events:none;background:#1b2440;color:#fff;font:600 var(--text-body-large)/1.3 var(--font-sans);padding:4px 8px;border-radius:var(--radius-activity-tab);white-space:nowrap;max-width:420px;overflow:hidden;text-overflow:ellipsis;box-shadow:0 4px 14px rgba(0,0,0,.25)}" +
      ".num{position:fixed;pointer-events:none;background:#ff8a3d;color:#fff;font:700 var(--text-body-large)/22px var(--font-sans);min-width:22px;height:22px;text-align:center;border-radius:var(--radius-suggestion);padding:0 6px}" +
      ".bar{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);display:flex;gap:8px;align-items:center;background:rgba(20,26,44,.94);color:#fff;font:600 var(--text-body)/1.3 var(--font-sans);padding:8px 10px 8px 16px;border-radius:var(--radius-mobile-team);box-shadow:0 10px 30px rgba(0,0,0,.35);pointer-events:auto}" +
      "button{font:600 var(--text-body) var(--font-sans);border:0;border-radius:var(--radius-control);padding:7px 12px;cursor:pointer;background:#2c3656;color:#fff}button.primary{background:#4f8cff}button:disabled{opacity:.45;cursor:default}" +
      ".pop{position:fixed;width:300px;background:#fff;color:#111;border-radius:var(--radius-composer);box-shadow:0 12px 34px rgba(0,0,0,.3);padding:10px;pointer-events:auto;font:var(--text-body) var(--font-sans)}" +
      ".pop b{display:block;font-size:var(--text-body-large);font-family:var(--font-mono);color:#444;margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".pop textarea{width:100%;box-sizing:border-box;min-height:70px;font:var(--text-body)/1.45 var(--font-sans);border:1px solid #c9cfdd;border-radius:var(--radius-compact);padding:8px;resize:vertical;color:#111;background:#fff}" +
      ".pop .row{display:flex;justify-content:flex-end;gap:6px;margin-top:8px}.pop button{background:#eef1f7;color:#1b2440}.pop button.primary{background:#4f8cff;color:#fff}";
  }
  function ensureUi() {
    if (host) return;
    host = document.createElement("div");
    host.setAttribute("data-orchestra-ui", "");
    host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
    shadow = host.attachShadow({ mode: "open" });
    var style = document.createElement("style"); style.textContent = css(); shadow.appendChild(style);
    layer = document.createElement("div"); shadow.appendChild(layer);
    hoverBox = document.createElement("div"); hoverBox.className = "box"; shadow.appendChild(hoverBox);
    hoverLabel = document.createElement("div"); hoverLabel.className = "label"; shadow.appendChild(hoverLabel);
    toolbar = document.createElement("div"); toolbar.className = "bar"; shadow.appendChild(toolbar);
    document.documentElement.appendChild(host);
  }
  function describe(el) {
    var cls = (el.getAttribute("class") || "").trim().split(/\s+/).filter(Boolean).slice(0, 3).map(function (c) { return "." + c; }).join("");
    var comp = reactInfo(el);
    var r = el.getBoundingClientRect();
    return (comp && comp.name ? "<" + comp.name + "> " : "") + el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + cls + "  " + Math.round(r.width) + "×" + Math.round(r.height);
  }
  function place(box, r) { box.style.left = r.left + "px"; box.style.top = r.top + "px"; box.style.width = Math.max(0, r.width) + "px"; box.style.height = Math.max(0, r.height) + "px"; }
  function renderBar() {
    if (!toolbar) return;
    toolbar.innerHTML = "";
    var t = document.createElement("span"); t.textContent = selected.length ? "요소 " + selected.length + "개 선택됨" : "요소를 클릭해서 선택 (Esc 종료)"; toolbar.appendChild(t);
    var attach = document.createElement("button"); attach.className = "primary"; attach.textContent = "채팅에 첨부"; attach.disabled = !selected.length;
    attach.onclick = function (e) { e.stopPropagation(); finish(); };
    var cancel = document.createElement("button"); cancel.textContent = "취소"; cancel.onclick = function (e) { e.stopPropagation(); stopPicking(); };
    toolbar.appendChild(attach); toolbar.appendChild(cancel);
    toolbar.style.display = picking ? "flex" : "none";
    post({ type: "picking", on: picking, count: selected.length });
  }
  function frame() {
    if (!picking) return;
    layer.innerHTML = "";
    selected.forEach(function (item, i) {
      if (!item.el.isConnected) return;
      var r = item.el.getBoundingClientRect();
      var b = document.createElement("div"); b.className = "box sel"; place(b, r); layer.appendChild(b);
      var n = document.createElement("div"); n.className = "num"; n.textContent = String(i + 1); n.style.left = Math.max(0, r.left - 4) + "px"; n.style.top = Math.max(0, r.top - 12) + "px"; layer.appendChild(n);
    });
    if (hoverEl && hoverEl.isConnected) {
      var r = hoverEl.getBoundingClientRect(); place(hoverBox, r); hoverBox.style.display = "block";
      hoverLabel.textContent = describe(hoverEl); hoverLabel.style.display = "block";
      var top = r.top - 30; if (top < 4) top = Math.min(innerHeight - 30, r.bottom + 6);
      hoverLabel.style.left = Math.max(4, Math.min(r.left, innerWidth - 300)) + "px"; hoverLabel.style.top = top + "px";
    } else { hoverBox.style.display = "none"; hoverLabel.style.display = "none"; }
    requestAnimationFrame(frame);
  }
  function isUi(e) { var p = e.composedPath ? e.composedPath() : []; return p.indexOf(host) >= 0; }
  function onMove(e) { if (isUi(e)) { hoverEl = null; return; } var el = document.elementFromPoint(e.clientX, e.clientY); if (el && el !== host) hoverEl = el; }
  function swallow(e) { if (isUi(e)) return; e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); }
  function onClick(e) {
    if (isUi(e)) return;
    swallow(e);
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === host) return;
    var existing = selected.findIndex(function (s) { return s.el === el; });
    if (existing >= 0) { openPopover(existing); return; }
    selected.push({ el: el, comment: "" });
    renderBar();
    openPopover(selected.length - 1);
  }
  var pop = null;
  function closePopover() { if (pop) { pop.remove(); pop = null; } }
  function openPopover(index) {
    closePopover();
    var item = selected[index]; if (!item) return;
    var r = item.el.getBoundingClientRect();
    pop = document.createElement("div"); pop.className = "pop";
    var title = document.createElement("b"); title.textContent = (index + 1) + ". " + describe(item.el); pop.appendChild(title);
    var ta = document.createElement("textarea"); ta.placeholder = "이 요소에 대한 메모 (예: 버튼 색을 더 진하게)"; ta.value = item.comment; pop.appendChild(ta);
    var row = document.createElement("div"); row.className = "row";
    var remove = document.createElement("button"); remove.textContent = "선택 해제";
    remove.onclick = function () { selected.splice(index, 1); closePopover(); renderBar(); };
    var ok = document.createElement("button"); ok.className = "primary"; ok.textContent = "확인";
    ok.onclick = function () { item.comment = ta.value.trim(); closePopover(); };
    row.appendChild(remove); row.appendChild(ok); pop.appendChild(row);
    ta.addEventListener("keydown", function (e) {
      e.stopPropagation();
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); ok.onclick(); }
      if (e.key === "Escape") { e.preventDefault(); ok.onclick(); }
    });
    ta.addEventListener("input", function () { item.comment = ta.value.trim(); });
    var left = Math.max(8, Math.min(r.left, innerWidth - 316));
    var top = r.bottom + 8; if (top + 170 > innerHeight) top = Math.max(8, r.top - 178);
    pop.style.left = left + "px"; pop.style.top = top + "px";
    shadow.appendChild(pop);
    setTimeout(function () { ta.focus(); }, 0);
  }
  function startPicking() {
    ensureUi(); if (picking) return;
    picking = true; renderBar();
    addEventListener("mousemove", onMove, true);
    ["pointerdown", "mousedown", "pointerup", "mouseup", "dblclick", "contextmenu"].forEach(function (t) { addEventListener(t, swallow, true); });
    addEventListener("click", onClick, true);
    document.documentElement.style.cursor = "crosshair";
    requestAnimationFrame(frame);
  }
  function stopPicking(keep) {
    picking = false; hoverEl = null; closePopover();
    removeEventListener("mousemove", onMove, true);
    ["pointerdown", "mousedown", "pointerup", "mouseup", "dblclick", "contextmenu"].forEach(function (t) { removeEventListener(t, swallow, true); });
    removeEventListener("click", onClick, true);
    document.documentElement.style.cursor = "";
    if (!keep) selected = [];
    if (layer) layer.innerHTML = "";
    if (hoverBox) { hoverBox.style.display = "none"; hoverLabel.style.display = "none"; }
    renderBar();
  }

  // ---- element data ----
  function reactInfo(el) {
    var out = null;
    try {
      var key = Object.keys(el).find(function (k) { return k.indexOf("__reactFiber$") === 0 || k.indexOf("__reactInternalInstance$") === 0; });
      var fiber = key ? el[key] : null, names = [], source = null, stackHint = null, guard = 0;
      while (fiber && guard++ < 60) {
        var t = fiber.type;
        if (t && typeof t !== "string") {
          var name = t.displayName || t.name || (t.render && (t.render.displayName || t.render.name));
          if (name && names.length < 4 && names.indexOf(name) < 0) names.push(name);
          if (!source && fiber._debugSource) source = fiber._debugSource.fileName + ":" + fiber._debugSource.lineNumber + (fiber._debugSource.columnNumber ? ":" + fiber._debugSource.columnNumber : "");
          if (!stackHint && fiber._debugStack && fiber._debugStack.stack) {
            var line = String(fiber._debugStack.stack).split("\n").slice(1).find(function (l) { return !/node_modules|react-dom|react\.development|jsx-dev-runtime/.test(l); });
            if (line) stackHint = line.trim().replace(/^at\s+/, "");
          }
        }
        if (names.length >= 4 && source) break;
        fiber = fiber.return;
      }
      if (names.length || source) out = { name: names[0], chain: names, source: source || undefined, stack: stackHint || undefined };
    } catch (e) {}
    var n = el, guard2 = 0;
    while (n && n.nodeType === 1 && guard2++ < 10) {
      var file = n.getAttribute("data-inspector-relative-path") || n.getAttribute("data-source") || n.getAttribute("data-file") || n.getAttribute("data-component-path");
      var comp = n.getAttribute("data-component") || n.getAttribute("data-component-name");
      if (file || comp) {
        out = out || {};
        if (comp && !out.name) out.name = comp;
        if (file && !out.source) out.source = file + (n.getAttribute("data-inspector-line") ? ":" + n.getAttribute("data-inspector-line") : "");
        break;
      }
      n = n.parentElement;
    }
    return out;
  }
  var STYLE_KEYS = ["display","position","width","height","margin","padding","color","background-color","background-image","font-family","font-size","font-weight","line-height","text-align","border","border-radius","box-shadow","gap","flex-direction","justify-content","align-items","grid-template-columns","overflow","opacity","z-index"];
  function styles(el) {
    var cs = getComputedStyle(el), out = {};
    STYLE_KEYS.forEach(function (k) { var v = cs.getPropertyValue(k); if (v && v !== "none" && v !== "normal" && v !== "auto" && v !== "0px" && v !== "rgba(0, 0, 0, 0)") out[k] = v.length > 160 ? v.slice(0, 160) + "…" : v; });
    return out;
  }
  function withTimeout(p, ms) { return Promise.race([p, new Promise(function (r) { setTimeout(function () { r(null); }, ms); })]); }
  function loadH2i() {
    if (window.htmlToImage) return Promise.resolve(window.htmlToImage);
    return new Promise(function (resolve) {
      var s = document.createElement("script"); s.src = "/__orchestra/h2i.js";
      s.onload = function () { resolve(window.htmlToImage || null); }; s.onerror = function () { resolve(null); };
      document.documentElement.appendChild(s);
    });
  }
  var shotFilter = function (node) { return node !== host; };
  function shotElement(h, el) {
    var r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return Promise.resolve(null);
    var ratio = Math.min(2, window.devicePixelRatio || 1, 2400 / Math.max(r.width, r.height));
    return withTimeout(h.toPng(el, { pixelRatio: ratio, filter: shotFilter, skipFonts: true, cacheBust: false }).catch(function () { return null; }), 6000);
  }
  function shotViewport(h) {
    var root = document.documentElement;
    return withTimeout(h.toPng(root, {
      width: innerWidth, height: innerHeight, pixelRatio: Math.min(2, window.devicePixelRatio || 1), filter: shotFilter, skipFonts: true,
      backgroundColor: getComputedStyle(document.body || root).backgroundColor || "#ffffff",
      style: { transform: "translate(" + (-scrollX) + "px," + (-scrollY) + "px)", transformOrigin: "0 0" },
    }).catch(function () { return null; }), 8000);
  }
  function finish() {
    var items = selected.slice();
    if (!items.length) return;
    stopPicking(true);
    post({ type: "progress", text: "요소 정보와 화면을 캡처하는 중…" });
    loadH2i().then(function (h) {
      var viewportP = h ? shotViewport(h) : Promise.resolve(null);
      return viewportP.then(function (viewport) {
        return Promise.all(items.map(function (item) {
          var el = item.el, r = el.getBoundingClientRect();
          var data = {
            url: location.href, title: document.title, comment: item.comment,
            selector: cssSelectorFor(el, document), tag: el.tagName.toLowerCase(),
            text: (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 300),
            outerHTML: trimOuterHtml(el.outerHTML, 1500), styles: styles(el),
            rect: { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), width: Math.round(r.width), height: Math.round(r.height) },
            viewport: { width: innerWidth, height: innerHeight, scrollX: Math.round(scrollX), scrollY: Math.round(scrollY), dpr: window.devicePixelRatio || 1 },
            react: reactInfo(el) || undefined,
          };
          return (h ? shotElement(h, el) : Promise.resolve(null)).then(function (png) { data.screenshot = png || undefined; return data; });
        })).then(function (list) { post({ type: "attachments", items: list, viewportShot: viewport || undefined }); selected = []; renderBar(); });
      });
    }).catch(function (e) { post({ type: "error", text: String(e && e.message || e) }); });
  }


  // ---- AI agent control ----
  var logs = [];
  function pushLog(level, args) {
    try { logs.push({ level: level, text: Array.prototype.map.call(args, function (a) { try { return a instanceof Error ? (a.stack || a.message) : typeof a === "object" ? JSON.stringify(a) : String(a); } catch (e) { return String(a); } }).join(" ").slice(0, 2000), at: Date.now() }); if (logs.length > 200) logs.shift(); } catch (e) {}
  }
  ["error", "warn"].forEach(function (level) { var orig = console[level]; console[level] = function () { pushLog(level, arguments); return orig.apply(console, arguments); }; });
  addEventListener("error", function (e) {
    var target = e.target;
    if (target && target !== window && (target.src || target.href)) { netRecord(target.src || target.href, 0); return; }
    pushLog("error", [e.message + (e.filename ? " (" + e.filename + ":" + e.lineno + ")" : "")]);
  }, true);
  addEventListener("unhandledrejection", function (e) { pushLog("error", ["Unhandled rejection: " + (e.reason && (e.reason.stack || e.reason.message) || e.reason)]); });

  var netInflight = 0, netErrors = [], netAll = [];
  function netRecord(url, status) {
    var item = { url: String(url || "").slice(0, 300), status: Number(status) || 0 };
    netAll.push(item); if (netAll.length > 200) netAll.shift();
    if (!item.status || item.status >= 400) { netErrors.push(item); if (netErrors.length > 80) netErrors.shift(); }
  }
  function netStart(url) { netInflight++; return url; }
  function netFinish(url, status) { netInflight = Math.max(0, netInflight - 1); netRecord(url, status); }
  if (window.fetch) {
    var origFetch = window.fetch;
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      netStart(url);
      return Promise.resolve(origFetch.apply(this, arguments)).then(function (res) { netFinish(url, res.status); return res; }, function (err) { netFinish(url, 0); throw err; });
    };
  }
  var origOpen = XMLHttpRequest.prototype.open, origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) { this.__aoUrl = url; return origOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    var xhr = this, url = xhr.__aoUrl;
    netStart(url);
    xhr.addEventListener("loadend", function () { netFinish(url, xhr.status); });
    return origSend.apply(this, arguments);
  };
  function waitIdle(timeout) {
    var until = Date.now() + Math.min(20000, Number(timeout) || 5000), quiet = 0;
    return new Promise(function (res) {
      (function check() {
        if (netInflight === 0) { if (!quiet) quiet = Date.now(); if (Date.now() - quiet >= 400) return res({ idle: true, pending: 0 }); }
        else quiet = 0;
        if (Date.now() > until) return res({ idle: false, pending: netInflight });
        setTimeout(check, 100);
      })();
    });
  }

  var nextDialog = { set: false, accept: true, promptText: "" }, lastDialog = null;
  function rememberDialog(type, message, accept) {
    lastDialog = { type: type, message: String(message == null ? "" : message), accept: accept, armed: nextDialog.set };
    nextDialog = { set: false, accept: true, promptText: "" };
    return lastDialog;
  }
  window.alert = function (message) { rememberDialog("alert", message, true); };
  window.confirm = function (message) { var accept = nextDialog.set ? nextDialog.accept : false; rememberDialog("confirm", message, accept); return accept; };
  window.prompt = function (message, def) {
    var accept = nextDialog.set ? nextDialog.accept : false;
    var text = nextDialog.promptText || (def == null ? "" : String(def));
    rememberDialog("prompt", message, accept);
    return accept ? text : null;
  };

  var navOrig = null;
  var viewportWatch = null;
  function defineNav(key, getter) { try { Object.defineProperty(navigator, key, { configurable: true, get: getter }); } catch (e) {} }
  function lockViewport(width) {
    var px = Math.round(Number(width));
    var locked = px >= 200 && px <= 4000;
    var content = locked ? ("width=" + px + ", initial-scale=1, minimum-scale=1, maximum-scale=1") : "";
    function apply() {
      var list = document.querySelectorAll('meta[name="viewport"]');
      if (!locked) {
        for (var i = 0; i < list.length; i++) {
          var orig = list[i].getAttribute("data-ao-viewport");
          if (orig == null) continue;
          if (orig === "") list[i].remove();
          else { list[i].setAttribute("content", orig); list[i].removeAttribute("data-ao-viewport"); }
        }
        return;
      }
      if (!list.length) {
        var head = document.head || document.documentElement;
        if (!head) return;
        var created = document.createElement("meta");
        created.setAttribute("name", "viewport");
        created.setAttribute("data-ao-viewport", "");
        created.setAttribute("content", content);
        head.insertBefore(created, head.firstChild);
        return;
      }
      for (var j = 0; j < list.length; j++) {
        if (!list[j].hasAttribute("data-ao-viewport")) list[j].setAttribute("data-ao-viewport", list[j].getAttribute("content") || "");
        if (list[j].getAttribute("content") !== content) list[j].setAttribute("content", content);
      }
    }
    apply();
    if (locked && !viewportWatch && document.documentElement) {
      viewportWatch = new MutationObserver(function () { apply(); });
      viewportWatch.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["content", "name"] });
    }
    if (!locked && viewportWatch) { viewportWatch.disconnect(); viewportWatch = null; }
  }
  document.addEventListener("DOMContentLoaded", function () { if (window.__aoViewportWidth) lockViewport(window.__aoViewportWidth); });
  function applyEmulation(d) {
    if (!navOrig) navOrig = { userAgent: navigator.userAgent, appVersion: navigator.appVersion, platform: navigator.platform, maxTouchPoints: navigator.maxTouchPoints || 0 };
    var mobile = d && d.mobile && d.userAgent;
    defineNav("userAgent", function () { return mobile ? d.userAgent : navOrig.userAgent; });
    defineNav("appVersion", function () { return mobile ? String(d.userAgent).replace(/^Mozilla\//, "") : navOrig.appVersion; });
    defineNav("platform", function () { return mobile ? (d.platform || "iPhone") : navOrig.platform; });
    defineNav("maxTouchPoints", function () { return mobile && d.touch ? 5 : navOrig.maxTouchPoints; });
    window.__aoTouch = Boolean(mobile && d.touch);
    if (window.__aoTouch && !("ontouchstart" in window)) window.ontouchstart = null;
    var frameWidth = d && Number(d.width);
    window.__aoViewportWidth = frameWidth >= 200 && frameWidth <= 4000 ? Math.round(frameWidth) : 0;
    lockViewport(window.__aoViewportWidth);
    window.__aoEmulation = d || {};
    if (!d || !d.persist) return;
    try {
      var encoded = JSON.stringify({ mobile: !!mobile, touch: !!(d && d.touch), userAgent: mobile ? d.userAgent : "", platform: mobile ? (d.platform || "iPhone") : "", width: window.__aoViewportWidth || 0 });
      var prev = sessionStorage.getItem("ao-emulation");
      if (prev !== encoded) sessionStorage.setItem("ao-emulation", encoded);
    } catch (e) {}
  }
  try { var savedEmu = sessionStorage.getItem("ao-emulation"); if (savedEmu) applyEmulation(JSON.parse(savedEmu)); } catch (e) {}
  if (window.matchMedia && !window.__aoMatch) {
    window.__aoMatch = true;
    var origMatch = window.matchMedia.bind(window);
    window.matchMedia = function (query) {
      var q = String(query);
      if (window.__aoTouch) q = q.replace(/\(pointer:\s*fine\)/gi, "(pointer: coarse)").replace(/\(hover:\s*hover\)/gi, "(hover: none)");
      return origMatch(q);
    };
  }

  var refSeq = 0, aiHost = null, aiShadow = null, aiDot = null, aiRing = null, aiBadge = null, aiHideTimer = null;
  function ensureAi() {
    if (aiHost && aiHost.isConnected) return;
    aiHost = document.createElement("div"); aiHost.setAttribute("data-orchestra-ui", "");
    aiHost.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
    aiShadow = aiHost.attachShadow({ mode: "open" });
    var st = document.createElement("style");
    st.textContent = designTokens() + ".dot{position:fixed;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:var(--radius-round);background:#ff4f9a;box-shadow:0 0 0 4px rgba(255,79,154,.3),0 2px 8px rgba(0,0,0,.3);transition:left .35s ease,top .35s ease,transform .15s;left:50%;top:50%;display:none}" +
      ".dot.press{transform:scale(.7)}.ring{position:fixed;border:2px solid #ff4f9a;border-radius:var(--radius-activity-tab);background:rgba(255,79,154,.08);transition:all .25s;display:none}" +
      ".badge{position:fixed;top:10px;right:10px;display:none;align-items:center;gap:8px;background:rgba(20,26,44,.94);color:#fff;font:600 var(--text-body-large)/1.2 var(--font-sans);padding:6px 6px 6px 12px;border-radius:var(--radius-pill);box-shadow:0 6px 20px rgba(0,0,0,.3);pointer-events:auto}" +
      ".badge i{width:8px;height:8px;border-radius:var(--radius-round);background:#ff4f9a;animation:p 1s infinite}@keyframes p{50%{opacity:.3}}" +
      ".badge button{font:600 var(--text-title) var(--font-sans);border:0;border-radius:var(--radius-pill);padding:5px 10px;background:#ff4f9a;color:#fff;cursor:pointer}";
    aiShadow.appendChild(st);
    aiRing = document.createElement("div"); aiRing.className = "ring"; aiShadow.appendChild(aiRing);
    aiDot = document.createElement("div"); aiDot.className = "dot"; aiShadow.appendChild(aiDot);
    aiBadge = document.createElement("div"); aiBadge.className = "badge";
    aiBadge.innerHTML = "<i></i><span>AI 조작 중</span>";
    var stop = document.createElement("button"); stop.textContent = "중지 (Esc)"; stop.onclick = function (e) { e.stopPropagation(); post({ type: "agent-stop" }); hideAi(); };
    aiBadge.appendChild(stop); aiShadow.appendChild(aiBadge);
    document.documentElement.appendChild(aiHost);
  }
  function showAi() { ensureAi(); aiBadge.style.display = "flex"; aiDot.style.display = "block"; clearTimeout(aiHideTimer); aiHideTimer = setTimeout(hideAi, 4000); }
  function hideAi() { if (!aiHost) return; aiBadge.style.display = "none"; aiDot.style.display = "none"; aiRing.style.display = "none"; }
  addEventListener("keydown", function (e) { if (e.key === "Escape" && aiBadge && aiBadge.style.display === "flex") { post({ type: "agent-stop" }); hideAi(); } }, true);
  function pointAt(el) {
    showAi();
    var r = el.getBoundingClientRect();
    aiRing.style.display = "block"; place(aiRing, { left: r.left - 3, top: r.top - 3, width: r.width + 6, height: r.height + 6 });
    aiDot.style.left = (r.left + r.width / 2) + "px"; aiDot.style.top = (r.top + r.height / 2) + "px";
    return new Promise(function (res) { setTimeout(res, 380); });
  }
  function visible(el) {
    var r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false;
    var cs = getComputedStyle(el); return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
  }
  var INTERACTIVE = "a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=switch],[role=option],[role=combobox],[role=textbox],[contenteditable=''],[contenteditable=true],[onclick],[tabindex]:not([tabindex='-1'])";
  function refOf(el) { var r = el.getAttribute("data-ao-ref"); if (!r) { r = "e" + (++refSeq); el.setAttribute("data-ao-ref", r); } return r; }
  function labelledBy(el) {
    var id = el.getAttribute("aria-labelledby"); if (!id) return "";
    return id.split(/\s+/).map(function (part) { var n = document.getElementById(part); return n ? (n.innerText || n.textContent || "") : ""; }).join(" ").replace(/\s+/g, " ").trim().slice(0, 80);
  }
  function nameOf(el) {
    var n = el.getAttribute("aria-label") || el.getAttribute("title") || "";
    if (!n) n = labelledBy(el);
    if (!n && el.id) { var l = document.querySelector("label[for='" + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + "']"); if (l) n = l.innerText; }
    if (!n && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) n = el.getAttribute("placeholder") || el.getAttribute("name") || "";
    if (!n) n = el.innerText || el.textContent || "";
    if (!n && el.tagName === "IMG") n = el.alt || "";
    if (!n) { var img = el.querySelector && el.querySelector("img[alt],svg[aria-label]"); if (img) n = img.getAttribute("alt") || img.getAttribute("aria-label") || ""; }
    return n.replace(/\s+/g, " ").trim().slice(0, 80);
  }
  function nameFor(el, role) {
    if (role === "navigation" || role === "main" || role === "banner" || role === "contentinfo" || role === "complementary" || role === "form" || role === "region" || role === "dialog") return (el.getAttribute("aria-label") || el.getAttribute("title") || labelledBy(el) || "").replace(/\s+/g, " ").trim().slice(0, 80);
    return nameOf(el);
  }
  function nodeRole(el) {
    var role = accessibleRole(el.tagName, String(el.type || ""), el.getAttribute("role") || "", !!el.isContentEditable);
    var interactive = false;
    try { interactive = el.matches(INTERACTIVE); } catch (e) {}
    if (!role && interactive) role = el.tagName.toLowerCase();
    return { role: role, interactive: interactive };
  }
  function snapshot() {
    var lines = [], count = 0, truncated = false;
    var skip = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, LINK: 1, META: 1 };
    var structural = { heading: 1, navigation: 1, main: 1, banner: 1, contentinfo: 1, complementary: 1, form: 1, dialog: 1, img: 1 };
    function walk(el, depth) {
      if (truncated || !el || el.nodeType !== 1 || skip[el.tagName]) return;
      if ((aiHost && (el === aiHost || aiHost.contains(el))) || (host && (el === host || host.contains(el)))) return;
      if (el.getAttribute("aria-hidden") === "true" || el.hasAttribute("hidden")) return;
      var cs; try { cs = getComputedStyle(el); } catch (e) { cs = null; }
      if (cs && (cs.display === "none" || cs.visibility === "hidden")) return;
      var info = nodeRole(el);
      var role = info.role;
      var emit = false;
      if (role && role !== "list" && role !== "listitem" && count < 300) {
        if (role === "region" && !el.getAttribute("aria-label") && !el.getAttribute("aria-labelledby") && !el.getAttribute("title")) emit = false;
        else if (info.interactive || structural[role]) emit = visible(el) || role === "dialog";
      }
      var next = depth;
      if (emit) {
        if (count >= 300) truncated = true;
        else {
          count++;
          var states = [];
          if (role === "heading") { var level = (el.tagName.match(/^H([1-6])$/i) || [])[1] || el.getAttribute("aria-level") || "1"; states.push("[level=" + level + "]"); }
          if ("value" in el && el.tagName !== "BUTTON" && String(el.type || "").toLowerCase() !== "file" && el.value) states.push("value=" + JSON.stringify(String(el.value).slice(0, 60)));
          if (el.checked) states.push("checked");
          if (el.disabled || el.getAttribute("aria-disabled") === "true") states.push("disabled");
          var expanded = el.getAttribute("aria-expanded"); if (expanded === "true") states.push("expanded"); else if (expanded === "false") states.push("collapsed");
          if (el.getAttribute("aria-pressed") === "true") states.push("pressed");
          if (el.getAttribute("aria-selected") === "true") states.push("selected");
          if (el.required || el.getAttribute("aria-required") === "true") states.push("required");
          if (el.tagName === "A" && el.getAttribute("href")) states.push("href=" + el.getAttribute("href").slice(0, 80));
          if (document.activeElement === el) states.push("active");
          var rect = el.getBoundingClientRect();
          if (rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) states.push("(화면 밖)");
          var giveRef = info.interactive || role === "img" || role === "heading" || role === "dialog";
          lines.push(formatNode(depth, role, nameFor(el, role), giveRef ? refOf(el) : undefined, states));
          next = depth + 1;
        }
      }
      var kids = el.children;
      for (var i = 0; i < kids.length; i++) walk(kids[i], next);
      if (el.shadowRoot) { var shadowKids = el.shadowRoot.children; for (var s = 0; s < shadowKids.length; s++) walk(shadowKids[s], next); }
    }
    if (document.body) walk(document.body, 0);
    var head = "# " + (document.title || "문서") + "  " + location.href;
    if (nextDialog.set) head += "\n(다음 대화상자: " + (nextDialog.accept ? "accept" : "dismiss") + (nextDialog.promptText ? " " + JSON.stringify(nextDialog.promptText) : "") + ")";
    if (lastDialog) head += "\n[dialog] " + lastDialog.type + " " + JSON.stringify(lastDialog.message) + (lastDialog.accept ? " accept" : " dismiss") + (lastDialog.armed ? "" : " (클릭 전에 ao-browser dialog accept)");
    return { url: location.href, title: document.title, count: count, snapshot: head + "\n" + lines.join("\n") + (truncated || count >= 300 ? "\n… (300개까지만 표시)" : "") };
  }
  function find(args) {
    var el = null;
    if (args.ref) el = document.querySelector("[data-ao-ref='" + String(args.ref).replace(/'/g, "") + "']");
    else if (args.selector) { try { el = document.querySelector(String(args.selector)); } catch (e) { throw new Error("잘못된 선택자: " + args.selector + ". snapshot의 ref를 쓰세요."); } }
    if (!el) throw new Error("요소를 찾을 수 없습니다: " + (args.ref || args.selector || "(대상 없음)") + " — snapshot 을 다시 찍으세요.");
    return el;
  }
  function center(el) { var r = el.getBoundingClientRect(); return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true, composed: true, view: window }; }
  function setValue(el, value) {
    var proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function keyEventInit(combo) {
    var parts = String(combo || "Enter").split("+").filter(Boolean);
    var raw = parts.length ? parts[parts.length - 1] : "Enter";
    var mods = parts.slice(0, -1).join("+").toLowerCase();
    var named = { enter: "Enter", tab: "Tab", escape: "Escape", esc: "Escape", backspace: "Backspace", delete: "Delete", arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown", space: " " };
    var key = named[raw.toLowerCase()] || raw;
    return {
      key: key,
      code: key.length === 1 ? (/[a-z]/i.test(key) ? "Key" + key.toUpperCase() : /\d/.test(key) ? "Digit" + key : key) : key,
      bubbles: true, cancelable: true, composed: true,
      ctrlKey: mods.indexOf("control") >= 0 || mods.indexOf("ctrl") >= 0,
      metaKey: mods.indexOf("meta") >= 0 || mods.indexOf("cmd") >= 0 || mods.indexOf("command") >= 0,
      altKey: mods.indexOf("alt") >= 0 || mods.indexOf("option") >= 0,
      shiftKey: mods.indexOf("shift") >= 0,
    };
  }
  function optionByLabel(el, want) {
    var options = Array.prototype.slice.call(el.options || []);
    for (var i = 0; i < options.length; i++) {
      var opt = options[i];
      if (opt.value === want || opt.label === want || String(opt.text || "").trim() === want) return opt;
    }
    throw new Error("옵션을 찾을 수 없습니다: " + JSON.stringify(want) + ". 있는 값: " + (options.map(function (o) { return o.label || o.value; }).slice(0, 12).join(", ") || "(없음)"));
  }
  function fileInput(el) {
    if (el.tagName === "INPUT" && String(el.type || "").toLowerCase() === "file") return el;
    var nested = el.querySelector ? el.querySelector("input[type=file]") : null;
    if (!nested) throw new Error("파일 입력칸이 아닙니다: snapshot의 input[file]을 지정하세요.");
    return nested;
  }
  var agentActions = {
    snapshot: function () { return snapshot(); },
    status: function () { return { url: location.href, title: document.title, ready: document.readyState, networkPending: netInflight }; },
    networkidle: function (a) { return waitIdle(a && a.timeout); },
    network: function (a) {
      var list = a && a.all ? netAll.slice(-50) : netErrors.slice(-40);
      var lines = list.map(function (n, i) { return (i + 1) + ". " + (n.status || "ERR") + " " + n.url; });
      return { count: list.length, text: lines.length ? lines.join("\n") : (a && a.all ? "네트워크 요청 없음" : "네트워크 오류 없음") };
    },
    dialog: function (a) {
      if (a && a.invalid) throw new Error("대화상자 명령은 accept 또는 dismiss 입니다. 예: ao-browser dialog accept");
      if (!a || a.accept === undefined) {
        if (!lastDialog) return { note: "열린 대화상자 없음" };
        return { dialog: lastDialog.type, message: lastDialog.message, accept: lastDialog.accept, note: lastDialog.type + " " + JSON.stringify(lastDialog.message) };
      }
      nextDialog = { set: true, accept: a.accept !== false, promptText: String(a.promptText || "") };
      return { armed: nextDialog.accept ? "accept" : "dismiss", promptText: nextDialog.promptText, note: "다음 confirm/prompt는 " + (nextDialog.accept ? "accept" : "dismiss") };
    },
    click: function (a) {
      var el = find(a); el.scrollIntoView({ block: "center", inline: "center" });
      return pointAt(el).then(function () {
        aiDot.className = "dot press"; setTimeout(function () { aiDot.className = "dot"; }, 160);
        var o = center(el);
        el.dispatchEvent(new PointerEvent("pointerdown", o)); el.dispatchEvent(new MouseEvent("mousedown", o));
        if (el.focus) el.focus();
        el.dispatchEvent(new PointerEvent("pointerup", o)); el.dispatchEvent(new MouseEvent("mouseup", o));
        el.click();
        return sleep(250).then(function () { return { clicked: a.ref || a.selector, url: location.href }; });
      });
    },
    hover: function (a) {
      var el = find(a); el.scrollIntoView({ block: "center", inline: "center" });
      return pointAt(el).then(function () {
        var o = center(el);
        el.dispatchEvent(new PointerEvent("pointerover", o)); el.dispatchEvent(new MouseEvent("mouseover", o));
        el.dispatchEvent(new MouseEvent("mousemove", o));
        return { hovered: a.ref || a.selector };
      });
    },
    fill: function (a, append) {
      var el = find(a); el.scrollIntoView({ block: "center" });
      return pointAt(el).then(function () {
        if (el.focus) el.focus();
        var text = String(a.text == null ? "" : a.text);
        if (el.tagName === "SELECT") { var opt = optionByLabel(el, text); setValue(el, opt.value); return { filled: a.ref || a.selector, value: opt.value }; }
        if (el.isContentEditable) { if (!append) el.textContent = ""; document.execCommand("insertText", false, text); }
        else if ("value" in el) setValue(el, (append ? el.value : "") + text);
        else throw new Error("입력할 수 없는 요소입니다. textbox, combobox, input[file] 중 snapshot에 있는 ref를 쓰세요.");
        return { filled: a.ref || a.selector, value: "value" in el ? el.value : el.textContent };
      });
    },
    type: function (a) { return agentActions.fill(a, true); },
    select: function (a) {
      var el = find(a);
      if (el.tagName !== "SELECT") throw new Error("드롭다운이 아닙니다: " + (a.ref || a.selector) + ". snapshot의 combobox를 지정하세요.");
      var want = String(a.value == null ? (a.text == null ? "" : a.text) : a.value);
      if (!want) throw new Error("선택할 값이 필요합니다. 예: ao-browser select e5 서울");
      var opt = optionByLabel(el, want);
      if (el.focus) el.focus();
      setValue(el, opt.value);
      return pointAt(el).then(function () { return { selected: a.ref || a.selector, value: opt.value, label: opt.label || opt.text }; });
    },
    upload: function (a) {
      var el = fileInput(find(a));
      var file = a.file;
      if (!file || !file.base64) throw new Error("파일 내용이 없습니다. 예: ao-browser upload e3 /절대/경로.png");
      if (typeof DataTransfer === "undefined" || typeof File === "undefined") throw new Error("이 페이지에서 파일 입력을 만들 수 없습니다.");
      var bin = atob(file.base64), bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var blob = new File([bytes], file.name || "file", { type: file.type || "application/octet-stream" });
      var dt = new DataTransfer();
      dt.items.add(blob);
      el.files = dt.files;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return pointAt(el).then(function () { return { uploaded: a.ref || a.selector, name: blob.name, size: blob.size }; });
    },
    press: function (a) {
      var el = a.ref || a.selector ? find(a) : (document.activeElement || document.body);
      var key = String(a.key || "Enter");
      if (!key) throw new Error("키가 필요합니다. 예: ao-browser press Enter 또는 ao-browser press Control+A");
      var init = keyEventInit(key);
      showAi();
      if (el.focus) el.focus();
      var down = el.dispatchEvent(new KeyboardEvent("keydown", init));
      el.dispatchEvent(new KeyboardEvent("keypress", init));
      el.dispatchEvent(new KeyboardEvent("keyup", init));
      if (down && init.key === "Enter" && el.form && el.tagName === "INPUT") { if (el.form.requestSubmit) el.form.requestSubmit(); else el.form.submit(); }
      if (down && init.key === "Tab") { var f = Array.prototype.slice.call(document.querySelectorAll(INTERACTIVE)).filter(visible); var i = f.indexOf(el); var nxt = f[i + (init.shiftKey ? -1 : 1)]; if (nxt) nxt.focus(); }
      return sleep(150).then(function () { return { pressed: key }; });
    },
    keyboard: function (a) {
      var key = String(a.key || a.text || "");
      if (!key) throw new Error("키가 필요합니다. 예: ao-browser keyboard Enter 또는 ao-browser keyboard \"안녕하세요\"");
      if (key.indexOf("+") >= 0 || /^(Enter|Tab|Escape|Esc|Backspace|Delete|Arrow(Up|Down|Left|Right)|Home|End|PageUp|PageDown|Space)$/i.test(key)) return agentActions.press(Object.assign({}, a, { key: key }));
      var el = a.ref || a.selector ? find(a) : (document.activeElement || document.body);
      if (el.focus) el.focus();
      showAi();
      for (var i = 0; i < key.length; i++) {
        var ch = key.charAt(i);
        var init = { key: ch, bubbles: true, cancelable: true, composed: true };
        el.dispatchEvent(new KeyboardEvent("keydown", init));
        if (el.isContentEditable) document.execCommand("insertText", false, ch);
        else if ("value" in el && el.tagName !== "SELECT") setValue(el, String(el.value || "") + ch);
        else throw new Error("글자를 넣을 수 없는 요소입니다. textbox ref를 지정하거나 그 칸을 먼저 클릭하세요.");
        el.dispatchEvent(new KeyboardEvent("keyup", init));
      }
      return { pressed: key, typed: true };
    },
    scroll: function (a) {
      showAi();
      if ((a.ref || a.selector) && !a.direction) { var into = find(a); into.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" }); return pointAt(into).then(function () { return { scrollY: Math.round(scrollY), scrolled: a.ref || a.selector }; }); }
      if (a.ref || a.selector) {
        var el = find(a);
        var d = a.direction || "down", amt = Number(a.amount) || Math.round((el.clientHeight || innerHeight) * 0.8);
        if (el.scrollHeight > el.clientHeight + 2) {
          if (d === "top") el.scrollTop = 0; else if (d === "bottom") el.scrollTop = el.scrollHeight; else el.scrollTop += d === "up" ? -amt : amt;
          return pointAt(el).then(function () { return { scrollY: Math.round(el.scrollTop), scrolled: a.ref || a.selector }; });
        }
      }
      var dir = a.direction || "down", amount = Number(a.amount) || Math.round(innerHeight * 0.8);
      if (dir === "top") scrollTo({ top: 0, behavior: "smooth" }); else if (dir === "bottom") scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
      else scrollBy({ top: dir === "up" ? -amount : amount, behavior: "smooth" });
      return sleep(450).then(function () { return { scrollY: Math.round(scrollY), height: document.documentElement.scrollHeight }; });
    },
    wait: function (a) {
      if (a && a.idle) return waitIdle(a.timeout).then(function (r) { if (!r.idle) throw new Error("네트워크가 조용해지지 않았습니다. 진행 중 " + r.pending + "건."); return r; });
      var until = Date.now() + Math.min(55000, Number(a.timeout) || 15000);
      return new Promise(function (res, rej) {
        (function check() {
          var ok = false;
          try { ok = a.text ? (document.body && document.body.innerText.indexOf(String(a.text)) >= 0) : a.selector ? Boolean(document.querySelector(String(a.selector))) : document.readyState === "complete"; } catch (e) { return rej(new Error("잘못된 선택자: " + a.selector)); }
          if (ok) return res({ found: a.text || a.selector || "load" });
          if (Date.now() > until) return rej(new Error("기다렸지만 나타나지 않았습니다: " + (a.text || a.selector || "load")));
          setTimeout(check, 200);
        })();
      });
    },
    text: function (a) {
      var el = a.ref || a.selector ? find(a) : document.body;
      return { text: (el.innerText || el.textContent || "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 20000) };
    },
    console: function () {
      var out = logs.slice(-50);
      var text = out.length ? out.map(function (l) { return "[" + l.level + "] " + l.text; }).join("\n") : "콘솔 오류/경고 없음";
      var nets = netErrors.slice(-20);
      if (nets.length) text += "\n\n네트워크 오류\n" + nets.map(function (n) { return (n.status || "ERR") + " " + n.url; }).join("\n");
      return { count: out.length, networkErrors: nets.length, text: text };
    },
    screenshot: function (a) {
      hideAi();
      return loadH2i().then(function (h) {
        if (!h) throw new Error("스크린샷 모듈을 불러오지 못했습니다.");
        var el = a.ref || a.selector ? find(a) : null;
        if (el) {
          var box = el.getBoundingClientRect();
          if (box.width < 1 || box.height < 1) throw new Error("요소가 화면에 크기가 없습니다: " + (a.ref || a.selector));
        }
        return (el ? shotElement(h, el) : shotViewport(h)).then(function (png) {
          if (!png) throw new Error("스크린샷에 실패했습니다. 요소가 화면 밖에 있으면 scroll로 가져온 뒤 다시 찍으세요.");
          var box = el ? el.getBoundingClientRect() : null;
          return { image: png, url: location.href, width: box ? Math.round(box.width) : innerWidth, height: box ? Math.round(box.height) : innerHeight };
        });
      });
    },
  };
  // ---- in-page devtools (bundled eruda: console, network, elements) ----
  function toggleDevtools() {
    function go() {
      var e = window.eruda; if (!e) { post({ type: "error", text: "개발자 도구를 불러오지 못했습니다." }); return; }
      if (!window.__orchestraEruda) { e.init({ tool: ["console", "elements", "network", "resources", "sources", "info"], defaults: { displaySize: 45, theme: "Dark" } }); window.__orchestraEruda = true; logs.forEach(function (l) { try { e.get("console")[l.level](l.text); } catch (x) {} }); e.show(); return; }
      var dev = e._devTools || (e.get && e.get());
      if (dev && dev._isShow) e.hide(); else e.show();
    }
    if (window.eruda) return go();
    var s = document.createElement("script"); s.src = "/__orchestra/eruda.js"; s.onload = go; s.onerror = function () { post({ type: "error", text: "개발자 도구 스크립트 로드 실패" }); };
    document.documentElement.appendChild(s);
  }
  var inflight = {};
  addEventListener("pagehide", function () {
    Object.keys(inflight).forEach(function (id) { post({ type: "agent-result", id: id, ok: true, result: { navigated: true, from: location.href, note: "페이지가 이동했습니다. snapshot 을 다시 찍으세요." } }); });
    inflight = {};
  });
  function runAgent(d) {
    var fn = agentActions[d.action];
    inflight[d.id] = true;
    var done = function (ok, value) { if (!inflight[d.id]) return; delete inflight[d.id]; post({ type: "agent-result", id: d.id, ok: ok, result: ok ? value : undefined, error: ok ? undefined : value }); };
    if (!fn) return done(false, "이 페이지에서 지원하지 않는 명령: " + d.action);
    var withSnap = { click: 1, fill: 1, type: 1, press: 1, scroll: 1, hover: 1, upload: 1, select: 1, keyboard: 1, dialog: 1 };
    try { Promise.resolve(fn(d.args || {})).then(function (v) {
      if (withSnap[d.action] && v && typeof v === "object") { try { var snap = snapshot(); v.snapshot = snap.snapshot; if (!v.url) v.url = snap.url; } catch (e) {} }
      done(true, v);
    }, function (e) { done(false, String(e && e.message || e)); }); }
    catch (e) { done(false, String(e && e.message || e)); }
  }
  addEventListener("message", function (e) {
    var d = e.data; if (!d || d.source !== "orchestra-parent") return;
    if (d.type === "agent") { runAgent(d); return; }
    if (d.type === "emulate") { applyEmulation(d); return; }
    if (d.type === "agent-hide") { hideAi(); return; }
    if (d.type === "devtools") { toggleDevtools(); return; }
    if (d.type === "pick") { if (d.on) startPicking(); else stopPicking(); }
    else if (d.type === "attach") finish();
    // Never history.back()/forward(): on a tab's first page that walks the app window's own history.
    else if (d.type === "go" && typeof d.href === "string" && /^https?:\/\//.test(d.href)) { try { location.replace(d.href); } catch (e) {} }
    else if (d.type === "reload") location.reload();
    else if (d.type === "ping") post({ type: "location", href: location.href, title: document.title });
  });
})();
`;

export function pickerScript(): string {
  return body
    .replace("__CSS_SELECTOR__", () => `(${cssSelectorFor.toString()})`)
    .replace("__TRIM__", () => `(${trimOuterHtml.toString()})`)
    .replace("__ROLE__", () => `(${accessibleRole.toString()})`)
    .replace("__NODE__", () => `(${formatNode.toString()})`);
}
