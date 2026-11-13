import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { initializeFirestore, persistentLocalCache, collection, doc, onSnapshot, updateDoc, setDoc, getDoc, writeBatch }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./config.js";
import { SEED } from "./seed.js";

const $ = id => document.getElementById(id);
const DAY = 86400000;
const START_DATE = "2026-11-16"; // first delivery slot (Kogul & Chinthuri's next-day teaser)
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

function show(view){ for (const v of ["signinView","setupView","appView"]) $(v).hidden = v !== view; }

if (!firebaseConfig.apiKey || firebaseConfig.apiKey === "PASTE_HERE") {
  show("setupView");
  throw new Error("Firebase config missing");
}

const app = initializeApp(firebaseConfig);
const db = initializeFirestore(app, { localCache: persistentLocalCache() });

let me = null, items = [], people = {}, settings = { startDate: START_DATE };
let filter = "open", query = "", loaded = false;
let unsubs = [];
const busy = new Set();

// ---------- dates ----------
const parseDate = s => { if (!s) return null; const [y,m,d] = s.split("-").map(Number); return new Date(y, m-1, d); };
const iso = d => d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
const today = () => { const t = new Date(); return new Date(t.getFullYear(), t.getMonth(), t.getDate()); };
const fmt = d => d.toLocaleDateString("en-CA",{weekday:"short",month:"short",day:"numeric"});
const fmtShort = d => d.toLocaleDateString("en-CA",{month:"short",day:"numeric"});
const daysBetween = (a,b) => Math.round((b-a)/DAY);

// Next open item is due 3 days after the latest delivery (or after the start date); each one after it, 3 days later.
function schedule(){
  const sorted = items.slice().sort((a,b)=>a.order-b.order);
  let last = null;
  for (const it of sorted) if (it.status==="done" && it.doneOn) { const d = parseDate(it.doneOn); if (!last || d > last) last = d; }
  let base = new Date(parseDate(settings.startDate).getTime() - 3*DAY);
  if (last && last > base) base = last;
  let k = 0;
  for (const it of sorted) it.shipBy = it.status==="done" ? null : new Date(base.getTime() + 3*(++k)*DAY);
  return sorted;
}
function dueTag(d){
  const diff = daysBetween(today(), d);
  if (diff < 0) return { cls:"late", text:(-diff)+" day"+(diff===-1?"":"s")+" late" };
  if (diff === 0) return { cls:"soon", text:"Due today" };
  if (diff <= 3) return { cls:"soon", text:"Due "+fmt(d) };
  return { cls:"", text:"Ship by "+fmt(d) };
}
const nameOf = uid => !uid ? "" : uid === me?.uid ? "you" : (people[uid]?.name || "your partner");

function banner(msg){ $("banner").textContent = msg || ""; $("banner").hidden = !msg; }

// ---------- render ----------
function render(){
  const sorted = schedule();
  const total = sorted.length, done = sorted.filter(i=>i.status==="done").length;
  $("bar").style.width = total ? (100*done/total)+"%" : "0";
  if (loaded) {
    $("progressText").textContent = done+" of "+total+" delivered";
    const open = sorted.filter(i=>i.status!=="done");
    const lastShip = open.length ? open[open.length-1].shipBy : null;
    $("finishText").textContent = lastShip ? "Last one due "+fmtShort(lastShip)+", "+lastShip.getFullYear() : (total ? "All delivered" : "");
  }

  const nxt = sorted.find(i=>i.status!=="done");
  if (loaded && !nxt) {
    $("nextWhat").textContent = total ? "Everything is delivered 🎉" : "No deliverables yet";
    $("nextWho").textContent = ""; $("nextNote").textContent = "";
    $("nextWhen").hidden = true; $("nextActions").hidden = true;
  } else if (nxt) {
    $("nextWhat").textContent = nxt.deliverable;
    $("nextWho").textContent = nxt.client + " · wedding " + nxt.wedding;
    const t = dueTag(nxt.shipBy);
    $("nextWhen").hidden = false; $("nextWhen").className = "pill "+t.cls; $("nextWhen").textContent = t.text;
    let note = "";
    if (nxt.status==="editing") note = "Being edited by " + nameOf(nxt.editingBy) + ". ";
    if (nxt.final) note += "Final product: collect the balance before sending.";
    $("nextNote").textContent = note;
    $("nextActions").hidden = false;
    $("nextEdit").textContent = nxt.status==="editing" ? "Stop editing" : "I'm editing this";
    $("nextEdit").onclick = () => toggleEditing(nxt);
    $("nextDone").onclick = () => toggleDone(nxt);
    $("nextEdit").disabled = $("nextDone").disabled = busy.has(nxt.id);
  }

  const q = query.trim().toLowerCase();
  const visible = sorted.filter(i =>
    !(filter==="open" && i.status==="done") &&
    !(filter==="editing" && i.status!=="editing") &&
    !(filter==="done" && i.status!=="done") &&
    (!q || i.client.toLowerCase().includes(q) || i.deliverable.toLowerCase().includes(q)));

  const groupsEl = $("groups"); groupsEl.textContent = "";
  if (!loaded) return;
  if (!visible.length) { const e = document.createElement("div"); e.className = "card empty"; e.textContent = "Nothing here."; groupsEl.appendChild(e); return; }

  const byClient = new Map();
  for (const it of visible) { if (!byClient.has(it.client)) byClient.set(it.client, []); byClient.get(it.client).push(it); }
  for (const [client, list] of byClient) {
    const all = sorted.filter(i=>i.client===client);
    const g = document.createElement("div"); g.className = "group";
    const h = document.createElement("h2");
    const hn = document.createElement("div"); hn.textContent = client;
    const hc = document.createElement("span");
    hc.textContent = all.filter(i=>i.status==="done").length+"/"+all.length+" · contract "+fmtShort(parseDate(list[0].deadline));
    h.append(hn, hc); g.appendChild(h);
    const box = document.createElement("div"); box.className = "card list";
    for (const it of list) box.appendChild(rowEl(it));
    g.appendChild(box); groupsEl.appendChild(g);
  }
}

function rowEl(it){
  const r = document.createElement("div"); r.className = "row" + (it.status==="done" ? " done" : "");
  const c = document.createElement("button"); c.className = "check" + (it.status==="done" ? " on" : ""); c.innerHTML = CHECK;
  c.setAttribute("aria-label", it.status==="done" ? "Mark not delivered" : "Mark delivered");
  c.disabled = busy.has(it.id); c.onclick = () => toggleDone(it);
  const b = document.createElement("div"); b.className = "body";
  const t = document.createElement("div"); t.className = "title"; t.textContent = it.deliverable;
  const m = document.createElement("div"); m.className = "meta";
  const tag = (cls, text) => { const s = document.createElement("span"); s.className = "tag "+cls; s.textContent = text; m.appendChild(s); };
  if (it.status==="done") {
    const who = nameOf(it.doneBy);
    tag("done", "Delivered" + (it.doneOn ? " "+fmtShort(parseDate(it.doneOn)) : "") + (who ? " by "+who : ""));
  } else {
    const d = dueTag(it.shipBy); tag(d.cls, d.text);
    if (it.status==="editing") tag("editing", "Editing: "+nameOf(it.editingBy));
    if (it.final) tag("money", "Final product: collect balance");
  }
  if (it.note) { const n = document.createElement("span"); n.textContent = it.note; m.appendChild(n); }
  b.append(t, m); r.append(c, b);
  if (it.status!=="done") {
    const e = document.createElement("button"); e.className = "edit-btn" + (it.status==="editing" ? " on" : "");
    e.textContent = it.status==="editing" ? "Editing" : "Start editing";
    e.disabled = busy.has(it.id); e.onclick = () => toggleEditing(it);
    r.appendChild(e);
  }
  return r;
}

// ---------- writes ----------
async function write(it, data){
  if (busy.has(it.id)) return;
  busy.add(it.id); render();
  try {
    await updateDoc(doc(db, "items", it.id), { ...data, updatedBy: me.uid, updatedAt: new Date().toISOString() });
    banner("");
  } catch (e) {
    banner("Couldn't save that. It will retry when you're back online.");
  } finally { busy.delete(it.id); render(); }
}
const toggleDone = it => it.status==="done"
  ? write(it, { status:"todo", doneOn:null, doneBy:null })
  : write(it, { status:"done", doneOn:iso(today()), doneBy:me.uid, editingBy:null });
const toggleEditing = it => it.status==="editing"
  ? write(it, { status:"todo", editingBy:null })
  : write(it, { status:"editing", editingBy:me.uid });

// First sign-in ever: load the contract deliverables into the database.
async function seedIfEmpty(){
  const flag = await getDoc(doc(db, "meta", "seeded"));
  if (flag.exists()) return;
  const batch = writeBatch(db);
  for (const s of SEED) {
    const { id, ...rest } = s;
    batch.set(doc(db, "items", id), { ...rest, doneOn:null, doneBy:null, editingBy:null });
  }
  batch.set(doc(db, "settings", "main"), { startDate: START_DATE });
  batch.set(doc(db, "meta", "seeded"), { at: new Date().toISOString(), by: me.uid });
  await batch.commit();
}

// ---------- who's on this phone (no login: each phone just has a name) ----------
function deviceId(){
  let id = localStorage.getItem("deliveries-device");
  if (!id) { id = "d" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); localStorage.setItem("deliveries-device", id); }
  return id;
}

async function startApp(){
  show("appView");
  setDoc(doc(db, "people", me.uid), { name: me.name }, { merge: true }).catch(()=>{});
  try { await seedIfEmpty(); } catch (e) { banner("Couldn't reach the list. Check your connection."); }
  unsubs.push(onSnapshot(collection(db, "items"), snap => {
    items = snap.docs.map(d => { const x = d.data(); return {
      id:d.id, order:Number(x.order)||0, client:String(x.client||""), deliverable:String(x.deliverable||""),
      wedding:String(x.wedding||""), deadline:String(x.deadline||""), note:x.note?String(x.note):"", final:!!x.final,
      status: x.status==="done"||x.status==="editing" ? x.status : "todo",
      doneOn:x.doneOn||null, doneBy:x.doneBy||null, editingBy:x.editingBy||null }; });
    loaded = true; render();
  }, () => banner("Lost the connection. Reopen the app to reconnect.")));
  unsubs.push(onSnapshot(collection(db, "people"), snap => {
    people = {}; snap.forEach(d => people[d.id] = d.data()); render();
  }, () => {}));
  unsubs.push(onSnapshot(doc(db, "settings", "main"), s => { if (s.exists() && s.data().startDate) { settings.startDate = s.data().startDate; render(); } }, () => {}));
}

const savedName = localStorage.getItem("deliveries-name");
if (savedName) { me = { uid: deviceId(), name: savedName }; startApp(); }
else show("signinView");

$("signinForm").addEventListener("submit", e => {
  e.preventDefault();
  const name = $("name").value.trim(); if (!name) return;
  localStorage.setItem("deliveries-name", name);
  me = { uid: deviceId(), name };
  startApp();
});
$("filters").addEventListener("click", e => {
  const b = e.target.closest(".chip"); if (!b) return;
  filter = b.dataset.f;
  document.querySelectorAll("#filters .chip").forEach(x => x.classList.toggle("on", x === b));
  render();
});
$("search").addEventListener("input", e => { query = e.target.value; render(); });

// Re-draw every hour so "due today" / "late" stay accurate if the app is left open.
setInterval(render, 60*60*1000);
