/* Mis Gastos · Maikol — cascarón público.
   Datos privados en content-hub-data/gastos.json, token compartido 'hub.token' (mismo origen). */

const GH = { owner: "soymaikoldev", repo: "content-hub-data", path: "gastos.json" };
const API = `https://api.github.com/repos/${GH.owner}/${GH.repo}/contents/${GH.path}`;
const RATE_API = "https://ve.dolarapi.com/v1/dolares/paralelo"; // tasa paralela, CORS abierto
const ls = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  del: k => { try { localStorage.removeItem(k); } catch {} }
};
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
const money = n => "$" + (Math.round(n * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

let token = ls.get("hub.token");
let data = null, sha = null, saveTimer = null, saving = false, dirty = false;
let curSel = ls.get("gastos.lastCur") || "Bs";
let catSel = ls.get("gastos.lastCat") || null;
let lastDel = null;
let qManage = false;   // modo gestionar rápidos
let histMonth = null;  // mes abierto en el historial
let amtStr = "0";      // monto que se arma con el teclado propio

/* ---------- teclado / monto ---------- */
const fmtInt = s => (s || "0").replace(/\B(?=(\d{3})+(?!\d))/g, ".");
function amtDispHtml() {
  const [i, dec] = amtStr.split(".");
  const num = dec !== undefined ? `${fmtInt(i)}<span class="dec">,${dec}</span>` : fmtInt(i);
  return curSel === "USD" ? `<span class="cm">$</span>${num}` : `${num}<span class="cm"> Bs</span>`;
}
function convHint() {
  const a = parseFloat(amtStr) || 0;
  if (a <= 0 || !data) return "";
  if (curSel === "Bs") return "≈ " + money(a / (data.rate || 1));
  return "≈ " + Math.round(a * (data.rate || 1)).toLocaleString("es-VE") + " Bs";
}
function updateAmtUI() {
  const d = $("#amtDisp"); if (d) d.innerHTML = amtDispHtml();
  const h = $("#amt-conv"); if (h) h.textContent = convHint();
}
function press(k) {
  if (k === "⌫") amtStr = amtStr.length > 1 ? amtStr.slice(0, -1) : "0";
  else if (k === ".") { if (!amtStr.includes(".")) amtStr = amtStr === "0" ? "0." : amtStr + "."; }
  else {
    if (amtStr === "0") amtStr = k;
    else {
      const dec = amtStr.split(".")[1];
      if (dec && dec.length >= 2) return;
      if (amtStr.replace(".", "").length >= 10) return;
      amtStr += k;
    }
  }
  updateAmtUI();
}
function resetAmt() { amtStr = "0"; }

const b64e = s => { const b = new TextEncoder().encode(s); let r = ""; for (let i = 0; i < b.length; i += 0x8000) r += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(r); };
const b64d = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, "")), c => c.charCodeAt(0)));

/* ---------- fechas ---------- */
const ymd = dt => dt.getFullYear() + "-" + String(dt.getMonth() + 1).padStart(2, "0") + "-" + String(dt.getDate()).padStart(2, "0");
const TODAY = ymd(new Date());
const WEEK0 = ymd(new Date(Date.now() - 6 * 864e5));
const MONTH = TODAY.slice(0, 7);
const addMonth = (ym, n) => { const d = new Date(ym + "-01T00:00:00"); d.setMonth(d.getMonth() + n); return ymd(d).slice(0, 7); };
const PREV_MONTH = addMonth(MONTH, -1);
const monName = ym => { const s = new Date(ym + "-01T00:00:00").toLocaleDateString("es-VE", { month: "long", year: "numeric" }); return s.charAt(0).toUpperCase() + s.slice(1); };
const dayName = d => { const s = new Date(d + "T00:00:00").toLocaleDateString("es-VE", { weekday: "short", day: "numeric", month: "short" }); return s.charAt(0).toUpperCase() + s.slice(1); };

/* ---------- GitHub ---------- */
async function gh(method, body) {
  const res = await fetch(API + (method === "GET" ? `?t=${Date.now()}` : ""), {
    method, cache: "no-store",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 401 || res.status === 403) { askToken("El token no es válido o no tiene permiso sobre " + GH.repo + "."); throw new Error("auth"); }
  return res;
}
async function pull() {
  const res = await gh("GET");
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("HTTP " + res.status);
  const j = await res.json(); sha = j.sha;
  return JSON.parse(b64d(j.content));
}
async function push() {
  if (!token || !data) return;
  if (saving) { dirty = true; return; }
  saving = true; dirty = false; syncDot("busy", "Guardando…");
  try {
    for (let i = 0; i < 3; i++) {
      const res = await gh("PUT", { message: "gastos: actualización", content: b64e(JSON.stringify(data, null, 1)), ...(sha ? { sha } : {}) });
      if (res.ok) { sha = (await res.json()).content.sha; syncDot("ok", "Guardado " + hora()); break; }
      if (res.status === 409 || res.status === 422) { await pull(); continue; }
      throw new Error("HTTP " + res.status);
    }
  } catch (e) { if (e.message !== "auth") syncDot("err", "Sin conexión; se guarda al volver la red."); dirty = true; }
  saving = false;
  if (dirty && navigator.onLine !== false) { clearTimeout(saveTimer); saveTimer = setTimeout(push, 4000); }
}
function save() { ls.set("gastos.cache", JSON.stringify(data)); if (!token) return; syncDot("busy", "…"); clearTimeout(saveTimer); saveTimer = setTimeout(push, 800); }
const hora = () => new Date().toLocaleTimeString("es-VE", { hour: "2-digit", minute: "2-digit" });

/* ---------- tasa automática (paralelo) ---------- */
async function fetchRate() {
  const res = await fetch(RATE_API, { cache: "no-store" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const j = await res.json();
  const v = Math.round(Number(j.promedio));
  if (!v || v <= 0) throw new Error("rate");
  return v;
}
// force=true: refresca aunque ya se haya consultado hoy (botón ↻)
async function autoRate(force) {
  if (!data) return;
  if (!force && data.rateFetched === TODAY) return;   // una vez al día
  if (!force && data.rateSrc === "manual" && data.rateFetched === TODAY) return;
  const el = $("#rate-note"); if (el) el.textContent = "actualizando…";
  try {
    const v = await fetchRate();
    data.rate = v; data.rateFetched = TODAY; data.rateSrc = "auto";
    save(); render();
  } catch { if (el) el.textContent = "auto no disponible"; }
}

/* ---------- carga ---------- */
async function load() {
  if (!token) { showGate("Privado y solo tuyo. Conéctate con tu token para empezar."); return; }
  gateSync("Conectando…");
  try {
    const r = await pull();
    if (!r) { try { data = JSON.parse(ls.get("gastos.cache")); } catch {} if (!data) { showGate("Aún no hay datos. Pídele a Claude que los cree."); return; } }
    else { data = r; ls.set("gastos.cache", JSON.stringify(data)); }
    normalize(); render(); autoRate();
  } catch (e) {
    if (e.message === "auth") return;
    try { data = JSON.parse(ls.get("gastos.cache")); } catch {}
    if (data) { normalize(); render(); syncDot("err", "Sin conexión: última copia."); }
    else showGate("Sin conexión. Intenta de nuevo.");
  }
}
function normalize() {
  if (!data.cats || !data.cats.length) data.cats = [{ id: "otros", label: "Otros", emoji: "✨" }];
  if (!Array.isArray(data.expenses)) data.expenses = [];
  if (!Array.isArray(data.quick)) data.quick = [];
  if (!data.rate) data.rate = 1167;
  if (typeof data.budget !== "number") data.budget = 0;
  if (catSel && !data.cats.some(c => c.id === catSel)) catSel = null;
}

/* ---------- helpers de cálculo ---------- */
// usa la tasa guardada al momento del gasto (e.r) para que el histórico no se distorsione al mover la tasa
const usd = e => e.cur === "USD" ? e.amt : e.amt / (e.r || data.rate || 1);
const catOf = id => data.cats.find(c => c.id === id) || { id, label: id, emoji: "•" };
function sumRange(test) { return data.expenses.filter(e => test(e.d)).reduce((a, e) => a + usd(e), 0); }
function breakdown(ym) {
  const by = {};
  data.expenses.filter(e => e.d.slice(0, 7) === ym).forEach(e => { (by[e.cat] = by[e.cat] || { t: 0, n: 0 }), by[e.cat].t += usd(e), by[e.cat].n++; });
  return Object.entries(by).map(([id, v]) => ({ id, ...v })).sort((a, b) => b.t - a.t);
}

/* ---------- render ---------- */
function syncDot(kind, text) { const el = $("#syncnote"); if (el) el.innerHTML = `<span class="dot ${kind}"></span>${esc(text)}`; }
function gateSync(t) { const el = $("#gate-sync"); if (el) el.textContent = t; }
function showGate(msg) { $("#gate").hidden = false; $("#app").hidden = true; $("#gate-msg").textContent = msg; gateSync(""); }

function render() {
  if (!data) return;
  const hoy = sumRange(d => d === TODAY);
  const sem = sumRange(d => d >= WEEK0);
  const mes = sumRange(d => d.slice(0, 7) === MONTH);
  const mesPrev = sumRange(d => d.slice(0, 7) === PREV_MONTH);

  // semana partida en dos monedas (lo distintivo: tu vida en Bs y en $)
  const last7 = data.expenses.filter(e => e.d >= WEEK0);
  const semBs = last7.filter(e => e.cur === "Bs").reduce((a, e) => a + usd(e), 0);
  const semUsd = last7.filter(e => e.cur === "USD").reduce((a, e) => a + usd(e), 0);
  const bsPct = sem > 0 ? semBs / sem * 100 : 0;

  const rows = breakdown(MONTH);
  const max = rows.length ? rows[0].t : 1;

  // mes vs mes pasado
  let cmp = null;
  if (mesPrev > 0) {
    const diff = (mes - mesPrev) / mesPrev * 100;
    const r = Math.round(Math.abs(diff));
    const mn = monName(PREV_MONTH).split(" ")[0].toLowerCase();
    if (r < 2) cmp = { cls: "", txt: `casi igual que ${mn}` };
    else if (diff < 0) cmp = { cls: "down", txt: `${r}% menos que ${mn}` };
    else cmp = { cls: "up", txt: `${r}% más que ${mn}` };
  }

  // presupuesto
  const budget = data.budget || 0;
  let budHtml = "";
  if (budget > 0) {
    const pct = mes / budget * 100;
    const rest = budget - mes;
    const cls = pct >= 100 ? "over" : pct >= 75 ? "warn" : "";
    const restTxt = rest >= 0 ? `${money(rest)} te queda` : `${money(-rest)} de más`;
    budHtml = `<div class="budget ${cls}">
      <div class="b-top"><span>Tu techo del mes</span><b>${restTxt}</b></div>
      <div class="b-bar"><i style="width:${Math.min(100, pct)}%"></i></div>
      <div class="b-foot"><span>Llevas ${money(mes)} de <input class="mini-in" id="budget" inputmode="numeric" value="${budget}"></span><span>${Math.round(pct)}%</span></div>
    </div>`;
  } else {
    budHtml = `<div class="budget none"><div class="b-foot"><span>Ponle un techo al mes y ve cuánto te queda</span><span>$<input class="mini-in" id="budget" inputmode="numeric" value="" placeholder="200"></span></div></div>`;
  }

  // gasto hormiga — el antagonista
  let fuga = "";
  if (rows.length) {
    const horm = [...rows].filter(r => r.n >= 3 && r.t / r.n <= 5).sort((a, b) => b.n - a.n)[0];
    if (horm) { const c = catOf(horm.id); fuga = `🐜 <b>Gasto hormiga en ${c.emoji} ${esc(c.label)}.</b> ${horm.n} compras chiquitas suman <b>${money(horm.t)}</b> este mes. Esa plata se te escurre sin que la sientas.`; }
    else { const c = catOf(rows[0].id); fuga = `Por donde más se te va: ${c.emoji} <b>${esc(c.label)}</b>, ${money(rows[0].t)} este mes.`; }
  }

  // rápidos
  const quickHtml = data.quick.length ? `<div class="quicks">
    ${data.quick.map(q => {
      const c = catOf(q.cat);
      const amt = q.cur === "USD" ? money(q.amt) : q.amt.toLocaleString("es-VE") + " Bs";
      const lab = q.note || c.label;
      return `<span class="q" data-q="${esc(q.id)}">${c.emoji} ${esc(lab)} ${amt}${qManage ? `<b class="qx" data-qx="${esc(q.id)}">✕</b>` : ""}</span>`;
    }).join("")}
    <button class="q-edit" id="q-edit" type="button" title="${qManage ? "Listo" : "Editar rápidos"}">${qManage ? "✓" : "✎"}</button>
  </div>` : "";

  const catChips = data.cats.map(c => `<span class="cat ${catSel === c.id ? "on" : ""}" data-cat="${esc(c.id)}">${c.emoji} ${esc(c.label)}</span>`).join("");
  const keysHtml = ["7", "8", "9", "4", "5", "6", "1", "2", "3", ".", "0", "⌫"].map(k => `<button class="key${k === "⌫" ? " back" : ""}" data-k="${k}" type="button">${k}</button>`).join("");

  const breakHtml = rows.length ? rows.map(r => {
    const c = catOf(r.id);
    return `<div class="lrow"><div class="lab">${c.emoji} ${esc(c.label)} <span class="cnt">${r.n} ${r.n === 1 ? "vez" : "veces"}</span></div>
      <div class="val">${money(r.t)}</div><div class="bar"><i style="width:${Math.max(4, r.t / max * 100)}%"></i></div></div>`;
  }).join("") : `<div class="empty">Nada este mes todavía. Marca tu primer gasto arriba.</div>`;

  const todays = data.expenses.filter(e => e.d === TODAY);
  const listHtml = todays.length ? todays.map(e => itemHtml(e)).join("") : `<div class="empty">Hoy no has gastado nada. Bien ahí.</div>`;

  const splitHtml = sem > 0 ? `
    <div class="split"><i class="bs" style="width:${bsPct}%"></i><i class="usd" style="width:${100 - bsPct}%"></i></div>
    <div class="split-legend"><span class="leg bs">bolívares <b>${money(semBs)}</b></span><span class="leg usd">dólares <b>${money(semUsd)}</b></span></div>` : "";

  $("#app").innerHTML = `
  <div class="wrap">
    <div class="top">
      <div class="brandmark">mis <em>gastos</em></div>
      <div class="top-actions"><span class="sync-note" id="syncnote"><span class="dot"></span></span>
        <button class="chip-btn" id="tt" type="button" aria-label="Cambiar tema">☀</button></div>
    </div>

    <section class="register">
      <div class="reg-mini"><span>hoy <b>${money(hoy)}</b></span><span>esta semana <b>${money(sem)}</b></span></div>
      ${quickHtml}
      <div class="reg-head">
        <div class="cur-row">
          <button type="button" data-cur="Bs" class="${curSel === "Bs" ? "on" : ""}">Bs</button>
          <button type="button" data-cur="USD" class="${curSel === "USD" ? "on" : ""}">$</button>
        </div>
      </div>
      <div class="amt-big" id="amtDisp">${amtDispHtml()}</div>
      <div class="amt-conv" id="amt-conv">${convHint()}</div>
      <div class="cats scroll" id="cats">${catChips}</div>
      <input class="note-in" id="note" placeholder="¿En qué fue? (opcional)">
      <div class="keypad">${keysHtml}</div>
      <div class="cap-actions">
        <button class="btn-primary" id="add" type="button">Anotar gasto</button>
        <button class="btn-ghost star" id="save-quick" type="button" title="Guardar esto como gasto rápido" aria-label="Guardar como rápido">★</button>
      </div>
      <div class="add-hint" id="hint">Marca el monto, elige categoría y anota</div>
    </section>

    <section class="week">
      <div class="block-h"><h2>Tu semana</h2></div>
      <div class="week-num">${money(sem)}</div>
      ${splitHtml}
      <div class="week-sub"><span>hoy ${money(hoy)}</span><span>este mes ${money(mes)}${cmp ? ` <b class="cmp ${cmp.cls}">${cmp.txt}</b>` : ""}</span></div>
    </section>

    ${budHtml}

    <section class="block">
      <div class="block-h"><h2>En qué se va tu plata</h2>
        <button class="link-btn" id="resumen" type="button">Copiar resumen</button></div>
      <div class="ledger">${breakHtml}</div>
      ${fuga ? `<div class="leak-note">${fuga}</div>` : ""}
    </section>

    <section class="block">
      <div class="block-h"><h2>Lo de hoy</h2>
        <button class="link-btn" id="ver-hist" type="button">Ver historial</button></div>
      <div class="list">${listHtml}</div>
    </section>

    <div class="foot">
      <div class="rate-wrap">Tasa <input class="rate-in" id="rate" inputmode="numeric" value="${data.rate}"> Bs/$
        <button class="rate-refresh" id="rate-refresh" type="button" title="Actualizar tasa paralela">↻</button>
        <span class="rate-note" id="rate-note">${data.rateSrc === "auto" ? (data.rateFetched === TODAY ? "de hoy" : esc(data.rateFetched || "")) : "manual"}</span>
      </div>
      <a href="#" id="logout">Desconectar</a>
    </div>
  </div>

  <dialog id="hist" class="hist">
    <div class="hist-head">
      <button class="nav" id="h-prev" type="button" aria-label="Mes anterior">‹</button>
      <h2 id="h-title">Historial</h2>
      <button class="nav" id="h-next" type="button" aria-label="Mes siguiente">›</button>
    </div>
    <div class="hist-sum" id="h-sum"></div>
    <div class="hist-body" id="h-body"></div>
    <button class="btn-ghost" id="h-close" type="button" style="margin-top:16px;width:100%">Cerrar</button>
  </dialog>

  <div class="toast" id="toast"></div>`;

  $("#gate").hidden = true; $("#app").hidden = false;
  wire();
  syncDot(token ? "ok" : "", token ? "Guardado " + hora() : "");
}

function itemHtml(e, showDay) {
  const c = catOf(e.cat);
  const curCls = e.cur === "USD" ? "usd" : "bs";
  const orig = e.cur === "USD" ? money(e.amt) : e.amt.toLocaleString("es-VE") + " Bs";
  const sub = e.cur === "USD" ? "" : "≈ " + money(usd(e));
  return `<div class="row"><span class="row-ic">${c.emoji}</span>
    <div class="row-mid"><div class="row-c">${esc(c.label)}${showDay ? `<span class="row-day">${dayName(e.d)}</span>` : ""}</div>${e.note ? `<div class="row-n">${esc(e.note)}</div>` : ""}</div>
    <div class="row-amt ${curCls}">${orig}${sub ? `<span>${sub}</span>` : ""}</div>
    <button class="row-del" data-del="${esc(e.id)}" title="Borrar">✕</button></div>`;
}

/* ---------- interacción ---------- */
function wire() {
  const btn = $("#tt");
  const cur = () => { const a = document.documentElement.getAttribute("data-theme"); return a || (matchMedia("(prefers-color-scheme:dark)").matches ? "dark" : "light"); };
  const label = () => btn.textContent = cur() === "dark" ? "☾" : "☀";
  label();
  btn.onclick = () => { const n = cur() === "dark" ? "light" : "dark"; document.documentElement.setAttribute("data-theme", n); ls.set("gastos.theme", n); label(); };

  document.querySelectorAll("[data-cur]").forEach(b => b.onclick = () => { curSel = b.getAttribute("data-cur"); ls.set("gastos.lastCur", curSel); document.querySelectorAll("[data-cur]").forEach(x => x.classList.toggle("on", x === b)); updateAmtUI(); });
  document.querySelectorAll("[data-cat]").forEach(ch => ch.onclick = () => { catSel = ch.getAttribute("data-cat"); ls.set("gastos.lastCat", catSel); document.querySelectorAll("[data-cat]").forEach(x => x.classList.toggle("on", x === ch)); });
  document.querySelectorAll("[data-k]").forEach(b => b.onclick = () => press(b.getAttribute("data-k")));

  $("#add").onclick = add;
  document.querySelectorAll("[data-del]").forEach(b => b.onclick = () => del(b.getAttribute("data-del")));

  // rápidos
  document.querySelectorAll("[data-q]").forEach(el => el.onclick = ev => { if (ev.target.classList.contains("qx")) return; quickAdd(el.getAttribute("data-q")); });
  document.querySelectorAll("[data-qx]").forEach(el => el.onclick = () => quickDel(el.getAttribute("data-qx")));
  if ($("#q-edit")) $("#q-edit").onclick = () => { qManage = !qManage; render(); };
  $("#save-quick").onclick = saveQuick;

  $("#resumen").onclick = copyResumen;
  $("#ver-hist").onclick = () => openHist(MONTH);

  // presupuesto
  if ($("#budget")) $("#budget").addEventListener("change", e => { const v = parseInt(String(e.target.value).replace(/[^\d]/g, ""), 10); data.budget = v > 0 ? v : 0; save(); render(); });

  $("#rate").addEventListener("change", e => { const v = parseInt(String(e.target.value).replace(/[^\d]/g, ""), 10); if (v > 0) { data.rate = v; data.rateSrc = "manual"; data.rateFetched = TODAY; save(); render(); } });
  const rr = $("#rate-refresh"); if (rr) rr.onclick = () => autoRate(true);
  $("#logout").onclick = e => { e.preventDefault(); if (!confirm("¿Quitar el token de este dispositivo? Tus gastos quedan a salvo en el repo privado.")) return; ls.del("hub.token"); token = null; data = null; showGate("Desconectado. Conéctate de nuevo cuando quieras."); };
}

function readCapture() { return { amt: parseFloat(amtStr) || 0, note: ($("#note") ? $("#note").value : "").trim() }; }

function add() {
  const { amt, note } = readCapture();
  const hint = $("#hint");
  if (!amt || amt <= 0) { hint.textContent = "Marca un monto en el teclado"; hint.style.color = "var(--leak)"; return; }
  if (!catSel) { hint.textContent = "Elige una categoría"; hint.style.color = "var(--leak)"; return; }
  const e = { id: uid(), d: TODAY, amt: Math.round(amt * 100) / 100, cur: curSel, cat: catSel, note };
  if (curSel === "Bs") e.r = data.rate; // congela la tasa del momento
  data.expenses.unshift(e);
  resetAmt();
  save(); render();
  toast("Anotado ✓");
}

function quickAdd(id) {
  const q = data.quick.find(x => x.id === id); if (!q) return;
  const e = { id: uid(), d: TODAY, amt: q.amt, cur: q.cur, cat: q.cat, note: q.note || "" };
  if (q.cur === "Bs") e.r = data.rate;
  data.expenses.unshift(e);
  save(); render();
  toast(`${catOf(q.cat).emoji} ${q.note || catOf(q.cat).label} anotado ✓`, "Deshacer", () => { const i = data.expenses.findIndex(x => x.id === e.id); if (i >= 0) { data.expenses.splice(i, 1); save(); render(); } });
}

function saveQuick() {
  const { amt, note } = readCapture();
  const hint = $("#hint");
  if (!amt || amt <= 0 || !catSel) { hint.textContent = "Para un rápido: marca monto y categoría"; hint.style.color = "var(--leak)"; return; }
  if (data.quick.length >= 8) { hint.textContent = "Ya tienes 8 rápidos (el máximo)"; hint.style.color = "var(--leak)"; return; }
  data.quick.push({ id: uid(), amt: Math.round(amt * 100) / 100, cur: curSel, cat: catSel, note });
  save(); render();
  toast("Rápido guardado ★");
}
function quickDel(id) {
  const i = data.quick.findIndex(x => x.id === id);
  if (i < 0) return;
  data.quick.splice(i, 1); save();
  if (!data.quick.length) qManage = false;
  render();
}

function del(id) {
  const i = data.expenses.findIndex(e => e.id === id);
  if (i < 0) return;
  lastDel = { e: data.expenses[i], i };
  data.expenses.splice(i, 1); save();
  if (histMonth && $("#hist") && $("#hist").open) renderHist(); else render();
  toast("Gasto borrado", "Deshacer", () => { if (lastDel) { data.expenses.splice(lastDel.i, 0, lastDel.e); lastDel = null; save(); if (histMonth && $("#hist") && $("#hist").open) renderHist(); else render(); } });
}

/* ---------- resumen del mes (copiar) ---------- */
function monthSummaryText(ym) {
  const es = data.expenses.filter(e => e.d.slice(0, 7) === ym);
  const total = es.reduce((a, e) => a + usd(e), 0);
  const rows = breakdown(ym);
  let s = `📊 Gastos de ${monName(ym)}\nTotal: ${money(total)} · ${es.length} ${es.length === 1 ? "gasto" : "gastos"}`;
  rows.forEach(r => { const c = catOf(r.id); s += `\n• ${c.label}: ${money(r.t)} (${r.n})`; });
  s += `\n(para la Torre de Control)`;
  return s;
}
async function copyResumen() {
  const txt = monthSummaryText(MONTH);
  try { await navigator.clipboard.writeText(txt); toast("Resumen copiado ✓"); }
  catch { toast("Copia manual 👇", null); alertFallback(txt); }
}
function alertFallback(txt) {
  const el = $("#toast"); if (!el) return;
  el.innerHTML = `<span style="white-space:pre-line;text-align:left">${esc(txt)}</span>`;
  el.classList.add("show"); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove("show"), 8000);
}

/* ---------- historial ---------- */
function openHist(ym) { histMonth = ym; renderHist(); const d = $("#hist"); if (d && !d.open) d.showModal(); }
function renderHist() {
  const ym = histMonth;
  $("#h-title").textContent = monName(ym);
  const es = data.expenses.filter(e => e.d.slice(0, 7) === ym).sort((a, b) => b.d < a.d ? -1 : b.d > a.d ? 1 : 0);
  const total = es.reduce((a, e) => a + usd(e), 0);
  const rows = breakdown(ym);
  $("#h-sum").innerHTML = `<div class="h-total">${money(total)} <span>· ${es.length} ${es.length === 1 ? "gasto" : "gastos"}</span></div>
    ${rows.length ? `<div class="h-cats">${rows.slice(0, 4).map(r => { const c = catOf(r.id); return `<span>${c.emoji} ${money(r.t)}</span>`; }).join("")}</div>` : ""}`;
  // agrupar por día
  const byDay = {};
  es.forEach(e => (byDay[e.d] = byDay[e.d] || []).push(e));
  const days = Object.keys(byDay).sort((a, b) => b < a ? -1 : 1);
  $("#h-body").innerHTML = days.length ? days.map(d => {
    const dt = byDay[d].reduce((a, e) => a + usd(e), 0);
    return `<div class="h-day"><div class="h-day-h"><span>${dayName(d)}</span><b>${money(dt)}</b></div>
      ${byDay[d].map(e => itemHtml(e)).join("")}</div>`;
  }).join("") : `<div class="empty">Sin gastos en ${monName(ym)}.</div>`;
  document.querySelectorAll("#h-body [data-del]").forEach(b => b.onclick = () => del(b.getAttribute("data-del")));
  $("#h-prev").onclick = () => { histMonth = addMonth(histMonth, -1); renderHist(); };
  $("#h-next").onclick = () => { if (histMonth < MONTH) { histMonth = addMonth(histMonth, 1); renderHist(); } };
  $("#h-next").disabled = histMonth >= MONTH;
  $("#h-close").onclick = () => $("#hist").close();
}

function toast(t, label, fn) {
  const el = $("#toast"); if (!el) return;
  el.innerHTML = `<span>${esc(t)}</span>${label ? `<button type="button">${esc(label)}</button>` : ""}`;
  if (label) el.querySelector("button").onclick = () => { el.classList.remove("show"); fn(); };
  el.classList.add("show"); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove("show"), label ? 5000 : 1500);
}

function askToken(msg = "") { $("#t-msg").textContent = msg; $("#t-input").value = ""; if (!$("#tok").open) $("#tok").showModal(); }

(function init() {
  try { const t = ls.get("gastos.theme"); if (t === "dark" || t === "light") document.documentElement.setAttribute("data-theme", t); } catch {}
  if ("serviceWorker" in navigator) { window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {})); }
  $("#gate-btn").onclick = () => askToken();
  $("#t-cancel").onclick = () => $("#tok").close();
  $("#tok-form").onsubmit = () => { const t = $("#t-input").value.trim(); if (!t) return; token = t; ls.set("hub.token", t); $("#tok").close(); load(); };
  load();
})();
