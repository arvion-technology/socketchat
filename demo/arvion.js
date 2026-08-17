/* ARVION UI — shared runtime helpers (zero dependencies).
   Load with <script src="arvion.js"></script>; everything hangs off window.A. */
(function (global) {
  "use strict";

  /* ---------- dom ------------------------------------------------------- */
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === "class") node.className = v;
        else if (k === "html") node.innerHTML = v;
        else if (k === "text") node.textContent = v;
        else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === "dataset") Object.assign(node.dataset, v);
        else node.setAttribute(k, v);
      }
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      node.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return node;
  }
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  function mount(target) {
    const host = typeof target === "string" ? $(target) : target;
    if (!host) throw new Error("A.mount: target not found");
    return { node: host, add: (...nodes) => (host.append(...nodes.map((n) => (n.nodeType ? n : document.createTextNode(String(n))))), host) };
  }

  /* ---------- formatting ------------------------------------------------ */
  const fmt = {
    num: (n, opts = {}) => new Intl.NumberFormat("en-US", opts).format(n),
    compact(n) {
      const abs = Math.abs(n);
      if (abs >= 1e9) return (n / 1e9).toFixed(abs >= 1e10 ? 0 : 1).replace(/\.0$/, "") + "B";
      if (abs >= 1e6) return (n / 1e6).toFixed(abs >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
      if (abs >= 1e3) return (n / 1e3).toFixed(abs >= 1e4 ? 0 : 1).replace(/\.0$/, "") + "k";
      return String(Math.round(n));
    },
    money(n, currency = "USD", digits = 2) {
      return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: digits }).format(n);
    },
    pct(n, digits = 1) { return (n * 100).toFixed(digits).replace(/\.0$/, "") + "%"; },
    bytes(n) {
      const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0;
      while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
      return n.toFixed(i ? 1 : 0) + " " + u[i];
    },
    date(d, mode = "short") {
      const x = d instanceof Date ? d : new Date(d);
      if (Number.isNaN(+x)) return "—";
      if (mode === "iso") return x.toISOString().slice(0, 10);
      if (mode === "time") return x.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
      if (mode === "long") return x.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
      return x.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    },
    relative(d) {
      const x = d instanceof Date ? d : new Date(d);
      const s = Math.round((Date.now() - +x) / 1000);
      if (s < 45) return "just now";
      const table = [[60, "s"], [3600, "m"], [86400, "h"], [2592000, "d"], [31536000, "mo"], [Infinity, "y"]];
      let prev = 1;
      for (const [limit, unit] of table) {
        if (s < limit) return Math.max(1, Math.round(s / prev)) + unit + " ago";
        prev = limit;
      }
      return "—";
    },
    initials(name) {
      return (name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
    },
    title(s) { return s.replace(/(^|\s|[-_])(\w)/g, (m, p, c) => p.replace(/[-_]/, " ") + c.toUpperCase()); },
  };

  /* ---------- deterministic random -------------------------------------- */
  function rng(seed = 42) {
    let a = seed >>> 0;
    return function next() {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
  const between = (r, min, max) => min + r() * (max - min);
  const int = (r, min, max) => Math.floor(between(r, min, max + 1));
  function normal(r, mean = 0, sd = 1) {
    const u = 1 - r(), v = r();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /* ---------- storage ---------------------------------------------------- */
  const store = {
    get(key, fallback = null) {
      try { const raw = localStorage.getItem("arvion:" + key); return raw ? JSON.parse(raw) : fallback; }
      catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem("arvion:" + key, JSON.stringify(value)); return true; } catch { return false; }
    },
    remove(key) { try { localStorage.removeItem("arvion:" + key); } catch { /* ignore */ } },
    clear() { try { Object.keys(localStorage).filter((k) => k.startsWith("arvion:")).forEach((k) => localStorage.removeItem(k)); } catch { /* ignore */ } },
  };

  /* ---------- events ------------------------------------------------------ */
  function toast(message, kind = "info", ms = 3200) {
    let host = $(".toasts");
    if (!host) { host = el("div", { class: "toasts", role: "status", "aria-live": "polite" }); document.body.append(host); }
    const node = el("div", { class: "toast " + (kind === "success" ? "ok" : kind === "error" ? "err" : "") },
      el("span", { class: "dot", style: "color:" + (kind === "success" ? "var(--green)" : kind === "error" ? "var(--red)" : "var(--gold)") }),
      el("span", { text: message }));
    host.append(node);
    setTimeout(() => { node.style.opacity = "0"; node.style.transform = "translateY(8px)"; node.style.transition = "opacity .2s, transform .2s"; setTimeout(() => node.remove(), 220); }, ms);
  }
  function modal({ title, body, actions = [] }) {
    const close = () => backdrop.remove();
    const backdrop = el("div", { class: "modal-backdrop", role: "dialog", "aria-modal": "true", "aria-label": title },
      el("div", { class: "modal" },
        el("div", { class: "card-head" }, el("h3", { text: title }), el("span", { class: "spacer" }), el("button", { class: "btn ghost sm", onclick: close, text: "Esc" })),
        body,
        actions.length ? el("div", { class: "row", style: "margin-top:20px;justify-content:flex-end" },
          ...actions.map((a) => el("button", { class: "btn " + (a.kind || ""), onclick: () => { const r = a.onClick && a.onClick(); if (r !== false) close(); }, text: a.label }))) : null));
    const onKey = (e) => { if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); } };
    document.addEventListener("keydown", onKey);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
    document.body.append(backdrop);
    return { close, node: backdrop };
  }
  function tabs(root, onChange) {
    const host = typeof root === "string" ? $(root) : root;
    const buttons = $$("[data-tab]", host);
    function activate(name) {
      buttons.forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
      $$("[data-tab-panel]", host).forEach((p) => { p.hidden = p.dataset.tabPanel !== name; });
      if (onChange) onChange(name);
    }
    buttons.forEach((b) => b.addEventListener("click", () => activate(b.dataset.tab)));
    const first = buttons.find((b) => b.classList.contains("active")) || buttons[0];
    if (first) activate(first.dataset.tab);
    return activate;
  }

  /* ---------- charts ------------------------------------------------------ */
  function path(points) {
    return points.map((p, i) => (i ? "L" : "M") + p[0].toFixed(2) + " " + p[1].toFixed(2)).join(" ");
  }
  function smoothPath(points) {
    if (points.length < 2) return "";
    let d = `M${points[0][0]} ${points[0][1]}`;
    for (let i = 1; i < points.length; i++) {
      const p0 = points[i - 1], p1 = points[i];
      const cx = (p0[0] + p1[0]) / 2;
      d += ` C${cx} ${p0[1]}, ${cx} ${p1[1]}, ${p1[0]} ${p1[1]}`;
    }
    return d;
  }
  /** Line/area chart → SVG element. series: [{name,data,color,area}] */
  function lineChart({ series, labels, height = 220, width = 720, yFormat = fmt.compact, pad = { t: 14, r: 12, b: 26, l: 44 } }) {
    const w = width, h = height;
    const innerW = w - pad.l - pad.r, innerH = h - pad.t - pad.b;
    const all = series.flatMap((s) => s.data);
    const max = Math.max(...all, 1) * 1.12, min = 0;
    const x = (i) => pad.l + (labels.length === 1 ? innerW / 2 : (i / (labels.length - 1)) * innerW);
    const y = (v) => pad.t + innerH - ((v - min) / (max - min)) * innerH;
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.setAttribute("class", "chart");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Trend chart");
    const defs = document.createElementNS(ns, "defs");
    defs.innerHTML = `<linearGradient id="goldFade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f5c26b" stop-opacity=".28"/><stop offset="1" stop-color="#f5c26b" stop-opacity="0"/>
    </linearGradient>`;
    svg.append(defs);
    // grid + y labels
    for (let i = 0; i <= 4; i++) {
      const v = (max / 4) * i, yy = y(v);
      const line = document.createElementNS(ns, "line");
      line.setAttribute("x1", pad.l); line.setAttribute("x2", w - pad.r);
      line.setAttribute("y1", yy); line.setAttribute("y2", yy);
      line.setAttribute("class", i === 0 ? "axis" : "gridline");
      svg.append(line);
      const t = document.createElementNS(ns, "text");
      t.setAttribute("x", pad.l - 10); t.setAttribute("y", yy + 3);
      t.setAttribute("text-anchor", "end"); t.setAttribute("class", "label");
      t.textContent = yFormat(v);
      svg.append(t);
    }
    // x labels (every nth)
    const step = Math.ceil(labels.length / 7);
    labels.forEach((label, i) => {
      if (i % step !== 0 && i !== labels.length - 1) return;
      const t = document.createElementNS(ns, "text");
      t.setAttribute("x", x(i)); t.setAttribute("y", h - 8);
      t.setAttribute("text-anchor", "middle"); t.setAttribute("class", "label");
      t.textContent = label;
      svg.append(t);
    });
    series.forEach((s, si) => {
      const pts = s.data.map((v, i) => [x(i), y(v)]);
      if (s.area !== false) {
        const area = document.createElementNS(ns, "path");
        area.setAttribute("d", smoothPath(pts) + ` L${x(s.data.length - 1)} ${y(0)} L${x(0)} ${y(0)} Z`);
        area.setAttribute("fill", si === 0 ? "url(#goldFade)" : s.color || "rgba(58,123,255,.14)");
        svg.append(area);
      }
      const line = document.createElementNS(ns, "path");
      line.setAttribute("d", smoothPath(pts));
      line.setAttribute("class", "series");
      if (s.color) line.style.stroke = s.color;
      if (si === 1) line.classList.add("blue");
      svg.append(line);
      const last = pts[pts.length - 1];
      const dot = document.createElementNS(ns, "circle");
      dot.setAttribute("cx", last[0]); dot.setAttribute("cy", last[1]); dot.setAttribute("r", 4);
      dot.setAttribute("class", "point");
      if (s.color) dot.style.fill = s.color;
      svg.append(dot);
    });
    return svg;
  }
  /** Donut chart → SVG. slices: [{label,value,color}] */
  function donut({ slices, size = 180, thickness = 22, centerLabel, centerValue }) {
    const ns = "http://www.w3.org/2000/svg";
    const r = (size - thickness) / 2, c = size / 2;
    const total = slices.reduce((a, s) => a + s.value, 0) || 1;
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
    svg.setAttribute("width", size); svg.setAttribute("height", size);
    svg.setAttribute("role", "img"); svg.setAttribute("aria-label", "Distribution chart");
    let angle = -Math.PI / 2;
    slices.forEach((s) => {
      const frac = s.value / total;
      const end = angle + frac * Math.PI * 2;
      const large = frac > 0.5 ? 1 : 0;
      const x1 = c + r * Math.cos(angle), y1 = c + r * Math.sin(angle);
      const x2 = c + r * Math.cos(end), y2 = c + r * Math.sin(end);
      const p = document.createElementNS(ns, "path");
      p.setAttribute("d", `M${x1} ${y1} A${r} ${r} 0 ${large} 1 ${x2} ${y2}`);
      p.setAttribute("fill", "none");
      p.setAttribute("stroke", s.color); p.setAttribute("stroke-width", thickness);
      p.setAttribute("stroke-linecap", "round");
      svg.append(p);
      angle = end;
    });
    if (centerValue) {
      const t = document.createElementNS(ns, "text");
      t.setAttribute("x", c); t.setAttribute("y", c + 2); t.setAttribute("text-anchor", "middle");
      t.setAttribute("fill", "#fff"); t.setAttribute("font-size", 26); t.setAttribute("font-family", "Poppins,sans-serif");
      t.setAttribute("font-weight", 600);
      t.textContent = centerValue; svg.append(t);
    }
    if (centerLabel) {
      const t = document.createElementNS(ns, "text");
      t.setAttribute("x", c); t.setAttribute("y", c + 20); t.setAttribute("text-anchor", "middle");
      t.setAttribute("fill", "#8d98ab"); t.setAttribute("font-size", 10.5); t.setAttribute("font-family", "Inter,sans-serif");
      t.textContent = centerLabel; svg.append(t);
    }
    return svg;
  }
  function sparkline(data, { width = 120, height = 34, color = "#f5c26b" } = {}) {
    const ns = "http://www.w3.org/2000/svg";
    const max = Math.max(...data), min = Math.min(...data);
    const span = max - min || 1;
    const pts = data.map((v, i) => [(i / (data.length - 1 || 1)) * width, height - ((v - min) / span) * (height - 4) - 2]);
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", width); svg.setAttribute("height", height);
    const p = document.createElementNS(ns, "path");
    p.setAttribute("d", smoothPath(pts)); p.setAttribute("fill", "none");
    p.setAttribute("stroke", color); p.setAttribute("stroke-width", 1.8);
    p.setAttribute("stroke-linecap", "round");
    svg.append(p);
    return svg;
  }
  /** Horizontal bar list → element. rows: [{label,value,color}] */
  function barList({ rows, format = fmt.num, max }) {
    const top = max || Math.max(...rows.map((r) => r.value), 1);
    const host = el("div", { class: "col", style: "gap:10px" });
    rows.forEach((r) => {
      host.append(el("div", {},
        el("div", { class: "row", style: "margin-bottom:5px;font-size:12.5px" },
          el("span", { text: r.label }), el("span", { class: "spacer" }),
          el("span", { class: "mono muted", text: format(r.value) })),
        el("div", { class: "progress" }, el("i", { style: `width:${(r.value / top) * 100}%;${r.color ? "background:" + r.color : ""}` }))));
    });
    return host;
  }

  /* ---------- data-table helper ------------------------------------------ */
  /** columns: [{key,label,render?,align?,width?}] */
  function dataTable({ columns, rows, empty = "No records yet.", onRowClick }) {
    const wrap = el("div", { class: "table-wrap" });
    const table = el("table", { class: "table" });
    table.append(el("thead", {}, el("tr", {}, ...columns.map((c) => el("th", { text: c.label, style: c.width ? `width:${c.width}` : null })))));
    const tbody = el("tbody");
    if (!rows.length) {
      tbody.append(el("tr", {}, el("td", { colspan: columns.length, class: "muted", style: "padding:34px;text-align:center", text: empty })));
    }
    rows.forEach((row) => {
      tbody.append(el("tr", {
        style: onRowClick ? "cursor:pointer" : null,
        onclick: onRowClick ? () => onRowClick(row) : null,
      }, ...columns.map((c) => {
        const td = el("td", { class: c.align === "right" ? "num" : c.align === "center" ? "center" : null });
        const v = c.render ? c.render(row) : row[c.key];
        if (v && v.nodeType) td.append(v); else if (v !== undefined && v !== null) td.textContent = v;
        return td;
      })));
    });
    table.append(tbody);
    wrap.append(table);
    return wrap;
  }

  /* ---------- files ------------------------------------------------------- */
  function download(filename, content, type = "text/plain") {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = el("a", { href: url, download: filename });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function toCSV(rows, columns) {
    const cols = columns || Object.keys(rows[0] || {});
    const esc = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
  }

  /* ---------- misc -------------------------------------------------------- */
  function debounce(fn, ms = 220) {
    let t; return function (...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), ms); };
  }
  const uid = (prefix = "id") => prefix + "-" + Math.random().toString(36).slice(2, 9);
  function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }
  function sum(arr, fn = (x) => x) { return arr.reduce((a, x) => a + fn(x), 0); }
  function groupBy(arr, fn) {
    return arr.reduce((acc, item) => { const k = fn(item); (acc[k] ||= []).push(item); return acc; }, {});
  }
  function timeAgoClock(node) {
    const tick = () => { node.textContent = new Date().toLocaleTimeString("en-US", { hour12: false }); };
    tick(); const id = setInterval(tick, 1000); return () => clearInterval(id);
  }
  if (typeof location !== "undefined" && /[?&]shot=1(?:&|$)/.test(location.search)) {
    document.documentElement.classList.add("shot");
  }
  function markActiveNav() {
    const here = location.pathname.split("/").pop() || "index.html";
    $$(".nav-item").forEach((a) => { if ((a.getAttribute("href") || "").endsWith(here)) a.classList.add("active"); });
  }

  global.A = {
    el, $, $$, mount, fmt, rng, pick, between, int, normal, store, toast, modal, tabs,
    lineChart, donut, sparkline, barList, dataTable, download, toCSV, debounce, uid,
    clamp, sum, groupBy, path, smoothPath, timeAgoClock, markActiveNav,
  };
})(window);
