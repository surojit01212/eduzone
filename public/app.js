"use strict";

/* ---------- Firebase config ---------- */
const firebaseConfig = {
  apiKey: "AIzaSyCLn28yAoyuCD_3IU1QxlInumWE5BMmK6Q",
  authDomain: "eduzone-012-78426.firebaseapp.com",
  projectId: "eduzone-012-78426",
  storageBucket: "eduzone-012-78426.firebasestorage.app",
  messagingSenderId: "520388164558",
  appId: "1:520388164558:web:ceab1f1ed33f0acd14099f"
};

/* ---------- Lazy Firebase loader (timeout + retry) ---------- */
const FB_BASE = "https://www.gstatic.com/firebasejs/10.12.2/";
let firebasePromise = null;
let authPromise = null;

function loadScript(src, tries) {
  tries = tries || 0;
  return new Promise(function (resolve, reject) {
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    let done = false;

    const timer = setTimeout(function () { fail(); }, 15000);

    function fail() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      s.onload = null;
      s.onerror = null;
      if (s.parentNode) s.parentNode.removeChild(s);
      if (tries < 1) {
        setTimeout(function () {
          loadScript(src, tries + 1).then(resolve, reject);
        }, 600);
      } else {
        reject(new Error("Load failed"));
      }
    }

    s.onload = function () {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    s.onerror = fail;
    document.head.appendChild(s);
  });
}

function loadFirebase() {
  if (firebasePromise) return firebasePromise;
  firebasePromise = loadScript(FB_BASE + "firebase-app-compat.js")
    .then(function () { return loadScript(FB_BASE + "firebase-firestore-compat.js"); })
    .then(function () {
      const first = !firebase.apps.length;
      if (first) firebase.initializeApp(firebaseConfig);
      const db = firebase.firestore();
      if (first) {
        // Helps a lot on weak / blocked mobile networks
        try { db.settings({ experimentalAutoDetectLongPolling: true, merge: true }); } catch (e) { /* ignore */ }
      }
      return db;
    })
    .catch(function (err) {
      firebasePromise = null;
      throw err;
    });
  return firebasePromise;
}

// Auth loads only when login, register, reset, admin, submit or profile is used
function loadAuth() {
  if (authPromise) return authPromise;
  authPromise = loadFirebase()
    .then(function () { return loadScript(FB_BASE + "firebase-auth-compat.js"); })
    .then(function () { return firebase.auth(); })
    .catch(function (err) {
      authPromise = null;
      throw err;
    });
  return authPromise;
}

// Any request that takes too long fails, so "Loading..." never hangs forever
function withTimeout(p, ms) {
  return new Promise(function (resolve, reject) {
    const t = setTimeout(function () { reject(new Error("timeout")); }, ms);
    p.then(function (v) { clearTimeout(t); resolve(v); },
           function (e) { clearTimeout(t); reject(e); });
  });
}

/* ---------- Fast public reads (no Firebase SDK needed) ---------- */
// Notes, routines, papers, people and settings are public in the rules, so they
// are read with one small web request. The heavy Firebase files load only for
// login, submit and the admin panel. This keeps the app fast on weak phones.
const FS_URL = "https://firestore.googleapis.com/v1/projects/" + firebaseConfig.projectId +
  "/databases/(default)/documents";

function fsVal(v) {
  if (!v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return parseInt(v.integerValue, 10);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return Date.parse(v.timestampValue) || 0;
  if ("mapValue" in v) return fsFields(v.mapValue.fields);
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(fsVal);
  return null;
}

function fsFields(f) {
  const o = {};
  if (f) Object.keys(f).forEach(function (k) { o[k] = fsVal(f[k]); });
  return o;
}

function fsDoc(d) {
  const o = fsFields(d.fields);
  o.id = String(d.name || "").split("/").pop();
  return o;
}

// fetch with a timeout. 404 gives null. Other errors carry err.http (status).
function restFetch(url, opt, ms) {
  return new Promise(function (resolve, reject) {
    const ctl = window.AbortController ? new AbortController() : null;
    const t = setTimeout(function () {
      if (ctl) ctl.abort();
      reject(new Error("timeout"));
    }, ms);
    opt = opt || {};
    if (ctl) opt.signal = ctl.signal;
    fetch(url, opt)
      .then(function (r) {
        clearTimeout(t);
        if (r.status === 404) { resolve(null); return null; }
        if (!r.ok) {
          const e = new Error("http");
          e.http = r.status;
          reject(e);
          return null;
        }
        return r.json().then(resolve);
      })
      .catch(function (e) { clearTimeout(t); reject(e); });
  });
}

// spec = { col, where: [field, value], order: field, desc: bool, limit }
function restRead(spec) {
  const q = { from: [{ collectionId: spec.col }], limit: spec.limit || 100 };
  if (spec.where) {
    q.where = {
      fieldFilter: {
        field: { fieldPath: spec.where[0] },
        op: "EQUAL",
        value: { stringValue: spec.where[1] }
      }
    };
  }
  if (spec.select) {
    q.select = { fields: spec.select.map(function (f) { return { fieldPath: f }; }) };
  }
  if (spec.order) {
    q.orderBy = [{ field: { fieldPath: spec.order }, direction: spec.desc ? "DESCENDING" : "ASCENDING" }];
  }
  return restFetch(
    FS_URL + ":runQuery?key=" + firebaseConfig.apiKey,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ structuredQuery: q }) },
    12000
  ).then(function (rows) {
    const out = [];
    (rows || []).forEach(function (r) { if (r && r.document) out.push(fsDoc(r.document)); });
    return out;
  });
}

// Same read through the Firebase SDK (used only if the web request is refused)
function sdkRead(spec) {
  return loadFirebase()
    .then(function (db) {
      let q = db.collection(spec.col);
      if (spec.where) q = q.where(spec.where[0], "==", spec.where[1]);
      if (spec.order) q = q.orderBy(spec.order, spec.desc ? "desc" : "asc");
      return withTimeout(q.limit(spec.limit || 100).get(), 15000);
    })
    .then(function (snap) {
      const out = [];
      snap.forEach(function (d) {
        const x = d.data();
        x.id = d.id;
        Object.keys(x).forEach(function (k) {
          if (x[k] && typeof x[k].toMillis === "function") x[k] = x[k].toMillis();
        });
        out.push(x);
      });
      return out;
    });
}

function readCol(spec) {
  return restRead(spec).catch(function (err) {
    if (!err || !err.http) throw err;   // offline / slow network: do not try twice
    return sdkRead(spec);
  });
}

function readDoc(col, id) {
  return restFetch(FS_URL + "/" + col + "/" + encodeURIComponent(id) + "?key=" + firebaseConfig.apiKey, null, 10000)
    .then(function (d) { return d ? fsDoc(d) : null; })
    .catch(function (err) {
      if (!err || !err.http) throw err;
      return loadFirebase()
        .then(function (db) { return withTimeout(db.collection(col).doc(id).get(), 15000); })
        .then(function (d) { return d.exists ? Object.assign({ id: d.id }, d.data()) : null; });
    });
}

/* ---------- Offline data saved on the phone ---------- */
function lsGet(k) {
  try { return JSON.parse(localStorage.getItem("ez_c_" + k) || "null"); } catch (e) { return null; }
}

function lsSet(k, v) {
  try {
    localStorage.setItem("ez_c_" + k, JSON.stringify(v));
    localStorage.setItem("ez_t_" + k, String(Date.now()));
  } catch (e) { /* storage full or blocked */ }
}

// true if the saved copy is newer than ms (then we skip the network call)
function lsFresh(k, ms) {
  try {
    return Date.now() - (parseInt(localStorage.getItem("ez_t_" + k), 10) || 0) < ms;
  } catch (e) { return false; }
}

// Called after the admin changes data, so the next open reads fresh data
function lsBust() {
  try {
    Object.keys(localStorage).forEach(function (k) {
      if (k.indexOf("ez_t_") === 0) localStorage.removeItem(k);
    });
  } catch (e) { /* ignore */ }
}

const NET_MSG = "Please check your internet connection";

function offlineText() {
  return NET_MSG;
}

/* ---------- Data ---------- */
const SUBJECTS = [
  { id: "bengali", name: "Bengali" },
  { id: "english", name: "English" },
  { id: "math", name: "Math" },
  { id: "life-science", name: "Life Science" },
  { id: "physical-science", name: "Physical Science" },
  { id: "history", name: "History" },
  { id: "geography", name: "Geography" }
];

const GRAMMAR = {
  bengali: "Bengali Grammar",
  english: "English Grammar"
};

const KIND_NAME = {
  tuition: "Tuition Routine",
  exam: "Exam Routine",
  board: "Board Exam Routine"
};

const KIND_GROUPS = {
  tuition: [
    { v: "art", t: "Art" },
    { v: "science", t: "Science" }
  ],
  exam: [
    { v: "art", t: "Art" },
    { v: "science", t: "Science" },
    { v: "school", t: "School" }
  ],
  board: []
};

const VIEWS = {
  "tuition": {
    kind: "tuition",
    title: "Tuition Routine",
    group: "",
    tabs: [
      { key: "art", label: "Art Tuition", group: "art", gender: "" },
      { key: "science", label: "Science Tuition", group: "science", gender: "" }
    ]
  },
  "exam-art": { kind: "exam", title: "Exam Routine • Art", group: "art", tabs: [] },
  "exam-science": { kind: "exam", title: "Exam Routine • Science", group: "science", tabs: [] },
  "exam-school": {
    kind: "exam",
    title: "Exam Routine • School",
    group: "school",
    tabs: [
      { key: "boys", label: "Boys School", group: "", gender: "boys" },
      { key: "girls", label: "Girls School", group: "", gender: "girls" }
    ]
  },
  "board": { kind: "board", title: "Board Exam Routine", group: "", tabs: [] }
};

function subjectName(id) {
  for (let i = 0; i < SUBJECTS.length; i++) {
    if (SUBJECTS[i].id === id) return SUBJECTS[i].name;
  }
  return id;
}

/* ---------- Helpers ---------- */
function $(id) { return document.getElementById(id); }

const panel = $("panel");
const subView = $("subView");
const rtView = $("rtView");
const smView = $("smView");
const authView = $("authView");
const msgEl = $("msg");
const aMsg = $("aMsg");
const smMsg = $("smMsg");
const epMsg = $("epMsg");
const ppView = $("ppView");
const actView = $("actView");
const profView = $("profView");
const ctView = $("ctView");
const toastEl = $("toast");

// Run heavy work (list rendering) AFTER the open animation has painted its first frame,
// so the animation never competes with DOM building on weak phones.
function afterPaint(fn) {
  if (!window.requestAnimationFrame) { setTimeout(fn, 0); return; }
  requestAnimationFrame(function () { setTimeout(fn, 0); });
}

function syncScroll() {
  const open = !panel.hidden || !subView.hidden || !rtView.hidden ||
    !smView.hidden || !authView.hidden || !ppView.hidden ||
    !actView.hidden || !profView.hidden || !ctView.hidden;
  document.body.style.overflow = open ? "hidden" : "";
}

function setMsg(el, text, type) {
  el.textContent = text;
  el.className = "msg " + (type || "");
  clearTimeout(el._t);
  if (text && type === "ok" && (el === smMsg || el === epMsg)) {
    el.textContent = "";
    toast(text, false, "ok");
    return;
  }
  if (text && type === "ok") {
    el._t = setTimeout(function () { el.textContent = ""; }, 3000);
  }
}

// Success messages become a small in-app notification (about 2.5 seconds).
// Errors stay visible in the message line until the next action.
function showMsg(text, type) {
  if (type === "ok" && text) {
    setMsg(msgEl, "");
    toast(text, false, "ok");
    return;
  }
  setMsg(msgEl, text, type);
}

// In-app notification at the bottom of the screen.
// sticky = stays until replaced / hidden. kind = "ok" | "err" | "" (color)
function toast(text, sticky, kind) {
  toastEl.textContent = text;
  toastEl.className = "toast" + (kind ? " " + kind : "");
  toastEl.hidden = false;
  clearTimeout(toastEl._t);
  if (!sticky) toastEl._t = setTimeout(function () { toastEl.hidden = true; }, 2500);
}

/* ---------- In-app confirm dialog (replaces the browser's confirm box) ---------- */
const dlgEl = $("dlg");
let dlgDone = null;

// Returns a Promise: true if the user taps the main button, false otherwise
function askConfirm(title, text, okLabel, danger) {
  return new Promise(function (resolve) {
    if (dlgDone) closeDlg(false);
    $("dlgTitle").textContent = title || "Are you sure?";
    $("dlgText").textContent = text || "";
    $("dlgYes").textContent = okLabel || "OK";
    $("dlgYes").className = "btn" + (danger ? " danger-fill" : "");
    dlgDone = resolve;
    dlgEl.hidden = false;
  });
}

function closeDlg(result) {
  if (dlgEl.hidden && !dlgDone) return;
  dlgEl.hidden = true;
  const f = dlgDone;
  dlgDone = null;
  if (f) f(result);
}

$("dlgYes").addEventListener("click", function () { closeDlg(true); });
$("dlgNo").addEventListener("click", function () { closeDlg(false); });
dlgEl.addEventListener("click", function (e) { if (e.target === dlgEl) closeDlg(false); });

function hideToast() {
  clearTimeout(toastEl._t);
  toastEl.hidden = true;
}

function emptyText(parent, text) {
  parent.innerHTML = "";
  const p = document.createElement("p");
  p.className = "empty";
  p.textContent = text;
  parent.appendChild(p);
}

// Error text with a Retry button
function errorText(parent, text, retry) {
  parent.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "empty";
  const p = document.createElement("p");
  p.textContent = text;
  wrap.appendChild(p);
  if (retry) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn ghost sm";
    b.textContent = "↻ Retry";
    b.addEventListener("click", function () { b.classList.add("busy"); retry(); });
    wrap.appendChild(b);
  }
  parent.appendChild(wrap);
}

function subjectIndex(id) {
  for (let i = 0; i < SUBJECTS.length; i++) if (SUBJECTS[i].id === id) return i;
  return 99;
}

function fillSubjects(select, withAll) {
  const frag = document.createDocumentFragment();
  if (withAll) {
    const o = document.createElement("option");
    o.value = "all";
    o.textContent = "All subjects";
    frag.appendChild(o);
  }
  SUBJECTS.forEach(function (s) {
    const o = document.createElement("option");
    o.value = s.id;
    o.textContent = s.name;
    frag.appendChild(o);
  });
  select.appendChild(frag);
}

function noteTitle(n) {
  if (n.type === "chapter") return "Chapter " + n.chapterNo + ": " + n.chapterName;
  if (n.type === "grammar") return "Grammar: " + n.topicName;
  return "Topic: " + n.topicName;
}

function validEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function fmtFull(ts) {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleString([], {
      day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit"
    });
  } catch (e) { return ""; }
}

// Small muted line under a published item: "Contributed by Surojit"
function byLine(name) {
  if (!name || typeof name !== "string") return null;
  const s = document.createElement("span");
  s.className = "nby";
  s.textContent = "Contributed by " + name;
  return s;
}

/* ---------- Copy / select protection (fields stay usable) ---------- */
function isField(t) {
  return !!(t && t.closest && t.closest("input, textarea, select"));
}

["copy", "cut", "contextmenu", "selectstart", "dragstart"].forEach(function (name) {
  document.addEventListener(name, function (e) {
    if (!isField(e.target)) e.preventDefault();
  });
});

/* ---------- Reload ---------- */
function spinBtn(btn, ms) {
  if (!btn) return;
  btn.classList.add("spin");
  setTimeout(function () { btn.classList.remove("spin"); }, ms || 800);
}

function doReload() {
  const t0 = Date.now();
  spinBtn($("reloadBtn"), 3000);
  lsBust();
  let done = false;
  // The page reloads only after the spin has been visible for about 1 second
  function go() {
    if (done) return;
    done = true;
    setTimeout(function () { location.reload(); }, Math.max(0, 1000 - (Date.now() - t0)));
  }
  setTimeout(go, 1500);
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.getRegistration()
      .then(function (r) { return r ? r.update() : null; })
      .then(go, go);
  } else {
    go();
  }
}

$("reloadBtn").addEventListener("click", doReload);

if ("serviceWorker" in navigator && !(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())) {
  // A new app version takes over: reload once so the newest files are used
  const hadSW = !!navigator.serviceWorker.controller;
  let swReloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", function () {
    if (!hadSW || swReloaded) return;
    swReloaded = true;
    location.reload();
  });
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("sw.js").catch(function () { /* ignore */ });
  });
}

/* ---------- User (saved on the phone, no Firebase needed on open) ---------- */
let user = null;
try { user = JSON.parse(localStorage.getItem("ez_user") || "null"); } catch (e) { user = null; }

function saveUser(u) {
  user = u;
  try { localStorage.setItem("ez_user", JSON.stringify(u)); } catch (e) { /* storage blocked */ }
}

function roleText(u) {
  if (u.type === "guest") {
    return "Guest • " + (u.role === "teacher" ? "Teacher" : "Student");
  }
  return u.role === "teacher" ? "Teacher" : "Student";
}

// Photo, or the first letter of the name on a soft colour circle (like WhatsApp)
const AV_COLORS = ["#0d9488", "#2563eb", "#7c3aed", "#db2777", "#ea580c", "#16a34a", "#0891b2", "#b45309"];

function makeAvatar(name, photo, size) {
  let av;
  if (photo) {
    av = document.createElement("img");
    av.src = photo;
    av.alt = "";
    av.draggable = false;
  } else {
    const n = String(name || "").trim();
    av = document.createElement("div");
    av.textContent = (Array.from(n)[0] || "?").toUpperCase();
    let h = 0;
    for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) % 997;
    av.style.background = AV_COLORS[h % AV_COLORS.length];
  }
  av.className = "av";
  if (size) {
    av.style.width = size + "px";
    av.style.height = size + "px";
    av.style.fontSize = Math.round(size * 0.44) + "px";
  }
  return av;
}

function renderUserBox() {
  $("profBtn").hidden = !user;
  const box = $("uBox");
  box.innerHTML = "";
  if (!user) { box.hidden = true; return; }

  const av = makeAvatar(user.name, user.photo, 0);

  const info = document.createElement("div");
  const un = document.createElement("div");
  un.className = "un";
  un.textContent = user.name || "";
  const us = document.createElement("div");
  us.className = "us";
  us.textContent = roleText(user);
  info.appendChild(un);
  info.appendChild(us);

  box.appendChild(av);
  box.appendChild(info);
  box.hidden = false;
}

// Clears everything saved for this user on the phone, signs out and reloads
function clearSession() {
  try {
    localStorage.removeItem("ez_user");
    localStorage.removeItem("ez_reg");
    localStorage.removeItem("ez_pend");
    localStorage.removeItem("ez_adm");
    localStorage.removeItem("ez_sync");
    sessionStorage.removeItem("ez_admin");
  } catch (e) { /* ignore */ }
  function done() { location.reload(); }
  if (window.firebase && firebase.auth) {
    firebase.auth().signOut().then(done, done);
  } else {
    done();
  }
}

function logoutNow() {
  if (user && user.type === "guest" && user.uid && navigator.onLine !== false) {
    const gid = user.uid;
    toast("Logging out...", true);
    const t = setTimeout(clearSession, 3000);
    loadAuth()
      .then(function () { return firebase.firestore().collection("people").doc(gid).delete(); })
      .catch(function () { /* ignore */ })
      .then(function () { clearTimeout(t); clearSession(); });
    return;
  }
  clearSession();
}

function doLogout() {
  askConfirm("Log out?", "Do you want to log out of EduZone?", "Log out", true)
    .then(function (ok) { if (ok) logoutNow(); });
}

/* ---------- User registry (one small check when the app opens) ---------- */
// people/{uid} = { name, role, guest, ts }. It is used for the Users list.
// If the admin deletes a user, this phone is logged out on the next open.
// Guests are not registered (rules only allow real accounts).
function markSynced() {
  try { localStorage.setItem("ez_sync", String(Date.now())); } catch (e) { /* ignore */ }
}

// Full check through Firebase (only first time, or when the account is missing online)
function fullSync() {
  currentAuthUser()
    .then(function (u) {
      if (!u || u.isAnonymous) return null;
      // Ignore a different account
      if (u.email && user.email && u.email.toLowerCase() !== user.email.toLowerCase()) return null;

      if (!user.uid) saveUser(Object.assign({}, user, { uid: u.uid }));

      const ref = firebase.firestore().collection("people").doc(u.uid);
      const role = user.role === "teacher" ? "teacher" : "student";
      const name = String(user.name || "User").slice(0, 80);

      return ref.get().then(function (d) {
        if (!d.exists) {
          let was = null;
          try { was = localStorage.getItem("ez_reg"); } catch (e) { was = null; }
          if (was === u.uid) { clearSession(); return null; }
          return ref.set({ name: name, role: role, guest: false, ts: Date.now() })
            .then(function () {
              try { localStorage.setItem("ez_reg", u.uid); } catch (e) { /* ignore */ }
            });
        }
        try { localStorage.setItem("ez_reg", u.uid); } catch (e) { /* ignore */ }
        const x = d.data();
        if (x.name !== name || x.role !== role) {
          return ref.update({ name: name, role: role });
        }
        return null;
      });
    })
    .then(markSynced)
    .catch(function () { /* try again next time */ });
}

// Opens fast: one tiny web request, at most once every 6 hours, after the first screen.
// If the admin deleted this user, this phone is logged out.
// Guests are not registered (rules only allow real accounts).
// A guest gets an anonymous ID so the admin and the Users page can see the guest.
function fullSyncGuest() {
  currentAuthUser()
    .then(function (u) {
      if (u && !u.isAnonymous) return null;
      if (u) return u;
      return firebase.auth().signInAnonymously().then(function (c) { return c.user; });
    })
    .then(function (u) {
      if (!u || !user) return null;
      if (user.uid !== u.uid) saveUser(Object.assign({}, user, { uid: u.uid }));

      const ref = firebase.firestore().collection("people").doc(u.uid);
      const role = user.role === "teacher" ? "teacher" : "student";
      const name = String(user.name || "Guest").slice(0, 80);

      return ref.get().then(function (d) {
        if (!d.exists) {
          let was = null;
          try { was = localStorage.getItem("ez_reg"); } catch (e) { was = null; }
          if (was === u.uid) { clearSession(); return null; }
          return ref.set({ name: name, role: role, guest: true, ts: Date.now() })
            .then(function () {
              try { localStorage.setItem("ez_reg", u.uid); } catch (e) { /* ignore */ }
            });
        }
        try { localStorage.setItem("ez_reg", u.uid); } catch (e) { /* ignore */ }
        const x = d.data();
        if (x.name !== name || x.role !== role) return ref.update({ name: name, role: role });
        return null;
      });
    })
    .then(markSynced)
    .catch(function () { /* try again next time */ });
}

// Opens fast: one tiny web request, at most once every 6 hours, after the first screen.
// If the admin deleted this user, this phone is logged out.
function syncMe() {
  if (!user || navigator.onLine === false) return;

  let last = 0;
  try { last = parseInt(localStorage.getItem("ez_sync"), 10) || 0; } catch (e) { last = 0; }
  if (user.uid && Date.now() - last < 6 * 3600 * 1000) return;

  setTimeout(function () {
    if (!user) return;
    const guest = user.type === "guest";

    if (!user.uid) { if (guest) fullSyncGuest(); else fullSync(); return; }

    const uid = user.uid;
    readDoc("people", uid)
      .then(function (x) {
        markSynced();
        let was = null;
        try { was = localStorage.getItem("ez_reg"); } catch (e) { was = null; }
        if (x) {
          try { localStorage.setItem("ez_reg", uid); } catch (e) { /* ignore */ }
        } else if (was === uid) {
          clearSession();
        } else if (guest) {
          fullSyncGuest();
        } else {
          fullSync();
        }
      })
      .catch(function () { /* try again next time */ });
  }, 4000);
}

/* ---------- Auth screen ---------- */
let authMode = "login";
let photoData = "";

function setAuthMode(m) {
  authMode = m;
  $("authTabs").hidden = !(m === "login" || m === "guest");
  $("aTabLogin").classList.toggle("on", m === "login");
  $("aTabGuest").classList.toggle("on", m === "guest");
  $("loginForm").hidden = m !== "login";
  $("pForm").hidden = !(m === "register" || m === "guest");
  $("fForm").hidden = m !== "forgot";
  $("credWrap").hidden = m !== "register";
  $("pBack").hidden = m !== "register";
  $("pTitle").textContent = m === "register" ? "Register" : "Continue as a guest";
  $("pBtn").textContent = m === "register" ? "Create account" : "Continue as guest";
  setMsg(aMsg, "");
  authView.scrollTop = 0;
}

function showAuth() {
  authView.hidden = false;
  setAuthMode("login");
  syncScroll();
}

function enterApp() {
  authView.hidden = true;
  renderUserBox();
  syncScroll();
  syncMe();
}

function authError(err, el) {
  const c = (err && err.code) || "";
  let m = "Something went wrong. Please try again.";
  if (!c || c === "auth/network-request-failed") {
    m = NET_MSG;
  } else if (c === "auth/invalid-credential" || c === "auth/wrong-password" ||
             c === "auth/user-not-found" || c === "auth/invalid-login-credentials") {
    m = "Incorrect email or password.";
  } else if (c === "auth/email-already-in-use") {
    m = "An account with this email already exists.";
  } else if (c === "auth/weak-password") {
    m = "Password must be at least 6 characters.";
  } else if (c === "auth/invalid-email") {
    m = "Please enter a valid email.";
  } else if (c === "auth/too-many-requests") {
    m = "Too many attempts. Please try again later.";
  } else if (c === "auth/requires-recent-login") {
    m = "Please log out and log in again, then try.";
  } else if (c === "auth/operation-not-allowed") {
    m = "Enable this sign-in method in Firebase Authentication.";
  }
  setMsg(el && el.nodeType === 1 ? el : aMsg, m, "err");
}

$("aTabLogin").addEventListener("click", function () { setAuthMode("login"); });
$("aTabGuest").addEventListener("click", function () { setAuthMode("guest"); });
$("toReg").addEventListener("click", function () { setAuthMode("register"); });
$("toForgot").addEventListener("click", function () { setAuthMode("forgot"); });
$("pBack").addEventListener("click", function () { setAuthMode("login"); });
$("fBack").addEventListener("click", function () { setAuthMode("login"); });

function toggleRole() {
  const teacher = $("pRole").value === "teacher";
  $("stuWrap").hidden = teacher;
  $("tchWrap").hidden = !teacher;
}
$("pRole").addEventListener("change", toggleRole);

// Profile picture: resized to 160x160 (about 8 KB), no Storage needed
function readPhoto(file, ok, fail) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = function () {
    const size = 160;
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const m = Math.min(img.width, img.height);
    c.getContext("2d").drawImage(
      img, (img.width - m) / 2, (img.height - m) / 2, m, m, 0, 0, size, size
    );
    const data = c.toDataURL("image/jpeg", 0.72);
    URL.revokeObjectURL(url);
    ok(data);
  };
  img.onerror = function () {
    URL.revokeObjectURL(url);
    fail();
  };
  img.src = url;
}

$("pPhoto").addEventListener("change", function () {
  const f = this.files && this.files[0];
  if (!f) return;
  if (!/^image\//.test(f.type)) {
    setMsg(aMsg, "Please choose an image file.", "err");
    return;
  }
  readPhoto(f, function (data) {
    photoData = data;
    const prev = $("pPrev");
    prev.src = data;
    prev.hidden = false;
    setMsg(aMsg, "");
  }, function () {
    setMsg(aMsg, "Could not read this image.", "err");
  });
});

function readProfile() {
  const role = $("pRole").value;
  const name = $("pName").value.trim();
  if (name.length < 2) { setMsg(aMsg, "Please enter your full name.", "err"); return null; }

  const p = { role: role, name: name };

  if (role === "student") {
    const school = $("pSchool").value.trim();
    const dob = $("pDob").value;
    if (!school) { setMsg(aMsg, "Please enter your school name.", "err"); return null; }
    if (!dob || new Date(dob) > new Date()) {
      setMsg(aMsg, "Please enter a valid date of birth.", "err");
      return null;
    }
    p.school = school;
    p.dob = dob;
    if (photoData) p.photo = photoData;   // optional
  } else {
    const tuition = $("pTuition").value.trim();
    if (!tuition) { setMsg(aMsg, "Please enter your tuition name.", "err"); return null; }
    p.tuition = tuition;
  }
  return p;
}

$("pForm").addEventListener("submit", function (e) {
  e.preventDefault();
  const p = readProfile();
  if (!p) return;

  // Guest: no Firebase needed, saved on this phone only
  if (authMode === "guest") {
    p.type = "guest";
    p.email = "";
    saveUser(p);
    enterApp();
    return;
  }

  const email = $("pEmail").value.trim();
  const pass = $("pPass").value;
  if (!validEmail(email)) { setMsg(aMsg, "Please enter a valid email.", "err"); return; }
  if (pass.length < 6) { setMsg(aMsg, "Password must be at least 6 characters.", "err"); return; }

  const btn = $("pBtn");
  btn.disabled = true;
  setMsg(aMsg, "Creating your account...", "");

  loadAuth()
    .then(function (auth) { return auth.createUserWithEmailAndPassword(email, pass); })
    .then(function (cred) {
      p.uid = cred.user.uid;
      const doc = Object.assign({}, p, { email: email, createdAt: Date.now() });
      return firebase.firestore().collection("users").doc(cred.user.uid).set(doc)
        .catch(function () { /* profile is kept on the phone anyway */ });
    })
    .then(function () {
      p.type = "account";
      p.email = email;
      saveUser(p);
      enterApp();
    })
    .catch(authError)
    .then(function () { btn.disabled = false; });
});

$("loginForm").addEventListener("submit", function (e) {
  e.preventDefault();
  const email = $("lEmail").value.trim();
  const pass = $("lPass").value;
  if (!validEmail(email)) { setMsg(aMsg, "Please enter a valid email.", "err"); return; }
  if (!pass) { setMsg(aMsg, "Please enter your password.", "err"); return; }

  const btn = $("lBtn");
  let uid = "";
  btn.disabled = true;
  setMsg(aMsg, "Logging in...", "");

  loadAuth()
    .then(function (auth) { return auth.signInWithEmailAndPassword(email, pass); })
    .then(function (cred) {
      uid = cred.user.uid;
      return firebase.firestore().collection("users").doc(cred.user.uid).get()
        .then(function (d) { return d.exists ? d.data() : null; })
        .catch(function () { return null; });
    })
    .then(function (p) {
      const u = p || { role: "student", name: email.split("@")[0] };
      u.uid = uid;
      u.type = "account";
      u.email = email;
      saveUser(u);
      $("lPass").value = "";
      enterApp();
    })
    .catch(authError)
    .then(function () { btn.disabled = false; });
});

$("fForm").addEventListener("submit", function (e) {
  e.preventDefault();
  const email = $("fEmail").value.trim();
  if (!validEmail(email)) { setMsg(aMsg, "Please enter a valid email.", "err"); return; }

  const btn = $("fBtn");
  btn.disabled = true;
  setMsg(aMsg, "Sending...", "");

  loadAuth()
    .then(function (auth) { return auth.sendPasswordResetEmail(email); })
    .then(function () {
      setMsg(aMsg, "Reset link sent ✓ Check your spam folder too.", "ok");
    })
    .catch(authError)
    .then(function () { btn.disabled = false; });
});

/* ---------- Side menu ---------- */
const drawer = $("drawer");
const overlay = $("overlay");
let routineSub = null;
let examSub = null;
let paperSub = null;
let qbSub = null;

function buildMenu() {
  const frag = document.createDocumentFragment();

  function item(icon, label, go, arrow) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.go = go;
    const i = document.createElement("span");
    i.className = "ico";
    i.textContent = icon;
    const t = document.createElement("span");
    t.textContent = label;
    b.appendChild(i);
    b.appendChild(t);
    if (arrow) {
      const a = document.createElement("span");
      a.className = "arrow";
      a.textContent = "▼";
      b.appendChild(a);
    }
    return b;
  }

  frag.appendChild(item("🏠", "Home", "home", false));
  frag.appendChild(item("📤", "Submit", "submit", false));
  frag.appendChild(item("🗓️", "Routine", "routine", true));

  routineSub = document.createElement("div");
  routineSub.className = "sub";
  routineSub.hidden = true;

  routineSub.appendChild(item("📚", "Tuition Routine", "rt-tuition", false));
  routineSub.appendChild(item("📝", "Exam Routine", "exam", true));

  examSub = document.createElement("div");
  examSub.className = "sub";
  examSub.hidden = true;
  examSub.appendChild(item("🎨", "Art", "rt-exam-art", false));
  examSub.appendChild(item("🔬", "Science", "rt-exam-science", false));
  examSub.appendChild(item("🏫", "School", "rt-exam-school", false));
  routineSub.appendChild(examSub);

  routineSub.appendChild(item("🎓", "Board Exam Routine", "rt-board", false));
  frag.appendChild(routineSub);

  frag.appendChild(item("📄", "PYQ & PAPERS", "papers", true));

  paperSub = document.createElement("div");
  paperSub.className = "sub";
  paperSub.hidden = true;
  paperSub.appendChild(item("🎓", "Board PYQ", "pp-board", false));
  paperSub.appendChild(item("🏫", "School Exam Paper", "pp-school", false));
  paperSub.appendChild(item("📚", "Tuition Exam Paper", "pp-tuition", false));
  frag.appendChild(paperSub);

  frag.appendChild(item("🗂️", "Question Bank", "qbank", true));

  qbSub = document.createElement("div");
  qbSub.className = "sub";
  qbSub.hidden = true;
  qbSub.appendChild(item("📝", "Model Question Paper", "pp-model", false));
  qbSub.appendChild(item("💡", "Suggestions", "pp-suggestion", false));
  frag.appendChild(qbSub);

  frag.appendChild(item("👥", "Users", "activity", false));
  frag.appendChild(item("✉️", "Contact Us", "contact", false));

  const sep = document.createElement("div");
  sep.className = "sep";
  frag.appendChild(sep);
  frag.appendChild(item("🛡️", "Admin Panel", "admin", false));
  frag.appendChild(item("🚪", "Logout", "logout", false));
  $("drawerList").appendChild(frag);

}

function openMenu() {
  drawer.classList.add("open");
  overlay.classList.add("open");
}

function closeMenu() {
  drawer.classList.remove("open");
  overlay.classList.remove("open");
}

$("menuBtn").addEventListener("click", openMenu);
$("drawerClose").addEventListener("click", closeMenu);
overlay.addEventListener("click", closeMenu);

$("drawerList").addEventListener("click", function (e) {
  const b = e.target.closest("button");
  if (!b) return;
  const go = b.dataset.go;

  if (go === "routine") {
    routineSub.hidden = !routineSub.hidden;
    return;
  }
  if (go === "exam") {
    examSub.hidden = !examSub.hidden;
    return;
  }
  if (go === "papers") {
    paperSub.hidden = !paperSub.hidden;
    return;
  }
  if (go === "qbank") {
    qbSub.hidden = !qbSub.hidden;
    return;
  }
  if (go === "logout") {
    closeMenu();
    doLogout();
    return;
  }

  closeMenu();
  closeSubject();
  closeRoutine();
  closeSubmit();
  closePapers();
  closeActivity();
  closeProfile();
  closeContact();
  closePanel();

  if (go === "admin") {
    openPanel();
  } else if (go === "submit") {
    openSubmit();
  } else if (go === "activity") {
    openActivity();
  } else if (go === "contact") {
    openContact();
  } else if (go.indexOf("rt-") === 0) {
    openRoutine(go.slice(3));
  } else if (go.indexOf("pp-") === 0) {
    openPapers(go.slice(3));
  }
});

buildMenu();

/* ---------- Subject page ---------- */
let currentSubject = null;
let currentTab = "chapter";
let subCache = {};
const subList = $("subList");
const subTabs = $("subTabs");

function openSubject(id) {
  currentSubject = id;
  currentTab = "chapter";
  $("subTitle").textContent = subjectName(id);
  buildSubTabs();
  subView.hidden = false;
  subView.scrollTop = 0;
  syncScroll();
  afterPaint(function () { if (currentSubject === id) loadSubject(id); });
}

function closeSubject() {
  subView.hidden = true;
  currentSubject = null;
  syncScroll();
}

function buildSubTabs() {
  subTabs.innerHTML = "";
  const tabs = [
    { key: "chapter", label: "Chapter" },
    { key: "topic", label: "Topic" }
  ];
  if (GRAMMAR[currentSubject]) {
    tabs.push({ key: "grammar", label: GRAMMAR[currentSubject] });
  }
  const frag = document.createDocumentFragment();
  tabs.forEach(function (t) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tab" + (t.key === currentTab ? " on" : "");
    b.dataset.key = t.key;
    b.textContent = t.label;
    frag.appendChild(b);
  });
  subTabs.appendChild(frag);
}

subTabs.addEventListener("click", function (e) {
  const b = e.target.closest(".tab");
  if (!b) return;
  currentTab = b.dataset.key;
  const all = subTabs.children;
  for (let i = 0; i < all.length; i++) {
    all[i].classList.toggle("on", all[i] === b);
  }
  renderSubject();
});

function loadSubject(id) {
  if (subCache[id]) { renderSubject(); return; }

  // Show the copy saved on the phone first, then refresh from the internet
  const saved = lsGet("n_" + id);
  if (saved) {
    subCache[id] = saved;
    renderSubject();
    if (navigator.onLine === false || lsFresh("n_" + id, 60000)) return;
  } else {
    emptyText(subList, "Loading...");
  }

  readCol({ col: "notes", where: ["subject", id], limit: 300 })
    .then(function (list) {
      // Only what the page needs is saved on the phone
      const arr = list.map(function (n) {
        return {
          id: n.id,
          subject: n.subject,
          type: n.type,
          link: n.link,
          chapterNo: n.chapterNo,
          chapterName: n.chapterName,
          topicName: n.topicName,
          by: typeof n.by === "string" ? n.by : ""
        };
      });
      subCache[id] = arr;
      lsSet("n_" + id, arr);
      if (currentSubject === id) renderSubject();
    })
    .catch(function () {
      if (!saved && currentSubject === id) {
        errorText(subList, offlineText(), function () { loadSubject(id); });
      }
    });
}

function renderSubject() {
  const all = subCache[currentSubject] || [];
  const items = all.filter(function (n) { return n.type === currentTab; });

  if (currentTab === "chapter") {
    items.sort(function (a, b) { return (a.chapterNo || 0) - (b.chapterNo || 0); });
  } else {
    items.sort(function (a, b) {
      return (a.topicName || "").localeCompare(b.topicName || "");
    });
  }

  if (!items.length) {
    emptyText(subList, "No notes yet");
    return;
  }

  subList.innerHTML = "";
  const frag = document.createDocumentFragment();
  items.forEach(function (n) {
    const a = document.createElement("a");
    a.className = "nlink";
    a.href = n.link;
    a.target = "_blank";
    a.rel = "noopener noreferrer";

    const t = document.createElement("span");
    t.className = "nt";
    t.textContent = n.type === "chapter"
      ? "Chapter " + n.chapterNo + ": " + n.chapterName
      : n.topicName;

    const box = document.createElement("div");
    box.appendChild(t);
    const bl = byLine(n.by);
    if (bl) box.appendChild(bl);

    const g = document.createElement("span");
    g.className = "go";
    g.textContent = "Open ↗";

    a.appendChild(box);
    a.appendChild(g);
    frag.appendChild(a);
  });
  subList.appendChild(frag);
}

$("subClose").addEventListener("click", closeSubject);

/* ---------- Home: subject click ---------- */
$("subjects").addEventListener("click", function (e) {
  const card = e.target.closest(".card");
  if (!card) return;
  openSubject(card.dataset.subject);
});

/* ---------- Auth helper: current Firebase user (or null) ---------- */
function currentAuthUser() {
  return loadAuth().then(function (auth) {
    return new Promise(function (resolve) {
      const off = auth.onAuthStateChanged(function (u) { off(); resolve(u); });
    });
  });
}

/* ---------- My profile (edit profile + change password) ---------- */
let epPhoto = "";

function openProfile() {
  if (!user) return;
  epPhoto = "";
  const stu = user.role !== "teacher";

  $("epRole").textContent = roleText(user) + (user.email ? " • " + user.email : "");
  $("epHName").textContent = user.name || "";
  drawProfAv(user.photo || "");
  $("epName").value = user.name || "";
  $("epStuWrap").hidden = !stu;
  $("epTchWrap").hidden = stu;
  $("epSchool").value = user.school || "";
  $("epDob").value = user.dob || "";
  $("epTuition").value = user.tuition || "";
  $("epPhoto").value = "";

  $("pwWrap").hidden = user.type !== "account";
  $("epCur").value = "";
  $("epNew").value = "";
  setMsg(epMsg, "");

  profView.hidden = false;
  profView.scrollTop = 0;
  syncScroll();
}

function closeProfile() {
  profView.hidden = true;
  hideLbox();
  syncScroll();
}

// Big avatar in the profile header. Press and hold the photo to see it full size.
function drawProfAv(photo) {
  const h = $("epAv");
  h.innerHTML = "";
  h.appendChild(makeAvatar(($("epName").value || (user && user.name) || ""), photo, 84));
  h.classList.toggle("has", !!photo);
  h.dataset.photo = photo ? "1" : "";
  h._photo = photo || "";
}

const lbox = $("lbox");
let lboxTimer = 0;
function hideLbox() {
  clearTimeout(lboxTimer);
  lbox.hidden = true;
  $("lboxImg").removeAttribute("src");
}
(function () {
  const h = $("epAv");
  h.addEventListener("pointerdown", function () {
    if (!h._photo) return;
    clearTimeout(lboxTimer);
    lboxTimer = setTimeout(function () {
      $("lboxImg").src = h._photo;
      lbox.hidden = false;
    }, 300);
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach(function (ev) {
    h.addEventListener(ev, hideLbox);
  });
  lbox.addEventListener("click", hideLbox);
})();

$("profBtn").addEventListener("click", function () {
  closeMenu();
  openProfile();
});
$("profClose").addEventListener("click", closeProfile);

$("epPhoto").addEventListener("change", function () {
  const f = this.files && this.files[0];
  if (!f) return;
  if (!/^image\//.test(f.type)) {
    setMsg(epMsg, "Please choose an image file.", "err");
    return;
  }
  readPhoto(f, function (data) {
    epPhoto = data;
    drawProfAv(data);
    setMsg(epMsg, "");
  }, function () {
    setMsg(epMsg, "Could not read this image.", "err");
  });
});

function saveProfile() {
  if (!user) return;
  const name = $("epName").value.trim();
  if (name.length < 2) { setMsg(epMsg, "Please enter your full name.", "err"); return; }

  const ch = { name: name };

  if (user.role === "teacher") {
    const tuition = $("epTuition").value.trim();
    if (!tuition) { setMsg(epMsg, "Please enter your tuition name.", "err"); return; }
    ch.tuition = tuition;
  } else {
    const school = $("epSchool").value.trim();
    const dob = $("epDob").value;
    if (!school) { setMsg(epMsg, "Please enter your school name.", "err"); return; }
    if (!dob || new Date(dob) > new Date()) {
      setMsg(epMsg, "Please enter a valid date of birth.", "err");
      return;
    }
    const photo = epPhoto || user.photo || "";
    ch.school = school;
    ch.dob = dob;
    if (photo) ch.photo = photo;   // optional
  }

  const isAccount = user.type === "account";
  const role = user.role;

  // Saved on the phone first
  saveUser(Object.assign({}, user, ch));
  renderUserBox();
  $("epHName").textContent = name;
  drawProfAv(user.photo || "");
  logCache = null;

  const btn = $("epSave");
  btn.disabled = true;
  setMsg(epMsg, "Saving...", "");

  currentAuthUser()
    .then(function (u) {
      if (!u) return !isAccount;
      if (u.isAnonymous) {
        if (isAccount) return false;
        return firebase.firestore().collection("people").doc(u.uid)
          .update({ name: name.slice(0, 80) })
          .catch(function () { /* ignore */ })
          .then(function () { return true; });
      }
      const db = firebase.firestore();
      const jobs = [];
      if (isAccount) {
        jobs.push(db.collection("users").doc(u.uid).set(Object.assign({ role: role }, ch), { merge: true }));
      }
      jobs.push(db.collection("people").doc(u.uid).update({ name: name.slice(0, 80) }).catch(function () { /* ignore */ }));
      return Promise.all(jobs).then(function () { return true; });
    })
    .then(function (ok) {
      if (ok) setMsg(epMsg, "Profile saved ✓", "ok");
      else setMsg(epMsg, "Saved on this phone. Log in again to sync online.", "err");
    })
    .catch(function () {
      setMsg(epMsg, "Saved on this phone, but could not sync. Check your internet.", "err");
    })
    .then(function () { btn.disabled = false; });
}

$("epSave").addEventListener("click", saveProfile);

function changePass() {
  const cur = $("epCur").value;
  const np = $("epNew").value;
  if (!cur) { setMsg(epMsg, "Enter your current password.", "err"); return; }
  if (np.length < 6) { setMsg(epMsg, "New password must be at least 6 characters.", "err"); return; }
  if (cur === np) { setMsg(epMsg, "New password must be different.", "err"); return; }

  const btn = $("pwBtn");
  btn.disabled = true;
  setMsg(epMsg, "Updating...", "");

  currentAuthUser()
    .then(function (u) {
      if (!u || u.isAnonymous) throw { code: "auth/requires-recent-login" };
      const cred = firebase.auth.EmailAuthProvider.credential(user.email, cur);
      return u.reauthenticateWithCredential(cred).then(function () {
        return u.updatePassword(np);
      });
    })
    .then(function () {
      $("epCur").value = "";
      $("epNew").value = "";
      setMsg(epMsg, "Password changed ✓", "ok");
    })
    .catch(function (err) { authError(err, epMsg); })
    .then(function () { btn.disabled = false; });
}

$("pwBtn").addEventListener("click", changePass);

/* ---------- Submit (user): Notes / Routine / PYQ & Papers / Question Bank ---------- */
// Same information as the admin panel. Trusted users and admins publish directly,
// everyone else goes to the admin's Requests list.
let smReady = false;
let smTab = "note";
const SM_PANES = { note: "smNote", routine: "smRoutine", paper: "smPaper", qb: "smQb" };

function isLink(v) { return /^https?:\/\//i.test(v) && v.length < 500; }

// Clears cached lists so the next open shows fresh data
function afterPublish() {
  subCache = {};
  rtCache = {};
  ppCache = {};
  notesCache = null;
  adminRoutines = null;
  adminPapers = null;
  logCache = null;
  actUsers = null;
  lsBust();
}

// One published item (what students see) built from a submission or a form
function buildPublic(e, uid, name) {
  const now = Date.now();
  const k = e.kind || "note";
  let col;
  let doc;

  if (k === "routine") {
    col = "routines";
    doc = {
      kind: e.rKind, group: e.rGroup || "", gender: e.rGender || "",
      day: e.rDay, time: e.rTime, subject: e.rSubject, ts: now
    };
  } else if (k === "paper") {
    col = "papers";
    doc = { type: e.paperType, subject: e.subject, title: e.title, marks: e.marks, link: e.link, ts: now };
  } else if (k === "qb") {
    col = "papers";
    doc = { type: e.qbType, subject: e.subject, title: e.title, marks: 0, link: e.link, ts: now };
    if (e.qbNo > 0) doc.no = e.qbNo;
  } else {
    col = "notes";
    doc = {
      subject: e.subject, type: e.type, link: e.link,
      chapterName: e.chapterName || "", chapterNo: e.chapterNo || 0, topicName: e.topicName || "",
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };
  }
  if (uid) doc.uid = uid;
  if (name) doc.by = String(name).slice(0, 80);
  return { col: col, doc: doc };
}

function sendEntry(entry, btn, reset) {
  // Only registered accounts can submit (database rules)
  if (!user || user.type === "guest") {
    setMsg(smMsg, "Guests cannot submit. Please register with your email.", "err");
    return;
  }

  const by = {
    name: (user.name || "Unknown").slice(0, 80),
    role: user.role === "teacher" ? "teacher" : "student",
    email: user.email || "",
    guest: false
  };
  if (user.school) by.school = user.school;
  if (user.tuition) by.tuition = user.tuition;

  if (navigator.onLine === false) { setMsg(smMsg, NET_MSG, "err"); return; }

  btn.disabled = true;
  setMsg(smMsg, "Submitting...", "");

  let direct = false;
  let uid = "";

  currentAuthUser()
    .then(function (u) {
      if (!u || u.isAnonymous) throw { code: "nosession" };
      uid = u.uid;
      const db = firebase.firestore();
      const yes = function (d) { return d.exists; };
      const no = function () { return false; };
      return Promise.all([
        db.collection("trusted").doc(uid).get().then(yes, no),
        db.collection("admins").doc(uid).get().then(yes, no)
      ]);
    })
    .then(function (r) {
      direct = r[0] || r[1];
      const db = firebase.firestore();
      if (direct) {
        const x = buildPublic(entry, uid, by.name);
        return db.collection(x.col).add(x.doc);
      }
      return db.collection("submissions").add(
        Object.assign({ status: "pending", ts: Date.now(), uid: uid, by: by }, entry)
      );
    })
    .then(function () {
      reset();
      if (direct) afterPublish();
      setMsg(smMsg, direct
        ? "Published ✓ It is live now."
        : "Submitted ✓ It will go live after admin approval.", "ok");
    })
    .catch(function (err) {
      if (err && err.code === "nosession") {
        setMsg(smMsg, "Session ended. Please log out and log in again, then submit.", "err");
      } else if (err && err.code === "permission-denied") {
        setMsg(smMsg, "Not allowed. Please log out and log in again.", "err");
      } else {
        setMsg(smMsg, "Could not submit. Check your internet and try again.", "err");
      }
    })
    .then(function () { btn.disabled = false; });
}

/* --- tabs --- */
function setSmTab(t) {
  smTab = t;
  Object.keys(SM_PANES).forEach(function (k) { $(SM_PANES[k]).hidden = k !== t; });
  const all = $("smTabs").children;
  for (let i = 0; i < all.length; i++) {
    all[i].classList.toggle("on", all[i].dataset.t === t);
  }
  $("smGuide").hidden = t === "routine";
  setMsg(smMsg, "");
}

$("smTabs").addEventListener("click", function (e) {
  const b = e.target.closest(".tab");
  if (b) setSmTab(b.dataset.t);
});

function openSubmit(tab) {
  if (!smReady) {
    fillSubjects($("smSubject"), false);
    fillSubjects($("smPSubject"), false);
    fillSubjects($("smQSubject"), false);
    smSetTypes();
    smRoutineGroups();
    smReady = true;
  }
  smView.hidden = false;
  smView.scrollTop = 0;
  setSmTab(tab || smTab);
  if (!user || user.type === "guest") {
    setMsg(smMsg, "Guests cannot submit. Please register with your email.", "err");
  }
  syncScroll();
}

function closeSubmit() {
  smView.hidden = true;
  syncScroll();
}

$("smClose").addEventListener("click", closeSubmit);

/* --- Drive link guide: Bengali / English --- */
function setGuide(lang) {
  $("gBn").hidden = lang !== "bn";
  $("gEn").hidden = lang !== "en";
  $("gTabBn").classList.toggle("on", lang === "bn");
  $("gTabEn").classList.toggle("on", lang === "en");
}
$("gTabBn").addEventListener("click", function () { setGuide("bn"); });
$("gTabEn").addEventListener("click", function () { setGuide("en"); });

/* --- Notes --- */
function smSetTypes() {
  const sel = $("smType");
  const prev = sel.value;
  const subject = $("smSubject").value;
  sel.innerHTML = "";

  const list = [
    { v: "chapter", t: "Chapter" },
    { v: "topic", t: "Topic" }
  ];
  if (GRAMMAR[subject]) list.push({ v: "grammar", t: GRAMMAR[subject] });

  list.forEach(function (x) {
    const o = document.createElement("option");
    o.value = x.v;
    o.textContent = x.t;
    sel.appendChild(o);
  });

  const stillThere = list.some(function (x) { return x.v === prev; });
  sel.value = stillThere ? prev : "chapter";
  smToggleType();
}

function smToggleType() {
  const t = $("smType").value;
  $("smChapter").hidden = t !== "chapter";
  $("smTopicWrap").hidden = t === "chapter";
  $("smLblTopic").textContent = t === "grammar" ? "Grammar topic name" : "Topic name";
}

$("smSubject").addEventListener("change", smSetTypes);
$("smType").addEventListener("change", smToggleType);

function submitNote() {
  const type = $("smType").value;
  const link = $("smLink").value.trim();
  const e = {
    kind: "note", subject: $("smSubject").value, type: type, link: link,
    chapterName: "", chapterNo: 0, topicName: ""
  };

  if (type === "chapter") {
    const name = $("smChName").value.trim().slice(0, 140);
    const no = parseInt($("smChNo").value, 10);
    if (!name) { setMsg(smMsg, "Please enter the chapter name.", "err"); return; }
    if (!no || no < 1) { setMsg(smMsg, "Please enter the chapter number.", "err"); return; }
    e.chapterName = name;
    e.chapterNo = no;
  } else {
    const topic = $("smTopic").value.trim().slice(0, 140);
    if (!topic) { setMsg(smMsg, "Please enter the topic name.", "err"); return; }
    e.topicName = topic;
  }
  if (!isLink(link)) {
    setMsg(smMsg, "Please enter a valid Google Drive link (https://...).", "err");
    return;
  }

  sendEntry(e, $("smBtn"), function () {
    $("smChName").value = "";
    $("smChNo").value = "";
    $("smTopic").value = "";
    $("smLink").value = "";
  });
}

$("smBtn").addEventListener("click", submitNote);

/* --- Routine --- */
function smRoutineGroups() {
  const kind = $("smRKind").value;
  const groups = KIND_GROUPS[kind];
  const sel = $("smRGroup");
  const prev = sel.value;
  sel.innerHTML = "";

  groups.forEach(function (g) {
    const o = document.createElement("option");
    o.value = g.v;
    o.textContent = g.t;
    sel.appendChild(o);
  });
  if (groups.some(function (g) { return g.v === prev; })) sel.value = prev;

  $("smRGroupWrap").hidden = groups.length === 0;
  smRoutineGender();
}

function smRoutineGender() {
  $("smRGenderWrap").hidden = !($("smRKind").value === "exam" && $("smRGroup").value === "school");
}

$("smRKind").addEventListener("change", smRoutineGroups);
$("smRGroup").addEventListener("change", smRoutineGender);

function submitRoutine() {
  const kind = $("smRKind").value;
  const day = $("smRDay").value.trim().slice(0, 90);
  const time = $("smRTime").value.trim().slice(0, 90);
  const subject = $("smRSubject").value.trim().slice(0, 90);

  if (!day) { setMsg(smMsg, "Please enter the day / date.", "err"); return; }
  if (!time) { setMsg(smMsg, "Please enter the time.", "err"); return; }
  if (!subject) { setMsg(smMsg, "Please enter the subject.", "err"); return; }

  const group = KIND_GROUPS[kind].length ? $("smRGroup").value : "";
  const gender = (kind === "exam" && group === "school") ? $("smRGender").value : "";

  sendEntry({
    kind: "routine", rKind: kind, rGroup: group, rGender: gender,
    rDay: day, rTime: time, rSubject: subject
  }, $("smRBtn"), function () {
    $("smRDay").value = "";
    $("smRTime").value = "";
    $("smRSubject").value = "";
  });
}

$("smRBtn").addEventListener("click", submitRoutine);

/* --- PYQ & Papers --- */
function submitPaper() {
  const title = $("smPTitle").value.trim().slice(0, 190);
  const marks = parseInt($("smPMarks").value, 10);
  const link = $("smPLink").value.trim();

  if (!title) { setMsg(smMsg, "Please enter the paper title.", "err"); return; }
  if (!marks || marks < 1) { setMsg(smMsg, "Please enter the marks.", "err"); return; }
  if (!isLink(link)) { setMsg(smMsg, "Please enter a valid link (https://...).", "err"); return; }

  sendEntry({
    kind: "paper", paperType: $("smPType").value, subject: $("smPSubject").value,
    title: title, marks: marks, link: link
  }, $("smPBtn"), function () {
    $("smPTitle").value = "";
    $("smPMarks").value = "";
    $("smPLink").value = "";
  });
}

$("smPBtn").addEventListener("click", submitPaper);

/* --- Question Bank --- */
function qbNoLabel(type) {
  return type === "suggestion" ? "Chapter number" : "Model paper number";
}

function syncQbNo(typeId, lblId) {
  $(lblId).textContent = qbNoLabel($(typeId).value);
}
$("smQType").addEventListener("change", function () { syncQbNo("smQType", "smQNoLbl"); });

function submitQb() {
  const title = $("smQTitle").value.trim().slice(0, 190);
  const link = $("smQLink").value.trim();
  const no = parseInt($("smQNo").value, 10);

  if (!title) { setMsg(smMsg, "Please enter the title.", "err"); return; }
  if (!no || no < 1) { setMsg(smMsg, "Please enter the " + qbNoLabel($("smQType").value).toLowerCase() + ".", "err"); return; }
  if (!isLink(link)) { setMsg(smMsg, "Please enter a valid link (https://...).", "err"); return; }

  sendEntry({
    kind: "qb", qbType: $("smQType").value, subject: $("smQSubject").value,
    title: title, link: link, qbNo: no
  }, $("smQBtn"), function () {
    $("smQTitle").value = "";
    $("smQLink").value = "";
    $("smQNo").value = "";
  });
}

$("smQBtn").addEventListener("click", submitQb);

/* ---------- Routine page (student) ---------- */
let rtKey = null;
let rtTab = null;
let rtCache = {};
const rtList = $("rtList");
const rtTabs = $("rtTabs");

function openRoutine(key) {
  const view = VIEWS[key];
  if (!view) return;
  rtKey = key;
  rtTab = view.tabs.length ? view.tabs[0].key : null;
  $("rtTitle").textContent = view.title;
  buildRtTabs();
  rtView.hidden = false;
  rtView.scrollTop = 0;
  syncScroll();
  afterPaint(function () { if (rtKey === key) loadRoutine(view.kind); });
}

function closeRoutine() {
  rtView.hidden = true;
  rtKey = null;
  syncScroll();
}

function buildRtTabs() {
  rtTabs.innerHTML = "";
  const tabs = VIEWS[rtKey].tabs;
  const frag = document.createDocumentFragment();
  tabs.forEach(function (t) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tab" + (t.key === rtTab ? " on" : "");
    b.dataset.key = t.key;
    b.textContent = t.label;
    frag.appendChild(b);
  });
  rtTabs.appendChild(frag);
}

rtTabs.addEventListener("click", function (e) {
  const b = e.target.closest(".tab");
  if (!b) return;
  rtTab = b.dataset.key;
  const all = rtTabs.children;
  for (let i = 0; i < all.length; i++) {
    all[i].classList.toggle("on", all[i] === b);
  }
  renderRoutine();
});

function loadRoutine(kind) {
  if (rtCache[kind]) { renderRoutine(); return; }

  const saved = lsGet("r_" + kind);
  if (saved) {
    rtCache[kind] = saved;
    renderRoutine();
    if (navigator.onLine === false || lsFresh("r_" + kind, 60000)) return;
  } else {
    emptyText(rtList, "Loading...");
  }

  readCol({ col: "routines", where: ["kind", kind], limit: 300 })
    .then(function (arr) {
      arr.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
      rtCache[kind] = arr;
      lsSet("r_" + kind, arr);
      if (rtKey && VIEWS[rtKey].kind === kind) renderRoutine();
    })
    .catch(function () {
      if (!saved && rtKey && VIEWS[rtKey].kind === kind) {
        errorText(rtList, offlineText(), function () { loadRoutine(kind); });
      }
    });
}

function renderRoutine() {
  const view = VIEWS[rtKey];
  const all = rtCache[view.kind] || [];

  let tabDef = null;
  for (let i = 0; i < view.tabs.length; i++) {
    if (view.tabs[i].key === rtTab) { tabDef = view.tabs[i]; break; }
  }

  const group = (tabDef && tabDef.group) || view.group || "";
  const gender = (tabDef && tabDef.gender) || "";

  const items = all.filter(function (r) {
    if (group && r.group !== group) return false;
    if (gender && r.gender !== gender) return false;
    return true;
  });

  if (!items.length) {
    emptyText(rtList, "No routine yet");
    return;
  }

  const wrap = document.createElement("div");
  wrap.className = "rtable";
  const table = document.createElement("table");

  const head = document.createElement("tr");
  ["Day/Date", "Time", "Subject"].forEach(function (h) {
    const th = document.createElement("th");
    th.textContent = h;
    head.appendChild(th);
  });
  const thead = document.createElement("thead");
  thead.appendChild(head);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  items.forEach(function (r) {
    const tr = document.createElement("tr");

    const d = document.createElement("td");
    d.textContent = r.day;
    const t = document.createElement("td");
    t.textContent = r.time;
    const s = document.createElement("td");
    s.className = "tsub";
    s.textContent = r.subject;
    const bl = byLine(r.by);
    if (bl) s.appendChild(bl);

    tr.appendChild(d);
    tr.appendChild(t);
    tr.appendChild(s);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);

  rtList.innerHTML = "";
  rtList.appendChild(wrap);
}

$("rtClose").addEventListener("click", closeRoutine);

/* ---------- Activity: Recent (what was published, by whom, when) + Users ---------- */
// Light by design: a few small reads, the last result is shown instantly from the
// phone, and a user's uploads load only when you tap View.
let usersCache = null;   // { arr, t }  people list (admin Users tab)
let logCache = null;     // { arr, t }  recently published items
let actUsers = null;     // { arr, t }  people + Admin / Trusted badges
const actList = $("actList");

// People list used by the admin Users tab
function loadPeople(force, cb) {
  if (usersCache && !force && Date.now() - usersCache.t < 30000) { cb(true); return; }
  readCol({ col: "people", order: "ts", desc: true, limit: 300 })
    .then(function (arr) {
      usersCache = { arr: arr, t: Date.now() };
      cb(true);
    })
    .catch(function () { cb(false); });
}

// " • Chapter 3" / " • Paper 2" for Question Bank items
function noText(p) {
  if (!p || !p.no || !QB_TYPES[p.type]) return "";
  return " • " + (p.type === "suggestion" ? "Chapter " : "Paper ") + p.no;
}

// Number order (1, 2, 3...). Items without a number go last, newest first.
function byNo(a, b) {
  const x = a.no > 0 ? a.no : 1e9;
  const y = b.no > 0 ? b.no : 1e9;
  return x !== y ? x - y : (b.ts || 0) - (a.ts || 0);
}

// One published item in a common shape (note / routine / paper / question bank)
function toItem(k, d) {
  if (k === "note") {
    return {
      ico: "📝", cat: "note", label: "Note", title: noteTitle(d), sub: subjectName(d.subject),
      ms: d.createdAt || 0, by: typeof d.by === "string" ? d.by : "", link: d.link || ""
    };
  }
  if (k === "routine") {
    return {
      ico: "🗓️", cat: "routine", label: "Routine", title: d.subject + " • " + d.day + " • " + d.time,
      sub: routineLabel(d), ms: d.ts || 0, by: typeof d.by === "string" ? d.by : "", link: ""
    };
  }
  return {
    ico: QB_TYPES[d.type] ? "🗂️" : "📄",
    cat: QB_TYPES[d.type] ? "qb" : "paper",
    label: PAPER_TYPES[d.type] || "Paper",
    title: d.title || "Untitled",
    sub: subjectName(d.subject) + (d.marks ? " • " + d.marks + " Marks" : "") + noText(d),
    ms: d.ts || 0, by: typeof d.by === "string" ? d.by : "", link: d.link || ""
  };
}

function loadFeed(force, cb) {
  if (logCache && !force && Date.now() - logCache.t < 60000) { cb(true); return; }

  Promise.all([
    readCol({ col: "notes", order: "createdAt", desc: true, limit: 25 }),
    readCol({ col: "routines", order: "ts", desc: true, limit: 25 }),
    readCol({ col: "papers", order: "ts", desc: true, limit: 25 })
  ])
    .then(function (r) {
      const arr = [];
      r[0].forEach(function (d) { arr.push(toItem("note", d)); });
      r[1].forEach(function (d) { arr.push(toItem("routine", d)); });
      r[2].forEach(function (d) { arr.push(toItem("paper", d)); });
      arr.sort(function (a, b) { return b.ms - a.ms; });
      logCache = { arr: arr.slice(0, 60), t: Date.now() };
      lsSet("feed", logCache.arr);
      cb(true);
    })
    .catch(function () { cb(false); });
}

function renderFeed(target) {
  target = target || actList;
  target.innerHTML = "";
  const list = (logCache && logCache.arr) || [];
  if (!list.length) { emptyText(target, "No activity yet"); return; }

  const frag = document.createDocumentFragment();
  list.forEach(function (x) {
    const box = document.createElement("div");
    box.className = "note";

    const t = document.createElement("div");
    t.className = "t";
    t.textContent = x.ico + " " + x.title;

    const s = document.createElement("div");
    s.className = "s";
    s.textContent = x.label + " • " + x.sub;

    const w = document.createElement("div");
    w.className = "when";
    w.textContent = (x.by ? "Published by " + x.by : "Published") + (x.ms ? " • " + fmtFull(x.ms) : "");

    box.appendChild(t);
    box.appendChild(s);
    box.appendChild(w);
    frag.appendChild(box);
  });
  target.appendChild(frag);
}

function loadActUsers(force, cb) {
  if (actUsers && !force && Date.now() - actUsers.t < 60000) { cb(true); return; }

  Promise.all([
    readCol({ col: "people", order: "ts", desc: true, limit: 300 }),
    readCol({ col: "trusted", limit: 200 }).catch(function () { return []; }),
    readCol({ col: "public_admins", limit: 50 }).catch(function () { return []; }),
    readCol({ col: "notes", select: ["uid"], limit: 1000 }).catch(function () { return null; }),
    readCol({ col: "papers", select: ["uid", "type"], limit: 1000 }).catch(function () { return null; })
  ])
    .then(function (r) {
      const trusted = {};
      const admins = {};
      r[1].forEach(function (d) { trusted[d.id] = true; });
      r[2].forEach(function (d) { admins[d.id] = true; });

      // Uploads per user. Routines are not counted.
      const cnt = {};
      function bump(uid, key) {
        if (!uid || typeof uid !== "string") return;
        if (!cnt[uid]) cnt[uid] = { note: 0, paper: 0, qb: 0 };
        cnt[uid][key]++;
      }
      (r[3] || []).forEach(function (d) { bump(d.uid, "note"); });
      (r[4] || []).forEach(function (d) { bump(d.uid, QB_TYPES[d.type] ? "qb" : "paper"); });

      const arr = r[0].map(function (x) {
        const c = cnt[x.id] || { note: 0, paper: 0, qb: 0 };
        return {
          uid: x.id,
          name: x.name || "User",
          role: x.role,
          guest: !!x.guest,
          ts: x.ts || 0,
          trusted: !!trusted[x.id],
          admin: !!admins[x.id],
          c: c,
          total: c.note + c.paper + c.qb
        };
      });
      arr.sort(function (a, b) {
        return (b.total - a.total) || (b.admin - a.admin) || (b.trusted - a.trusted) ||
          a.name.localeCompare(b.name);
      });
      actUsers = { arr: arr, t: Date.now(), counted: !!(r[3] && r[4]) };
      cb(true);
    })
    .catch(function () { cb(false); });
}

function renderActUsers() {
  actList.innerHTML = "";
  const list = (actUsers && actUsers.arr) || [];
  if (!list.length) { emptyText(actList, "No users yet"); return; }

  const frag = document.createDocumentFragment();

  const sum = document.createElement("p");
  sum.className = "sumline";
  sum.textContent = list.length + (list.length === 1 ? " user" : " users") + " • most uploads first";
  frag.appendChild(sum);

  list.forEach(function (g, i) {
    const box = document.createElement("div");
    box.className = "note";
    box.dataset.i = i;

    const row = document.createElement("div");
    row.className = "urow";

    const rk = document.createElement("span");
    rk.className = "rk";
    rk.textContent = i + 1;

    const mid = document.createElement("div");
    mid.className = "umid";

    const t = document.createElement("div");
    t.className = "t";
    t.appendChild(document.createTextNode(g.name));
    if (user && user.uid && g.uid === user.uid) {
      const me = document.createElement("span");
      me.className = "badge you";
      me.textContent = "You";
      t.appendChild(me);
      box.classList.add("me");
    }
    if (g.admin) {
      const b = document.createElement("span");
      b.className = "badge admin";
      b.textContent = "Admin";
      t.appendChild(b);
    }
    if (g.trusted) {
      const b2 = document.createElement("span");
      b2.className = "badge trusted";
      b2.textContent = "Trusted";
      t.appendChild(b2);
    }

    const s = document.createElement("div");
    s.className = "s";
    s.textContent = (g.role === "teacher" ? "Teacher" : "Student") +
      (g.guest ? " • Guest" : "") + (g.ts ? " • Joined " + fmtFull(g.ts) : "");

    const chips = document.createElement("div");
    chips.className = "chips";
    function chip(text, zero, main) {
      const c = document.createElement("span");
      c.className = "chip" + (zero ? " zero" : "") + (main ? " main" : "");
      c.textContent = text;
      chips.appendChild(c);
    }
    if (!actUsers.counted) {
      // upload counts could not be loaded, show nothing instead of a wrong number
    } else if (!g.total) {
      chip("No uploads yet", true);
    } else {
      chip(g.total + (g.total === 1 ? " upload" : " uploads"), false, true);
      chip("Notes " + g.c.note, !g.c.note);
      chip("PYQ " + g.c.paper, !g.c.paper);
      chip("Question Bank " + g.c.qb, !g.c.qb);
    }

    mid.appendChild(t);
    mid.appendChild(s);
    mid.appendChild(chips);

    const v = document.createElement("button");
    v.type = "button";
    v.className = "view uv";
    v.textContent = "👁️ View";

    row.appendChild(rk);
    row.appendChild(mid);
    row.appendChild(v);

    const d = document.createElement("div");
    d.className = "detail";
    d.hidden = true;

    box.appendChild(row);
    box.appendChild(d);
    frag.appendChild(box);
  });
  actList.appendChild(frag);
}

// Everything one user published (3 small reads, only when View is tapped)
function loadUploads(uid, withRoutines) {
  return Promise.all([
    readCol({ col: "notes", where: ["uid", uid], limit: 100 }),
    withRoutines ? readCol({ col: "routines", where: ["uid", uid], limit: 100 }) : Promise.resolve([]),
    readCol({ col: "papers", where: ["uid", uid], limit: 100 })
  ]).then(function (r) {
    const arr = [];
    r[0].forEach(function (d) { arr.push(toItem("note", d)); });
    r[1].forEach(function (d) { arr.push(toItem("routine", d)); });
    r[2].forEach(function (d) { arr.push(toItem("paper", d)); });
    arr.sort(function (a, b) { return b.ms - a.ms; });
    return arr;
  });
}

// "Notes 3 • Routines 2 • PYQ & Papers 1 • Question Bank 1"
function uploadSummary(items) {
  const c = { note: 0, routine: 0, paper: 0, qb: 0 };
  items.forEach(function (x) { if (c[x.cat] !== undefined) c[x.cat]++; });
  return "Notes " + c.note + " • Routines " + c.routine +
    " • PYQ & Papers " + c.paper + " • Question Bank " + c.qb;
}

function uploadRow(x) {
  const el = document.createElement(x.link ? "a" : "div");
  el.className = "nlink" + (x.link ? "" : " static");
  if (x.link) {
    el.href = x.link;
    el.target = "_blank";
    el.rel = "noopener noreferrer";
  }

  const box = document.createElement("div");
  const t = document.createElement("span");
  t.className = "nt";
  t.textContent = x.title;
  const s = document.createElement("span");
  s.className = "ns";
  s.textContent = x.label + " • " + x.sub + (x.ms ? " • " + fmtFull(x.ms) : "");
  box.appendChild(t);
  box.appendChild(s);
  el.appendChild(box);

  if (x.link) {
    const g = document.createElement("span");
    g.className = "go";
    g.textContent = "View ↗";
    el.appendChild(g);
  }
  return el;
}

function showActTab(force) {
  if (actUsers && !force) renderActUsers();
  else emptyText(actList, "Loading...");

  loadActUsers(!!force, function (ok) {
    if (actView.hidden) return;
    if (ok) renderActUsers();
    else if (!actUsers) errorText(actList, offlineText(), function () { showActTab(true); });
  });
}

function openActivity() {
  actView.hidden = false;
  actView.scrollTop = 0;
  syncScroll();
  afterPaint(function () { if (!actView.hidden) showActTab(false); });
}

function closeActivity() {
  actView.hidden = true;
  syncScroll();
}

actList.addEventListener("click", function (e) {
  const b = e.target.closest(".view");
  if (!b) return;
  const box = b.closest(".note");
  const d = box && box.querySelector(".detail");
  if (!d || !actUsers) return;

  if (!d.hidden) {
    d.hidden = true;
    b.textContent = "👁️ View";
    return;
  }

  d.hidden = false;
  b.textContent = "🔼 Hide";
  if (d.firstChild) return;

  const g = actUsers.arr[parseInt(box.dataset.i, 10)];
  if (!g) return;
  const wait = document.createElement("p");
  wait.className = "hint";
  wait.textContent = "Loading...";
  d.appendChild(wait);

  loadUploads(g.uid, false)
    .then(function (items) {
      d.innerHTML = "";
      if (!items.length) {
        const p = document.createElement("p");
        p.className = "hint";
        p.textContent = "Nothing published yet.";
        d.appendChild(p);
        return;
      }
      const frag = document.createDocumentFragment();
      const sm = document.createElement("p");
      sm.className = "hint";
      sm.textContent = uploadSummary(items);
      frag.appendChild(sm);
      items.forEach(function (x) { frag.appendChild(uploadRow(x)); });
      d.appendChild(frag);
    })
    .catch(function () {
      d.innerHTML = "";
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = "Could not load. Close and try again.";
      d.appendChild(p);
    });
});

$("actClose").addEventListener("click", closeActivity);
$("actRefresh").addEventListener("click", function () { spinBtn($("actRefresh"), 900); showActTab(true); });

/* ---------- Contact Us (settings/contact, editable by admin) ---------- */
const ctBody = $("ctBody");
const CONTACT_DEFAULT = { name: "Surojit", location: "", insta: "", email: "" };

function cleanContact(x) {
  x = x || {};
  return {
    name: String(x.name || "").slice(0, 100),
    location: String(x.location || "").slice(0, 150),
    insta: String(x.insta || "").slice(0, 150),
    email: String(x.email || "").slice(0, 150)
  };
}

function fetchContact() {
  return readDoc("settings", "contact").then(function (d) {
    return d ? cleanContact(d) : cleanContact(CONTACT_DEFAULT);
  });
}

function instaUrl(v) {
  if (/^https?:\/\//i.test(v)) return v;
  return "https://instagram.com/" + encodeURIComponent(v.replace(/^@/, "").trim());
}

const CT_ICONS = {
  pin: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></svg>',
  insta: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none"/></svg>',
  mail: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>'
};

function contactRow(kind, label, value, href) {
  const a = document.createElement("a");
  a.className = "crow " + kind;
  a.href = href;
  if (href.indexOf("mailto:") !== 0) {
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  }

  const ico = document.createElement("span");
  ico.className = "cico";
  ico.innerHTML = CT_ICONS[kind];   // fixed icon markup, no user text

  const mid = document.createElement("span");
  mid.className = "cmid";
  const l = document.createElement("span");
  l.className = "clab";
  l.textContent = label;
  const v = document.createElement("span");
  v.className = "cval";
  v.textContent = value;
  mid.appendChild(l);
  mid.appendChild(v);

  const go = document.createElement("span");
  go.className = "cgo";
  go.textContent = "›";

  a.appendChild(ico);
  a.appendChild(mid);
  a.appendChild(go);
  return a;
}

function renderContact(c) {
  if (ctView.hidden) return;
  ctBody.innerHTML = "";

  if (!c.name && !c.location && !c.insta && !c.email) {
    emptyText(ctBody, "Contact details are not added yet.");
    return;
  }

  const frag = document.createDocumentFragment();

  const head = document.createElement("div");
  head.className = "chead";
  const av = document.createElement("div");
  av.className = "cav";
  av.textContent = (c.name || "E").charAt(0).toUpperCase();
  const nm = document.createElement("div");
  nm.className = "cname";
  nm.textContent = c.name || "EduZone";
  const rl = document.createElement("div");
  rl.className = "crole";
  rl.textContent = "Developer of EduZone";
  head.appendChild(av);
  head.appendChild(nm);
  head.appendChild(rl);
  frag.appendChild(head);

  const list = document.createElement("div");
  list.className = "clist";
  if (c.location) {
    list.appendChild(contactRow("pin", "Location", c.location,
      "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(c.location)));
  }
  if (c.insta) {
    const shown = /^https?:\/\//i.test(c.insta) ? c.insta : "@" + c.insta.replace(/^@/, "");
    list.appendChild(contactRow("insta", "Instagram", shown, instaUrl(c.insta)));
  }
  if (c.email) {
    list.appendChild(contactRow("mail", "Gmail", c.email, "mailto:" + c.email));
  }
  frag.appendChild(list);

  const note = document.createElement("p");
  note.className = "cnote";
  note.textContent = "Feel free to reach out for feedback, suggestions or any help.";
  frag.appendChild(note);

  ctBody.appendChild(frag);
}

function openContact() {
  ctView.hidden = false;
  ctView.scrollTop = 0;
  syncScroll();

  const saved = lsGet("contact");
  if (saved) {
    renderContact(saved);
    if (navigator.onLine === false || lsFresh("contact", 60000)) return;
  } else {
    emptyText(ctBody, "Loading...");
  }

  fetchContact()
    .then(function (c) {
      lsSet("contact", c);
      renderContact(c);
    })
    .catch(function () {
      if (!saved && !ctView.hidden) errorText(ctBody, offlineText(), openContact);
    });
}

function closeContact() {
  ctView.hidden = true;
  syncScroll();
}

$("ctClose").addEventListener("click", closeContact);

/* ---------- Admin: open / close ---------- */
let isAdmin = false;
let formReady = false;
let adminBusy = false;
let adminNoted = false;

// Server-side check: does admins/{uid} exist?
function checkAdmin(u) {
  return firebase.firestore().collection("admins").doc(u.uid).get()
    .then(function (d) { return d.exists; });
}

function enterPanel() {
  panel.hidden = false;
  syncScroll();
  showMsg("");
  showDash();
}

// No email / password here. If the logged-in account is an admin, the panel
// opens. If not, it does not open. After the first successful check the panel
// opens instantly and is verified again in the background.
function openPanel() {
  if (isAdmin) { enterPanel(); return; }

  if (!user || user.type === "guest") {
    toast("Admin access only.");
    return;
  }
  if (navigator.onLine === false) {
    toast("You are offline.");
    return;
  }
  if (adminBusy) return;
  adminBusy = true;

  let fast = false;
  try { fast = localStorage.getItem("ez_adm") === "1"; } catch (e) { fast = false; }

  if (fast) {
    isAdmin = true;
    enterPanel();
  } else {
    toast("Checking admin access...", true);
  }

  withTimeout(
    currentAuthUser().then(function (u) {
      if (!u || u.isAnonymous) return false;
      return checkAdmin(u).then(function (ok) {
        // Public admin list (powers the Admin badge in Activity)
        if (ok && !adminNoted) {
          adminNoted = true;
          firebase.firestore().collection("public_admins").doc(u.uid)
            .set({ name: (user && user.name) || "Admin", ts: Date.now() })
            .then(function () { logCache = null; }, function () { /* ignore */ });
        }
        return ok;
      });
    }),
    25000
  )
    .then(function (ok) {
      adminBusy = false;
      if (ok) {
        try { localStorage.setItem("ez_adm", "1"); } catch (e) { /* ignore */ }
        if (!isAdmin) {
          isAdmin = true;
          hideToast();
          enterPanel();
        }
      } else {
        isAdmin = false;
        try { localStorage.removeItem("ez_adm"); } catch (e) { /* ignore */ }
        closePanel();
        toast("Admin access only. Log in with an admin account.");
      }
    })
    .catch(function () {
      adminBusy = false;
      if (!fast) toast("Could not check. Check your internet and try again.");
    });
}

// Leaving the admin panel only forgets admin-only data (the account stays logged in)
function closePanel() {
  if (panel.hidden) return;
  panel.hidden = true;
  syncScroll();

  if (editingId) resetForm();
  notesCache = null;
  reqCache = null;
  adminRoutines = null;
  adminPapers = null;
  usersCache = null;
  usSel = null;
}

$("closeBtn").addEventListener("click", closePanel);

function showDash() {
  if (!formReady) {
    fillSubjects($("fSubject"), false);
    fillSubjects($("mFilter"), true);
    setTypeOptions();
    setRoutineGroups();
    formReady = true;
  }
  switchTab("upload");
}

/* ---------- Admin tabs ---------- */
function switchTab(name) {
  $("uploadView").hidden = name !== "upload";
  $("manageView").hidden = name !== "manage";
  $("requestsView").hidden = name !== "requests";
  $("recentView").hidden = name !== "recent";
  $("routineView").hidden = name !== "routine";
  $("papersView").hidden = name !== "papers";
  $("qbView").hidden = name !== "qb";
  $("usersView").hidden = name !== "users";
  $("contactView").hidden = name !== "contact";
  $("tabUpload").classList.toggle("on", name === "upload");
  $("tabManage").classList.toggle("on", name === "manage");
  $("tabRequests").classList.toggle("on", name === "requests");
  $("tabRecent").classList.toggle("on", name === "recent");
  $("tabRoutine").classList.toggle("on", name === "routine");
  $("tabPapers").classList.toggle("on", name === "papers");
  $("tabQb").classList.toggle("on", name === "qb");
  $("tabUsers").classList.toggle("on", name === "users");
  $("tabContact").classList.toggle("on", name === "contact");
  showMsg("");
  if (name === "manage") loadNotes();
  if (name === "requests") loadRequests();
  if (name === "recent") loadRecentTab(false);
  if (name === "routine") loadAdminRoutines();
  if (name === "papers" || name === "qb") loadAdminPapers();
  if (name === "users") loadUsersTab(false);
  if (name === "contact") loadContactAdmin();
}

$("tabUpload").addEventListener("click", function () { switchTab("upload"); });
$("tabManage").addEventListener("click", function () {
  if (editingId) resetForm();
  switchTab("manage");
});
$("tabRequests").addEventListener("click", function () {
  if (editingId) resetForm();
  switchTab("requests");
});
$("tabRoutine").addEventListener("click", function () {
  if (editingId) resetForm();
  switchTab("routine");
});
$("tabUsers").addEventListener("click", function () {
  if (editingId) resetForm();
  switchTab("users");
});
$("tabContact").addEventListener("click", function () {
  if (editingId) resetForm();
  switchTab("contact");
});
$("tabRecent").addEventListener("click", function () {
  if (editingId) resetForm();
  switchTab("recent");
});

/* ---------- Admin: Recent (who updated what + new users, kept separate) ---------- */
let rcTab = "upd";
const rcList = $("rcList");

function setRcTabUI() {
  const all = $("rcTabs").children;
  for (let i = 0; i < all.length; i++) {
    all[i].classList.toggle("on", all[i].dataset.t === rcTab);
  }
}

function renderRcUsers() {
  rcList.innerHTML = "";
  const list = (usersCache && usersCache.arr) || [];
  if (!list.length) { emptyText(rcList, "No users yet"); return; }

  const frag = document.createDocumentFragment();
  const sum = document.createElement("p");
  sum.className = "sumline";
  sum.textContent = list.length + (list.length === 1 ? " user" : " users") + " • newest first";
  frag.appendChild(sum);

  list.forEach(function (u) {
    const box = document.createElement("div");
    box.className = "note";

    const t = document.createElement("div");
    t.className = "t";
    t.textContent = u.name || "User";

    const s = document.createElement("div");
    s.className = "s";
    s.textContent = u.role === "teacher" ? "Teacher" : "Student";

    const w = document.createElement("div");
    w.className = "when";
    w.textContent = "Joined" + (u.ts ? " • " + fmtFull(u.ts) : "");

    box.appendChild(t);
    box.appendChild(s);
    box.appendChild(w);
    frag.appendChild(box);
  });
  rcList.appendChild(frag);
}

function loadRecentTab(force) {
  setRcTabUI();

  if (rcTab === "usr") {
    if (usersCache && !force) renderRcUsers();
    else emptyText(rcList, "Loading...");

    loadPeople(!!force, function (ok) {
      if ($("recentView").hidden || rcTab !== "usr") return;
      if (ok) renderRcUsers();
      else if (!usersCache) errorText(rcList, offlineText(), function () { loadRecentTab(true); });
    });
    return;
  }

  const had = !!logCache;
  if (had) renderFeed(rcList);
  else emptyText(rcList, "Loading...");

  loadFeed(!!force, function (ok) {
    if ($("recentView").hidden || rcTab !== "upd") return;
    if (ok) renderFeed(rcList);
    else if (!had) errorText(rcList, offlineText(), function () { loadRecentTab(true); });
  });
}

$("rcTabs").addEventListener("click", function (e) {
  const b = e.target.closest(".tab");
  if (!b) return;
  if (b.dataset.t === "ref") { loadRecentTab(true); return; }
  rcTab = b.dataset.t;
  loadRecentTab(false);
});

/* ---------- Admin: Contact details ---------- */
function loadContactAdmin() {
  showMsg("Loading...", "");
  fetchContact()
    .then(function (c) {
      $("cName").value = c.name;
      $("cLoc").value = c.location;
      $("cInsta").value = c.insta;
      $("cMail").value = c.email;
      showMsg("");
    })
    .catch(function () { showMsg("Could not load. Check rules and internet.", "err"); });
}

function saveContact() {
  const c = cleanContact({
    name: $("cName").value.trim(),
    location: $("cLoc").value.trim(),
    insta: $("cInsta").value.trim(),
    email: $("cMail").value.trim()
  });
  if (!c.name) { showMsg("Enter the name.", "err"); return; }
  if (c.email && !validEmail(c.email)) { showMsg("Enter a valid Gmail address.", "err"); return; }

  const btn = $("cSave");
  btn.disabled = true;
  showMsg("Saving...", "");

  loadFirebase()
    .then(function (db) { return db.collection("settings").doc("contact").set(c); })
    .then(function () {
      lsSet("contact", c);
      showMsg("Contact details saved ✓", "ok");
    })
    .catch(function () { showMsg("Could not save. Check rules and internet.", "err"); })
    .then(function () { btn.disabled = false; });
}

$("cSave").addEventListener("click", saveContact);

/* ---------- Upload note form ---------- */
let editingId = null;

// Who is uploading (saved on every item, shown as "Contributed by ...")
function adminWho() {
  return currentAuthUser().then(function (u) {
    return {
      uid: u ? u.uid : "",
      by: String((user && user.name) || "Admin").slice(0, 80)
    };
  });
}

function setTypeOptions() {
  const sel = $("fType");
  const prev = sel.value;
  const subject = $("fSubject").value;
  sel.innerHTML = "";

  const list = [
    { v: "chapter", t: "Chapter" },
    { v: "topic", t: "Topic" }
  ];
  if (GRAMMAR[subject]) list.push({ v: "grammar", t: GRAMMAR[subject] });

  list.forEach(function (x) {
    const o = document.createElement("option");
    o.value = x.v;
    o.textContent = x.t;
    sel.appendChild(o);
  });

  const stillThere = list.some(function (x) { return x.v === prev; });
  sel.value = stillThere ? prev : "chapter";
  toggleType();
}

function toggleType() {
  const t = $("fType").value;
  const isChapter = t === "chapter";
  $("chapterFields").hidden = !isChapter;
  $("topicFields").hidden = isChapter;
  $("lblTopic").textContent = t === "grammar" ? "Grammar topic name" : "Topic name";
}

$("fSubject").addEventListener("change", setTypeOptions);
$("fType").addEventListener("change", toggleType);

function resetForm() {
  editingId = null;
  $("fSubject").selectedIndex = 0;
  setTypeOptions();
  $("fType").value = "chapter";
  $("fChName").value = "";
  $("fChNo").value = "";
  $("fTopic").value = "";
  $("fLink").value = "";
  $("saveBtn").textContent = "Upload Note";
  $("editFlag").hidden = true;
  $("cancelEdit").hidden = true;
  toggleType();
}

$("cancelEdit").addEventListener("click", function () {
  resetForm();
  switchTab("manage");
});

function saveNote() {
  const type = $("fType").value;
  const link = $("fLink").value.trim();

  const data = {
    subject: $("fSubject").value,
    type: type,
    link: link
  };

  if (type === "chapter") {
    const name = $("fChName").value.trim();
    const no = parseInt($("fChNo").value, 10);
    if (!name) { showMsg("Enter the chapter name.", "err"); return; }
    if (!no || no < 1) { showMsg("Enter the chapter number.", "err"); return; }
    data.chapterName = name;
    data.chapterNo = no;
    data.topicName = "";
  } else {
    const topic = $("fTopic").value.trim();
    if (!topic) {
      showMsg(type === "grammar" ? "Enter the grammar topic name." : "Enter the topic name.", "err");
      return;
    }
    data.topicName = topic;
    data.chapterName = "";
    data.chapterNo = 0;
  }

  if (!/^https?:\/\//i.test(link)) {
    showMsg("Enter a valid Google Drive link (https://...).", "err");
    return;
  }

  const btn = $("saveBtn");
  btn.disabled = true;
  showMsg("Saving...", "");

  loadFirebase()
    .then(function (db) {
      const col = db.collection("notes");
      if (editingId) {
        data.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
        return col.doc(editingId).update(data).then(function () { return "updated"; });
      }
      return adminWho().then(function (w) {
        data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
        if (w.uid) data.uid = w.uid;
        data.by = w.by;
        return col.add(data).then(function () { return "added"; });
      });
    })
    .then(function (result) {
      const wasEditing = result === "updated";
      resetForm();
      notesCache = null;
      subCache = {};
      logCache = null;
      lsBust();
      showMsg(wasEditing ? "Note updated ✓" : "Note uploaded ✓", "ok");
      if (wasEditing) switchTab("manage");
    })
    .catch(function () { showMsg("Could not save. Check rules and internet.", "err"); })
    .then(function () { btn.disabled = false; });
}

$("saveBtn").addEventListener("click", saveNote);

/* ---------- Manage notes ---------- */
let notesCache = null;
const listEl = $("noteList");

function loadNotes() {
  if (notesCache) { renderNotes(); return; }
  emptyText(listEl, "Loading...");

  loadFirebase()
    .then(function (db) {
      return withTimeout(db.collection("notes").orderBy("createdAt", "desc").limit(200).get(), 15000);
    })
    .then(function (snap) {
      notesCache = [];
      snap.forEach(function (d) {
        const n = d.data();
        n.id = d.id;
        notesCache.push(n);
      });
      renderNotes();
    })
    .catch(function () {
      errorText(listEl, "Could not load notes. Check rules and internet.", loadNotes);
    });
}

function makeActs(withEdit) {
  const acts = document.createElement("div");
  acts.className = "acts";
  if (withEdit) {
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "edit";
    edit.textContent = "✏️ Edit";
    acts.appendChild(edit);
  }
  const del = document.createElement("button");
  del.type = "button";
  del.className = "del";
  del.textContent = "🗑️ Delete";
  acts.appendChild(del);
  return acts;
}

function renderNotes() {
  const filter = $("mFilter").value;
  listEl.innerHTML = "";
  const items = (notesCache || []).filter(function (n) {
    return filter === "all" || n.subject === filter;
  });

  if (!items.length) {
    emptyText(listEl, "No notes");
    return;
  }
  // Subject by subject, chapters in number order (1, 2, 3...), then topic / grammar notes
  items.sort(function (a, b) {
    const sa = subjectIndex(a.subject);
    const sb = subjectIndex(b.subject);
    if (sa !== sb) return sa - sb;
    const ca = a.type === "chapter" ? 0 : 1;
    const cb = b.type === "chapter" ? 0 : 1;
    if (ca !== cb) return ca - cb;
    if (ca === 0) return (a.chapterNo || 0) - (b.chapterNo || 0);
    return 0;
  });

  const frag = document.createDocumentFragment();
  items.forEach(function (n) {
    const box = document.createElement("div");
    box.className = "note";
    box.dataset.id = n.id;

    const t = document.createElement("div");
    t.className = "t";
    t.textContent = noteTitle(n);

    const s = document.createElement("div");
    s.className = "s";
    const ms = n.createdAt && n.createdAt.toMillis ? n.createdAt.toMillis() : 0;
    s.textContent = subjectName(n.subject) +
      (typeof n.by === "string" && n.by ? " • by " + n.by : "") +
      (ms ? " • " + fmtFull(ms) : "");

    box.appendChild(t);
    box.appendChild(s);
    box.appendChild(makeActs(true));
    frag.appendChild(box);
  });
  listEl.appendChild(frag);
}

$("mFilter").addEventListener("change", renderNotes);

function findNote(id) {
  for (let i = 0; i < notesCache.length; i++) {
    if (notesCache[i].id === id) return notesCache[i];
  }
  return null;
}

listEl.addEventListener("click", function (e) {
  const box = e.target.closest(".note");
  if (!box || !notesCache) return;
  const id = box.dataset.id;

  if (e.target.closest(".edit")) {
    const n = findNote(id);
    if (!n) return;
    editingId = id;
    switchTab("upload");
    $("fSubject").value = n.subject;
    setTypeOptions();
    $("fType").value = n.type;
    $("fChName").value = n.chapterName || "";
    $("fChNo").value = n.chapterNo || "";
    $("fTopic").value = n.topicName || "";
    $("fLink").value = n.link || "";
    $("saveBtn").textContent = "Update Note";
    $("editFlag").hidden = false;
    $("cancelEdit").hidden = false;
    toggleType();
    return;
  }

  if (e.target.closest(".del")) {
    askConfirm("Delete this note?", "This note will be removed for everyone. This cannot be undone.", "Delete", true)
      .then(function (ok) {
        if (!ok) return;
        loadFirebase()
          .then(function (db) { return db.collection("notes").doc(id).delete(); })
          .then(function () {
            notesCache = notesCache.filter(function (n) { return n.id !== id; });
            subCache = {};
            logCache = null;
            lsBust();
            box.remove();
            if (!listEl.children.length) renderNotes();
            showMsg("Note deleted ✓", "ok");
          })
          .catch(function () { showMsg("Could not delete. Check rules and internet.", "err"); });
      });
  }
});

/* ---------- Admin: Requests (notes, routines, papers, question bank) ---------- */
let reqCache = null;
const reqList = $("reqList");
const KIND_LABEL = { note: "Note", routine: "Routine", paper: "PYQ & Papers", qb: "Question Bank" };

function loadRequests() {
  if (reqCache) { renderRequests(); return; }
  emptyText(reqList, "Loading...");

  loadFirebase()
    .then(function (db) {
      return withTimeout(db.collection("submissions").where("status", "==", "pending").limit(100).get(), 15000);
    })
    .then(function (snap) {
      reqCache = [];
      snap.forEach(function (d) {
        const r = d.data();
        r.id = d.id;
        reqCache.push(r);
      });
      reqCache.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
      renderRequests();
    })
    .catch(function () {
      errorText(reqList, "Could not load requests. Check rules and internet.", loadRequests);
    });
}

function findReq(id) {
  for (let i = 0; i < reqCache.length; i++) {
    if (reqCache[i].id === id) return reqCache[i];
  }
  return null;
}

function addLine(parent, label, value) {
  if (!value) return;
  const row = document.createElement("div");
  const b = document.createElement("b");
  b.textContent = label + ": ";
  row.appendChild(b);
  row.appendChild(document.createTextNode(value));
  parent.appendChild(row);
}

function addLinkLine(parent, url) {
  const row = document.createElement("div");
  const b = document.createElement("b");
  b.textContent = "Link: ";
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = "Open link ↗";
  row.appendChild(b);
  row.appendChild(a);
  parent.appendChild(row);
}

function reqKind(r) { return r.kind || "note"; }

function reqTitle(r) {
  const k = reqKind(r);
  if (k === "note") return noteTitle(r);
  if (k === "routine") return (r.rSubject || "") + " • " + (r.rDay || "") + " • " + (r.rTime || "");
  return r.title || "Untitled";
}

function reqRoutineLabel(r) {
  return routineLabel({ kind: r.rKind, group: r.rGroup, gender: r.rGender });
}

function reqSub(r) {
  const k = reqKind(r);
  let s = KIND_LABEL[k] || k;
  if (k === "routine") s += " • " + reqRoutineLabel(r);
  else s += " • " + subjectName(r.subject);
  if (k === "paper") s += " • " + (PAPER_TYPES[r.paperType] || "");
  if (k === "qb") s += " • " + (QB_TYPES[r.qbType] || "");
  return s;
}

function buildDetail(r) {
  const d = document.createElement("div");
  d.className = "detail";
  d.hidden = true;

  const k = reqKind(r);
  const by = r.by || {};

  if (k === "note") {
    addLine(d, "Subject", subjectName(r.subject));
    addLine(d, "Type", r.type === "chapter" ? "Chapter" : (r.type === "grammar" ? "Grammar" : "Topic"));
    if (r.type === "chapter") addLine(d, "Chapter", r.chapterNo + " - " + r.chapterName);
    else addLine(d, "Topic", r.topicName);
  } else if (k === "routine") {
    addLine(d, "Routine", reqRoutineLabel(r));
    addLine(d, "Day / Date", r.rDay);
    addLine(d, "Time", r.rTime);
    addLine(d, "Subject", r.rSubject);
  } else if (k === "paper") {
    addLine(d, "Type", PAPER_TYPES[r.paperType]);
    addLine(d, "Subject", subjectName(r.subject));
    addLine(d, "Title", r.title);
    addLine(d, "Marks", r.marks ? String(r.marks) : "");
  } else {
    addLine(d, "Type", QB_TYPES[r.qbType]);
    addLine(d, "Subject", subjectName(r.subject));
    addLine(d, "Title", r.title);
    if (r.qbNo) addLine(d, r.qbType === "suggestion" ? "Chapter no." : "Paper no.", String(r.qbNo));
  }

  addLine(d, "Submitted by", by.name);
  addLine(d, "Submitted on", fmtFull(r.ts));
  addLine(d, "Role", (by.role === "teacher" ? "Teacher" : "Student") + (by.guest ? " (Guest)" : ""));
  addLine(d, "School", by.school);
  addLine(d, "Tuition", by.tuition);
  addLine(d, "Email", by.email);
  if (r.link) addLinkLine(d, r.link);
  return d;
}

function renderRequests() {
  reqList.innerHTML = "";
  if (!reqCache || !reqCache.length) {
    emptyText(reqList, "No pending requests");
    return;
  }

  const frag = document.createDocumentFragment();
  reqCache.forEach(function (r) {
    const box = document.createElement("div");
    box.className = "note";
    box.dataset.id = r.id;

    const t = document.createElement("div");
    t.className = "t";
    t.textContent = reqTitle(r);

    const s = document.createElement("div");
    s.className = "s";
    s.textContent = reqSub(r);

    const w = document.createElement("div");
    w.className = "when";
    w.textContent = "Submitted by " + ((r.by && r.by.name) || "Unknown") +
      (r.ts ? " • " + fmtFull(r.ts) : "");

    const acts = document.createElement("div");
    acts.className = "acts";
    [["view", "👁️ View"], ["acc", "✅ Accept"], ["rej", "❌ Reject"]].forEach(function (x) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = x[0];
      btn.textContent = x[1];
      acts.appendChild(btn);
    });

    box.appendChild(t);
    box.appendChild(s);
    box.appendChild(w);
    box.appendChild(acts);
    box.appendChild(buildDetail(r));
    frag.appendChild(box);
  });
  reqList.appendChild(frag);
}

function decideRequest(box, id, accept) {
  const r = findReq(id);
  if (!r) return;

  const btns = box.querySelectorAll(".acts button");
  for (let i = 0; i < btns.length; i++) btns[i].disabled = true;
  showMsg("Saving...", "");

  loadFirebase()
    .then(function (db) {
      const batch = db.batch();
      if (accept) {
        // Published with the contributor's name and the publish time
        const x = buildPublic(r, r.uid || "", (r.by && r.by.name) || "");
        batch.set(db.collection(x.col).doc(), x.doc);
      }
      batch.update(db.collection("submissions").doc(id), {
        status: accept ? "accepted" : "rejected",
        decidedAt: Date.now()
      });
      return batch.commit();
    })
    .then(function () {
      reqCache = reqCache.filter(function (x) { return x.id !== id; });
      if (accept) afterPublish();
      box.remove();
      if (!reqList.children.length) renderRequests();
      showMsg(accept ? "Accepted and published ✓" : "Rejected ✓", "ok");
    })
    .catch(function () {
      for (let i = 0; i < btns.length; i++) btns[i].disabled = false;
      showMsg("Could not save. Check rules and internet.", "err");
    });
}

reqList.addEventListener("click", function (e) {
  const box = e.target.closest(".note");
  if (!box || !reqCache) return;
  const id = box.dataset.id;

  if (e.target.closest(".view")) {
    const d = box.querySelector(".detail");
    if (d) d.hidden = !d.hidden;
    return;
  }
  if (e.target.closest(".acc")) {
    decideRequest(box, id, true);
    return;
  }
  if (e.target.closest(".rej")) {
    askConfirm("Reject this request?", "The submission will be rejected and will not be published.", "Reject", true)
      .then(function (ok) { if (ok) decideRequest(box, id, false); });
  }
});

/* ---------- Admin: Routine ---------- */
const GROUP_NAME = { art: "Art", science: "Science", school: "School" };

function setRoutineGroups() {
  const kind = $("fRKind").value;
  const groups = KIND_GROUPS[kind];
  const sel = $("fRGroup");
  const prev = sel.value;
  sel.innerHTML = "";

  groups.forEach(function (g) {
    const o = document.createElement("option");
    o.value = g.v;
    o.textContent = g.t;
    sel.appendChild(o);
  });

  if (groups.some(function (g) { return g.v === prev; })) sel.value = prev;

  $("rGroupWrap").hidden = groups.length === 0;
  toggleGender();
}

function toggleGender() {
  const show = $("fRKind").value === "exam" && $("fRGroup").value === "school";
  $("rGenderWrap").hidden = !show;
}

$("fRKind").addEventListener("change", setRoutineGroups);
$("fRGroup").addEventListener("change", toggleGender);

function saveRoutine() {
  const kind = $("fRKind").value;
  const day = $("fRDay").value.trim();
  const time = $("fRTime").value.trim();
  const subject = $("fRSubject").value.trim();

  if (!day) { showMsg("Enter the day / date.", "err"); return; }
  if (!time) { showMsg("Enter the time.", "err"); return; }
  if (!subject) { showMsg("Enter the subject.", "err"); return; }

  const group = KIND_GROUPS[kind].length ? $("fRGroup").value : "";
  const gender = (kind === "exam" && group === "school") ? $("fRGender").value : "";

  const data = {
    kind: kind,
    group: group,
    gender: gender,
    day: day,
    time: time,
    subject: subject,
    ts: Date.now()
  };

  const btn = $("saveRoutine");
  btn.disabled = true;
  showMsg("Saving...", "");

  loadFirebase()
    .then(function (db) {
      return adminWho().then(function (w) {
        if (w.uid) data.uid = w.uid;
        data.by = w.by;
        return db.collection("routines").add(data);
      });
    })
    .then(function (ref) {
      data.id = ref.id;
      $("fRDay").value = "";
      $("fRTime").value = "";
      $("fRSubject").value = "";
      rtCache = {};
      lsBust();
      if (adminRoutines) {
        adminRoutines.unshift(data);
        renderAdminRoutines();
      }
      showMsg("Routine added ✓", "ok");
    })
    .catch(function () { showMsg("Could not save. Check rules and internet.", "err"); })
    .then(function () { btn.disabled = false; });
}

$("saveRoutine").addEventListener("click", saveRoutine);

let adminRoutines = null;
const rAdminList = $("rAdminList");

function loadAdminRoutines() {
  if (adminRoutines) { renderAdminRoutines(); return; }
  emptyText(rAdminList, "Loading...");

  loadFirebase()
    .then(function (db) {
      return withTimeout(db.collection("routines").orderBy("ts", "desc").limit(200).get(), 15000);
    })
    .then(function (snap) {
      adminRoutines = [];
      snap.forEach(function (d) {
        const r = d.data();
        r.id = d.id;
        adminRoutines.push(r);
      });
      renderAdminRoutines();
    })
    .catch(function () {
      errorText(rAdminList, "Could not load routines. Check rules and internet.", loadAdminRoutines);
    });
}

function routineLabel(r) {
  let s = KIND_NAME[r.kind] || r.kind;
  if (r.group) s += " • " + (GROUP_NAME[r.group] || r.group);
  if (r.gender) s += " • " + (r.gender === "boys" ? "Boys School" : "Girls School");
  return s;
}

function renderAdminRoutines() {
  rAdminList.innerHTML = "";
  if (!adminRoutines || !adminRoutines.length) {
    emptyText(rAdminList, "No routines");
    return;
  }

  const frag = document.createDocumentFragment();
  adminRoutines.forEach(function (r) {
    const box = document.createElement("div");
    box.className = "note";
    box.dataset.id = r.id;

    const t = document.createElement("div");
    t.className = "t";
    t.textContent = r.subject + "  •  " + r.day + "  •  " + r.time;

    const s = document.createElement("div");
    s.className = "s";
    s.textContent = routineLabel(r) +
      (typeof r.by === "string" && r.by ? " • by " + r.by : "") +
      (r.ts ? " • " + fmtFull(r.ts) : "");

    box.appendChild(t);
    box.appendChild(s);
    box.appendChild(makeActs(false));
    frag.appendChild(box);
  });
  rAdminList.appendChild(frag);
}

rAdminList.addEventListener("click", function (e) {
  if (!e.target.closest(".del")) return;
  const box = e.target.closest(".note");
  if (!box || !adminRoutines) return;
  const id = box.dataset.id;
  askConfirm("Delete this routine?", "This routine will be removed for everyone. This cannot be undone.", "Delete", true)
    .then(function (ok) {
      if (!ok) return;
      loadFirebase()
        .then(function (db) { return db.collection("routines").doc(id).delete(); })
        .then(function () {
          adminRoutines = adminRoutines.filter(function (r) { return r.id !== id; });
          rtCache = {};
          lsBust();
          renderAdminRoutines();
          showMsg("Routine deleted ✓", "ok");
        })
        .catch(function () { showMsg("Could not delete. Check rules and internet.", "err"); });
    });
});

/* ================= PYQ & PAPERS + QUESTION BANK ================= */
// Question Bank items are stored in the same "papers" collection
// (type: model / suggestion).
const QB_TYPES = {
  model: "Model Question Paper",
  suggestion: "Suggestions"
};

const PAPER_TYPES = {
  board: "Board PYQ",
  school: "School Exam Paper",
  tuition: "Tuition Exam Paper",
  model: "Model Question Paper",
  suggestion: "Suggestions"
};

fillSubjects($("ppSubj"), false);
fillSubjects($("ppFilter"), true);
fillSubjects($("qbSubj"), false);

/* ---------- Student ---------- */
let ppType = null;
let ppCache = {};
const ppList = $("ppList");

function openPapers(type) {
  if (!PAPER_TYPES[type]) return;
  ppType = type;
  $("ppHead").textContent = PAPER_TYPES[type];
  $("ppFilter").value = "all";
  ppView.hidden = false;
  ppView.scrollTop = 0;
  syncScroll();
  afterPaint(function () { if (ppType === type) loadPapers(type); });
}

function closePapers() {
  ppView.hidden = true;
  ppType = null;
  syncScroll();
}

function loadPapers(type) {
  if (ppCache[type]) { renderPapers(); return; }

  const saved = lsGet("p_" + type);
  if (saved) {
    ppCache[type] = saved;
    renderPapers();
    if (navigator.onLine === false || lsFresh("p_" + type, 60000)) return;
  } else {
    emptyText(ppList, "Loading...");
  }

  readCol({ col: "papers", where: ["type", type], limit: 300 })
    .then(function (arr) {
      arr.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
      ppCache[type] = arr;
      lsSet("p_" + type, arr);
      if (ppType === type) renderPapers();
    })
    .catch(function () {
      if (!saved && ppType === type) {
        errorText(ppList, offlineText(), function () { loadPapers(type); });
      }
    });
}

function renderPapers() {
  const f = $("ppFilter").value;
  const items = (ppCache[ppType] || []).filter(function (p) {
    return f === "all" || p.subject === f;
  });
  if (QB_TYPES[ppType]) {
    // Subject by subject, then number order
    items.sort(function (a, b) {
      const sa = subjectIndex(a.subject);
      const sb = subjectIndex(b.subject);
      return sa !== sb ? sa - sb : byNo(a, b);
    });
  }

  if (!items.length) {
    emptyText(ppList, "Nothing here yet");
    return;
  }

  ppList.innerHTML = "";
  const frag = document.createDocumentFragment();
  items.forEach(function (p) {
    const a = document.createElement("a");
    a.className = "nlink";
    a.href = p.link;
    a.target = "_blank";
    a.rel = "noopener noreferrer";

    const box = document.createElement("div");
    const t = document.createElement("span");
    t.className = "nt";
    t.textContent = p.title;
    const s = document.createElement("span");
    s.className = "ns";
    s.textContent = subjectName(p.subject) + (p.marks ? " • " + p.marks + " Marks" : "") + noText(p);
    box.appendChild(t);
    box.appendChild(s);
    const bl = byLine(p.by);
    if (bl) box.appendChild(bl);

    const g = document.createElement("span");
    g.className = "go";
    g.textContent = "Open ↗";

    a.appendChild(box);
    a.appendChild(g);
    frag.appendChild(a);
  });
  ppList.appendChild(frag);
}

$("ppFilter").addEventListener("change", renderPapers);
$("ppClose").addEventListener("click", closePapers);

/* ---------- Admin ---------- */
let adminPapers = null;
let ppEditId = null;
let qbEditId = null;
const ppAdminList = $("ppAdminList");
const qbAdminList = $("qbAdminList");

$("tabPapers").addEventListener("click", function () {
  if (editingId) resetForm();
  switchTab("papers");
});

$("tabQb").addEventListener("click", function () {
  if (editingId) resetForm();
  switchTab("qb");
});

function ppReset() {
  ppEditId = null;
  $("ppType").selectedIndex = 0;
  $("ppSubj").selectedIndex = 0;
  $("ppTitle").value = "";
  $("ppMarks").value = "";
  $("ppLink").value = "";
  $("ppSave").textContent = "Upload Paper";
  $("ppEditFlag").hidden = true;
  $("ppCancel").hidden = true;
}

function qbReset() {
  qbEditId = null;
  $("qbType").selectedIndex = 0;
  $("qbSubj").selectedIndex = 0;
  $("qbTitle").value = "";
  $("qbNo").value = "";
  syncQbNo("qbType", "qbNoLbl");
  $("qbLink").value = "";
  $("qbSave").textContent = "Upload to Question Bank";
  $("qbEditFlag").hidden = true;
  $("qbCancel").hidden = true;
}

$("ppCancel").addEventListener("click", ppReset);
$("qbCancel").addEventListener("click", qbReset);

function savePaper() {
  const title = $("ppTitle").value.trim();
  const marks = parseInt($("ppMarks").value, 10);
  const link = $("ppLink").value.trim();

  if (!title) { showMsg("Enter the paper title.", "err"); return; }
  if (!marks || marks < 1) { showMsg("Enter the marks.", "err"); return; }
  if (!/^https?:\/\//i.test(link)) { showMsg("Enter a valid link (https://...).", "err"); return; }

  const data = {
    type: $("ppType").value,
    subject: $("ppSubj").value,
    title: title,
    marks: marks,
    link: link
  };

  const btn = $("ppSave");
  btn.disabled = true;
  showMsg("Saving...", "");

  loadFirebase()
    .then(function (db) {
      const col = db.collection("papers");
      if (ppEditId) return col.doc(ppEditId).update(data);
      return adminWho().then(function (w) {
        data.ts = Date.now();
        if (w.uid) data.uid = w.uid;
        data.by = w.by;
        return col.add(data);
      });
    })
    .then(function () {
      const edited = !!ppEditId;
      ppReset();
      adminPapers = null;
      ppCache = {};
      lsBust();
      loadAdminPapers();
      showMsg(edited ? "Paper updated ✓" : "Paper uploaded ✓", "ok");
    })
    .catch(function () { showMsg("Could not save. Check rules and internet.", "err"); })
    .then(function () { btn.disabled = false; });
}

$("ppSave").addEventListener("click", savePaper);

$("qbType").addEventListener("change", function () { syncQbNo("qbType", "qbNoLbl"); });

function saveQb() {
  const title = $("qbTitle").value.trim();
  const link = $("qbLink").value.trim();
  const no = parseInt($("qbNo").value, 10);

  if (!title) { showMsg("Enter the title.", "err"); return; }
  if (!no || no < 1) { showMsg("Enter the " + qbNoLabel($("qbType").value).toLowerCase() + ".", "err"); return; }
  if (!/^https?:\/\//i.test(link)) { showMsg("Enter a valid link (https://...).", "err"); return; }

  const data = {
    type: $("qbType").value,
    subject: $("qbSubj").value,
    title: title,
    marks: 0,
    no: no,
    link: link
  };

  const btn = $("qbSave");
  btn.disabled = true;
  showMsg("Saving...", "");

  loadFirebase()
    .then(function (db) {
      const col = db.collection("papers");
      if (qbEditId) return col.doc(qbEditId).update(data);
      return adminWho().then(function (w) {
        data.ts = Date.now();
        if (w.uid) data.uid = w.uid;
        data.by = w.by;
        return col.add(data);
      });
    })
    .then(function () {
      const edited = !!qbEditId;
      qbReset();
      adminPapers = null;
      ppCache = {};
      lsBust();
      loadAdminPapers();
      showMsg(edited ? "Item updated ✓" : "Item uploaded ✓", "ok");
    })
    .catch(function () { showMsg("Could not save. Check rules and internet.", "err"); })
    .then(function () { btn.disabled = false; });
}

$("qbSave").addEventListener("click", saveQb);

function loadAdminPapers() {
  if (adminPapers) { renderAdminPapers(); return; }
  emptyText(ppAdminList, "Loading...");
  emptyText(qbAdminList, "Loading...");

  loadFirebase()
    .then(function (db) {
      return withTimeout(db.collection("papers").orderBy("ts", "desc").limit(300).get(), 15000);
    })
    .then(function (snap) {
      adminPapers = [];
      snap.forEach(function (d) {
        const p = d.data();
        p.id = d.id;
        adminPapers.push(p);
      });
      renderAdminPapers();
    })
    .catch(function () {
      errorText(ppAdminList, "Could not load papers. Check rules and internet.", loadAdminPapers);
      qbAdminList.innerHTML = "";
    });
}

function renderPaperList(el, qb, emptyMsg) {
  el.innerHTML = "";
  const items = (adminPapers || []).filter(function (p) {
    return !!QB_TYPES[p.type] === qb;
  });
  if (!items.length) {
    emptyText(el, emptyMsg);
    return;
  }
  if (qb) {
    items.sort(function (a, b) {
      if (a.type !== b.type) return a.type < b.type ? -1 : 1;
      const sa = subjectIndex(a.subject);
      const sb = subjectIndex(b.subject);
      return sa !== sb ? sa - sb : byNo(a, b);
    });
  }

  const frag = document.createDocumentFragment();
  items.forEach(function (p) {
    const box = document.createElement("div");
    box.className = "note";
    box.dataset.id = p.id;

    const t = document.createElement("div");
    t.className = "t";
    t.textContent = p.title;

    const s = document.createElement("div");
    s.className = "s";
    s.textContent = (PAPER_TYPES[p.type] || p.type) + " • " + subjectName(p.subject) +
      (p.marks ? " • " + p.marks + " Marks" : "") + noText(p) +
      (typeof p.by === "string" && p.by ? " • by " + p.by : "") +
      (p.ts ? " • " + fmtFull(p.ts) : "");

    const acts = document.createElement("div");
    acts.className = "acts";
    [["view", "👁️ View"], ["edit", "✏️ Edit"], ["del", "🗑️ Delete"]].forEach(function (x) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = x[0];
      b.textContent = x[1];
      acts.appendChild(b);
    });

    box.appendChild(t);
    box.appendChild(s);
    box.appendChild(acts);
    frag.appendChild(box);
  });
  el.appendChild(frag);
}

function renderAdminPapers() {
  renderPaperList(ppAdminList, false, "No papers");
  renderPaperList(qbAdminList, true, "No items");
}

function findPaper(id) {
  for (let i = 0; i < adminPapers.length; i++) {
    if (adminPapers[i].id === id) return adminPapers[i];
  }
  return null;
}

function paperListClick(e) {
  const box = e.target.closest(".note");
  if (!box || !adminPapers) return;
  const id = box.dataset.id;
  const p = findPaper(id);
  if (!p) return;
  const isQb = !!QB_TYPES[p.type];

  if (e.target.closest(".view")) {
    window.open(p.link, "_blank", "noopener");
    return;
  }

  if (e.target.closest(".edit")) {
    if (isQb) {
      qbEditId = id;
      $("qbType").value = p.type;
      $("qbSubj").value = p.subject;
      $("qbTitle").value = p.title || "";
      $("qbNo").value = p.no || "";
      syncQbNo("qbType", "qbNoLbl");
      $("qbLink").value = p.link || "";
      $("qbSave").textContent = "Update Item";
      $("qbEditFlag").hidden = false;
      $("qbCancel").hidden = false;
    } else {
      ppEditId = id;
      $("ppType").value = p.type;
      $("ppSubj").value = p.subject;
      $("ppTitle").value = p.title || "";
      $("ppMarks").value = p.marks || "";
      $("ppLink").value = p.link || "";
      $("ppSave").textContent = "Update Paper";
      $("ppEditFlag").hidden = false;
      $("ppCancel").hidden = false;
    }
    panel.scrollTop = 0;
    return;
  }

  if (e.target.closest(".del")) {
    askConfirm("Delete this item?", "It will be removed for everyone. This cannot be undone.", "Delete", true)
      .then(function (ok) {
        if (!ok) return;
        loadFirebase()
          .then(function (db) { return db.collection("papers").doc(id).delete(); })
          .then(function () {
            adminPapers = adminPapers.filter(function (x) { return x.id !== id; });
            ppCache = {};
            lsBust();
            renderAdminPapers();
            showMsg("Deleted ✓", "ok");
          })
          .catch(function () { showMsg("Could not delete. Check rules and internet.", "err"); });
      });
  }
}

ppAdminList.addEventListener("click", paperListClick);
qbAdminList.addEventListener("click", paperListClick);

/* ---------- Admin: Users (Details / Notes / Access / Delete) ---------- */
const usList = $("usList");
const usDetail = $("usDetail");
const usBody = $("usBody");
let usSel = null;      // selected person
let usTab = "d";

function loadUsersTab(force) {
  usSel = null;
  usDetail.hidden = true;
  usList.hidden = false;
  if (!usersCache || force) emptyText(usList, "Loading...");

  loadPeople(force, function (ok) {
    if (ok) {
      renderUsers();
    } else {
      errorText(usList, "Could not load users. Check rules and internet.", function () { loadUsersTab(true); });
    }
  });
}

function renderUsers() {
  usList.innerHTML = "";
  const users = ((usersCache && usersCache.arr) || []).slice();
  if (!users.length) {
    emptyText(usList, "No users yet. Users appear here after they open the app.");
    return;
  }
  users.sort(function (a, b) { return (a.name || "").localeCompare(b.name || ""); });

  const sum = document.createElement("p");
  sum.className = "sumline";
  sum.textContent = users.length + " users • tap Open to manage";
  usList.appendChild(sum);

  const frag = document.createDocumentFragment();
  users.forEach(function (u) {
    const box = document.createElement("div");
    box.className = "note";
    box.dataset.id = u.id;

    const t = document.createElement("div");
    t.className = "t";
    t.textContent = u.name || "User";

    const s = document.createElement("div");
    s.className = "s";
    s.textContent = (u.role === "teacher" ? "Teacher" : "Student") + (u.guest ? " • Guest" : " • Email");

    const acts = document.createElement("div");
    acts.className = "acts";
    const b = document.createElement("button");
    b.type = "button";
    b.className = "view";
    b.textContent = "👁️ Open";
    acts.appendChild(b);

    box.appendChild(t);
    box.appendChild(s);
    box.appendChild(acts);
    frag.appendChild(box);
  });
  usList.appendChild(frag);
}

usList.addEventListener("click", function (e) {
  const box = e.target.closest(".note");
  if (!box || !usersCache) return;
  const id = box.dataset.id;
  for (let i = 0; i < usersCache.arr.length; i++) {
    if (usersCache.arr[i].id === id) { openUser(usersCache.arr[i]); return; }
  }
});

function setUsTabs() {
  $("usTabD").classList.toggle("on", usTab === "d");
  $("usTabN").classList.toggle("on", usTab === "n");
  $("usTabA").classList.toggle("on", usTab === "a");
  $("usTabX").classList.toggle("on", usTab === "x");
}

function openUser(u) {
  usSel = u;
  usTab = "d";
  usList.hidden = true;
  usDetail.hidden = false;
  $("usName").textContent = u.name || "User";
  setUsTabs();
  renderUsBody();
  panel.scrollTop = 0;
}

$("usBack").addEventListener("click", function () {
  usSel = null;
  usDetail.hidden = true;
  usList.hidden = false;
  renderUsers();
});

$("usTabD").addEventListener("click", function () { usTab = "d"; setUsTabs(); renderUsBody(); });
$("usTabN").addEventListener("click", function () { usTab = "n"; setUsTabs(); renderUsBody(); });
$("usTabA").addEventListener("click", function () { usTab = "a"; setUsTabs(); renderUsBody(); });
$("usTabX").addEventListener("click", function () { usTab = "x"; setUsTabs(); renderUsBody(); });

function renderUsBody() {
  const u = usSel;
  if (!u) return;
  const id = u.id;
  const tab = usTab;

  function stale() { return !usSel || usSel.id !== id || usTab !== tab; }
  function fail() {
    if (!stale()) emptyText(usBody, "Could not load. Check rules and internet.");
  }

  emptyText(usBody, "Loading...");

  /* Details */
  if (tab === "d") {
    const isGuest = !!u.guest;
    const getProfile = isGuest
      ? Promise.resolve(null)
      : loadFirebase()
          .then(function (db) { return db.collection("users").doc(id).get(); })
          .then(function (d) { return d.exists ? d.data() : null; })
          .catch(function () { return null; });

    getProfile.then(function (p) {
      if (stale()) return;
      const box = document.createElement("div");
      box.className = "dbox";
      addLine(box, "Name", u.name || "");
      addLine(box, "Role", u.role === "teacher" ? "Teacher" : "Student");
      addLine(box, "Login", isGuest ? "Guest" : "Email & password");
      if (!isGuest) addLine(box, "Email", (p && p.email) || "-");
      addLine(box, "Registered", fmtFull((p && p.createdAt) || u.ts));
      addLine(box, "User ID", id);
      usBody.innerHTML = "";
      usBody.appendChild(box);
    });
    return;
  }

  /* Uploads (notes, routines, papers, question bank) */
  if (tab === "n") {
    loadUploads(id, true)
      .then(function (arr) {
        if (stale()) return;
        usBody.innerHTML = "";
        const sum = document.createElement("p");
        sum.className = "sumline";
        sum.textContent = "Published: " + arr.length + " • " + uploadSummary(arr);
        usBody.appendChild(sum);

        const frag = document.createDocumentFragment();
        arr.forEach(function (x) { frag.appendChild(uploadRow(x)); });
        usBody.appendChild(frag);
      })
      .catch(fail);
    return;
  }

  /* Access (direct upload) */
  if (tab === "a") {
    loadFirebase()
      .then(function (db) { return db.collection("trusted").doc(id).get(); })
      .then(function (d) {
        if (stale()) return;
        renderAccess(id, d.exists);
      })
      .catch(fail);
    return;
  }

  /* Delete */
  usBody.innerHTML = "";
  const p = document.createElement("p");
  p.className = "hint";
  p.style.marginTop = "14px";
  p.textContent = "This deletes the user's profile and activity. They will be logged out. " +
    "They can use the app again by logging in with the same email. " +
    "Their published notes stay live but are no longer linked to them.";
  const b = document.createElement("button");
  b.type = "button";
  b.className = "btn ghost danger";
  b.textContent = "🗑️ Delete this user";
  b.addEventListener("click", function () { deleteUser(id, b); });
  usBody.appendChild(p);
  usBody.appendChild(b);
}

function renderAccess(id, on) {
  usBody.innerHTML = "";
  const p = document.createElement("p");
  p.className = "hint";
  p.style.marginTop = "14px";
  p.textContent = on
    ? "Direct upload is ON. This user's notes are published without approval."
    : "Direct upload is OFF. This user's notes need your approval.";
  const b = document.createElement("button");
  b.type = "button";
  b.className = on ? "btn ghost danger" : "btn";
  b.textContent = on ? "✖ Remove direct upload" : "⭐ Allow direct upload";
  b.addEventListener("click", function () { toggleTrusted(id, on, b); });
  usBody.appendChild(p);
  usBody.appendChild(b);
}

function toggleTrusted(id, on, btn) {
  btn.disabled = true;
  showMsg("Saving...", "");

  loadFirebase()
    .then(function (db) {
      const ref = db.collection("trusted").doc(id);
      if (on) return ref.delete();
      return ref.set({ name: (usSel && usSel.name) || "", ts: Date.now() });
    })
    .then(function () {
      logCache = null;   // Activity shows the Trusted badge, so refresh it next time
      showMsg(on ? "Direct upload removed ✓" : "Selected ✓ This user can upload directly", "ok");
      if (usSel && usSel.id === id && usTab === "a") renderAccess(id, !on);
    })
    .catch(function () {
      btn.disabled = false;
      showMsg("Could not save. Check rules and internet.", "err");
    });
}

function deleteUser(id, btn) {
  askConfirm("Delete this user?", "The user's profile will be removed and they will be logged out. This cannot be undone.", "Delete", true)
    .then(function (ok) { if (ok) runDeleteUser(id, btn); });
}

function runDeleteUser(id, btn) {
  btn.disabled = true;
  showMsg("Deleting...", "");

  loadFirebase()
    .then(function (db) {
      const qs = ["notes", "routines", "papers"].map(function (c) {
        return db.collection(c).where("uid", "==", id).limit(130).get();
      });
      return Promise.all(qs).then(function (snaps) {
        const batch = db.batch();
        const del = firebase.firestore.FieldValue.delete();
        // Published items stay live, only the link to the user is removed
        snaps.forEach(function (snap) {
          snap.forEach(function (d) { batch.update(d.ref, { uid: del, by: del }); });
        });
        batch.delete(db.collection("people").doc(id));
        batch.delete(db.collection("users").doc(id));
        batch.delete(db.collection("trusted").doc(id));
        batch.delete(db.collection("activity").doc(id));
        return batch.commit();
      });
    })
    .then(function () {
      if (usersCache) {
        usersCache.arr = usersCache.arr.filter(function (x) { return x.id !== id; });
      }
      logCache = null;
      notesCache = null;
      usSel = null;
      usDetail.hidden = true;
      usList.hidden = false;
      renderUsers();
      showMsg("User deleted ✓", "ok");
    })
    .catch(function () {
      btn.disabled = false;
      showMsg("Could not delete. Check rules and internet.", "err");
    });
}

/* ---------- Start ---------- */
if (user) {
  renderUserBox();
  syncMe();
} else {
  showAuth();
}