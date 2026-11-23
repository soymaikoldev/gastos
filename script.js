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

const b64e = s => { const b = new TextEncoder().encode(s); let r = ""; for (let i = 0; i < b.length; i += 0x8000) r += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(r); };
const b64d = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, "")), c => c.charCodeAt(0)));

/* ---------- fechas ---------- */
const ymd = dt => dt.getFullYear() + "-" + String(dt.getMonth() + 1).padStart(2, "0") + "-" + String(dt.getDate()).padStart(2, "0");
const TODAY = ymd(new Date());
const WEEK0 = ymd(new Date(Date.now() - 6 * 864e5));
const MONTH = TODAY.slice(0, 7);

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
  if (!data.rate) data.rate = 1167;
  if (catSel && !data.cats.some(c => c.id === catSel)) catSel = null;
}

/* ---------- helpers de cálculo ---------- */
const usd = e => e.cur === "USD" ? e.amt : e.amt / (data.rate || 1);
const catOf = id => data.cats.find(c => c.id === id) || { id, label: id, emoji: "•" };
function sumRange(test) { return data.expenses.filter(e => test(e.d)).reduce((a, e) => a + usd(e), 0); }

/* ---------- render ---------- */
function syncDot(kind, text) { const el = $("#syncnote"); if (el) el.innerHTML = `<span class="dot ${kind}"></span>${esc(text)}`; }
function gateSync(t) { const el = $("#gate-sync"); if (el) el.textContent = t; }
function showGate(msg) { $("#gate").hidden = false; $("#app").hidden = true; $("#gate-msg").textContent = msg; gateSync(""); }

function render() {
  if (!data) return;
  const hoy = sumRange(d => d === TODAY);
  const sem = sumRange(d => d >= WEEK0);
  const mes = sumRange(d => d.slice(0, 7) === MONTH);

  // desglose del mes por categoría
  const byCat = {};
  data.expenses.filter(e => e.d.slice(0, 7) === MONTH).forEach(e => {
    (byCat[e.cat] = byCat[e.cat] || { t: 0, n: 0 }), byCat[e.cat].t += usd(e), byCat[e.cat].n++;
  });
  const rows = Object.entries(byCat).map(([id, v]) => ({ id, ...v })).sort((a, b) => b.t - a.t);
  const max = rows.length ? rows[0].t : 1;

  // gasto hormiga: categoría con más transacciones y promedio chico
  let fuga = "";
  if (rows.length) {
    const horm = [...rows].filter(r => r.n >= 3 && r.t / r.n <= 5).sort((a, b) => b.n - a.n)[0];
    if (horm) { const c = catOf(horm.id); fuga = `🐜 <b>Gasto hormiga:</b> ${c.emoji} ${esc(c.label)} — ${horm.n} compras pequeñas suman <b>${money(horm.t)}</b> este mes. Ahí hay fuga.`; }
    else { const c = catOf(rows[0].id); fuga = `Tu mayor salida este mes: ${c.emoji} <b>${esc(c.label)}</b> con ${money(rows[0].t)}.`; }
  }

  const catChips = data.cats.map(c => `<span class="cat ${catSel === c.id ? "on" : ""}" data-cat="${esc(c.id)}">${c.emoji} ${esc(c.label)}</span>`).join("");

  const breakHtml = rows.length ? rows.map(r => {
    const c = catOf(r.id);
    return `<div class="brow"><div class="lab">${c.emoji} ${esc(c.label)} <span class="cnt">·${r.n}</span></div>
      <div class="val">${money(r.t)}</div><div class="bar"><i style="width:${Math.max(4, r.t / max * 100)}%"></i></div></div>`;
  }).join("") : `<div class="empty">Nada este mes todavía. Anota tu primer gasto arriba 👆</div>`;

  const todays = data.expenses.filter(e => e.d === TODAY);
  const listHtml = todays.length ? todays.map(e => {
    const c = catOf(e.cat);
    const orig = e.cur === "USD" ? money(e.amt) : e.amt.toLocaleString("es-VE") + " Bs";
    return `<div class="item"><span class="ic">${c.emoji}</span>
      <div class="mid"><div class="c">${esc(c.label)}</div>${e.note ? `<div class="n">${esc(e.note)}</div>` : ""}</div>
      <div class="amt2">${orig}<small>${e.cur === "USD" ? "" : "≈ " + money(usd(e))}</small></div>
      <button class="del" data-del="${esc(e.id)}" title="Borrar">✕</button></div>`;
  }).join("") : `<div class="empty">Sin gastos hoy. ¡Buena esa! 🎉</div>`;

  $("#app").innerHTML = `
  <div class="wrap">
    <div class="top">
      <div class="brandmark">mis<span>·</span>gastos</div>
      <div class="top-actions"><span class="sync-note" id="syncnote"><span class="dot"></span></span>
        <button class="chip-btn" id="tt" type="button">tema</button></div>
    </div>

    <div class="tiles">
      <div class="tile"><div class="k">Hoy</div><div class="v">${money(hoy)}</div></div>
      <div class="tile"><div class="k">7 días</div><div class="v">${money(sem)}</div></div>
      <div class="tile mes"><div class="k">Mes</div><div class="v">${money(mes)}</div></div>
    </div>

    <div class="capture">
      <div class="amount-row">
        <input class="amt" id="amt" inputmode="decimal" placeholder="0" aria-label="Monto">
        <div class="cur-toggle">
          <button type="button" data-cur="Bs" class="${curSel === "Bs" ? "on" : ""}">Bs</button>
          <button type="button" data-cur="USD" class="${curSel === "USD" ? "on" : ""}">$</button>
        </div>
      </div>
      <div class="cats" id="cats">${catChips}</div>
      <input class="note-in" id="note" placeholder="Nota (opcional): en qué fue">
      <button class="btn-primary" id="add" style="width:100%" type="button">Anotar gasto</button>
      <div class="add-hint" id="hint">Monto · moneda · categoría · listo</div>
    </div>

    <div class="sec">
      <div class="sec-h"><h2>En qué se va tu plata</h2><span class="small">este mes</span></div>
      <div class="break">${breakHtml}</div>
      ${fuga ? `<div class="fuga">${fuga}</div>` : ""}
    </div>

    <div class="sec">
      <div class="sec-h"><h2>Hoy</h2><span class="small">${todays.length} ${todays.length === 1 ? "gasto" : "gastos"}</span></div>
      <div class="list">${listHtml}</div>
    </div>

    <div class="foot">
      <div class="rate-wrap">Tasa: <input class="rate-in" id="rate" inputmode="numeric" value="${data.rate}"> Bs = $1
        <button class="rate-refresh" id="rate-refresh" type="button" title="Actualizar tasa paralela">↻</button>
        <span class="rate-note" id="rate-note">${data.rateSrc === "auto" ? "auto · " + (data.rateFetched === TODAY ? "hoy" : esc(data.rateFetched || "")) : "manual"}</span>
      </div>
      <a href="#" id="logout">Desconectar</a>
    </div>
  </div>
  <div class="toast" id="toast"></div>`;

  $("#gate").hidden = true; $("#app").hidden = false;
  wire();
  syncDot(token ? "ok" : "", token ? "Guardado " + hora() : "");
}

/* ---------- interacción ---------- */
function wire() {
  const btn = $("#tt");
  const cur = () => { const a = document.documentElement.getAttribute("data-theme"); return a || (matchMedia("(prefers-color-scheme:dark)").matches ? "dark" : "light"); };
  const label = () => btn.textContent = cur() === "dark" ? "☾" : "☀";
  label();
  btn.onclick = () => { const n = cur() === "dark" ? "light" : "dark"; document.documentElement.setAttribute("data-theme", n); ls.set("gastos.theme", n); label(); };

  document.querySelectorAll("[data-cur]").forEach(b => b.onclick = () => { curSel = b.getAttribute("data-cur"); ls.set("gastos.lastCur", curSel); document.querySelectorAll("[data-cur]").forEach(x => x.classList.toggle("on", x === b)); });
  document.querySelectorAll("[data-cat]").forEach(ch => ch.onclick = () => { catSel = ch.getAttribute("data-cat"); ls.set("gastos.lastCat", catSel); document.querySelectorAll("[data-cat]").forEach(x => x.classList.toggle("on", x === ch)); });

  $("#add").onclick = add;
  $("#amt").addEventListener("keydown", e => { if (e.key === "Enter") add(); });
  document.querySelectorAll("[data-del]").forEach(b => b.onclick = () => del(b.getAttribute("data-del")));

  $("#rate").addEventListener("change", e => { const v = parseInt(String(e.target.value).replace(/[^\d]/g, ""), 10); if (v > 0) { data.rate = v; data.rateSrc = "manual"; data.rateFetched = TODAY; save(); render(); } });
  const rr = $("#rate-refresh"); if (rr) rr.onclick = () => autoRate(true);
  $("#logout").onclick = e => { e.preventDefault(); if (!confirm("¿Quitar el token de este dispositivo? Tus gastos quedan a salvo en el repo privado.")) return; ls.del("hub.token"); token = null; data = null; showGate("Desconectado. Conéctate de nuevo cuando quieras."); };
}

function add() {
  const raw = ($("#amt").value || "").replace(/\./g, "").replace(",", ".").replace(/[^\d.]/g, "");
  const amt = parseFloat(raw);
  const hint = $("#hint");
  if (!amt || amt <= 0) { hint.textContent = "Escribe un monto 👆"; hint.style.color = "var(--bad)"; $("#amt").focus(); return; }
  if (!catSel) { hint.textContent = "Elige una categoría 👆"; hint.style.color = "var(--bad)"; return; }
  data.expenses.unshift({ id: uid(), d: TODAY, amt: Math.round(amt * 100) / 100, cur: curSel, cat: catSel, note: ($("#note").value || "").trim() });
  save(); render();
  toast("Anotado ✓");
}

function del(id) {
  const i = data.expenses.findIndex(e => e.id === id);
  if (i < 0) return;
  lastDel = { e: data.expenses[i], i };
  data.expenses.splice(i, 1); save(); render();
  toast("Gasto borrado", "Deshacer", () => { if (lastDel) { data.expenses.splice(lastDel.i, 0, lastDel.e); lastDel = null; save(); render(); } });
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
  $("#gate-btn").onclick = () => askToken();
  $("#t-cancel").onclick = () => $("#tok").close();
  $("#tok-form").onsubmit = () => { const t = $("#t-input").value.trim(); if (!t) return; token = t; ls.set("hub.token", t); $("#tok").close(); load(); };
  load();
})();
