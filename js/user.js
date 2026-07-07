import { auth, db, rtdb } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc,
  addDoc, query, orderBy, where, onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { ref, get } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";

const MAX_EDITS_PER_VERSION = 5;

let currentUser = null;
let currentUserData = null;
let currentSiteId = null;
let currentSiteData = null;
let currentVersionDoc = null;
let activeTab = "html";
let localCode = { html: "", css: "", js: "" };
let myGroups = {};
let currentThread = null;

onAuthStateChanged(auth, async (user) => {
  if (!user) { window.location.href = "index.html"; return; }
  // Profile + live status now lives in the Realtime Database (written by the admin panel,
  // no Cloud Functions needed) — mirrors the same check js/auth.js does at sign-in time,
  // so a session that goes stale (e.g. suspended mid-session) still gets kicked out here.
  const uSnap = await get(ref(rtdb, "users/" + user.uid));
  if (!uSnap.exists() || uSnap.val().status !== "active") {
    await signOut(auth);
    window.location.href = "index.html";
    return;
  }
  currentUser = user;
  currentUserData = uSnap.val();
  init();
});
document.getElementById("logout-btn").addEventListener("click", () => signOut(auth));

function init() {
  wireSectionTabs();
  listenToMySites();
  listenToThreads();
}

function wireSectionTabs() {
  document.querySelectorAll(".section-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".section-tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".section-view").forEach((v) => v.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById("section-" + tab.dataset.section).classList.add("active");
    });
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : str;
  return div.innerHTML;
}

async function logAction(action, detail, siteId) {
  await addDoc(collection(db, "logs"), {
    action, detail, siteId: siteId || null,
    byUid: currentUser.uid, byName: currentUserData.name || currentUser.email, role: "user",
    at: serverTimestamp()
  });
}

/* =========================================================
   MY SITES (assigned only — no create/delete/assign here)
   ========================================================= */
const siteListEl = document.getElementById("site-list");

function listenToMySites() {
  const q = query(collection(db, "sites"), where("assignedUsers", "array-contains", currentUser.uid));
  onSnapshot(q, (snap) => {
    siteListEl.innerHTML = "";
    snap.forEach((docSnap) => {
      const data = docSnap.data();
      const item = document.createElement("div");
      item.className = "site-item" + (docSnap.id === currentSiteId ? " active" : "");
      item.innerHTML = `<span>${escapeHtml(data.name)}</span><span class="ver-badge">${escapeHtml(data.latestVersionId || "-")}</span>`;
      item.addEventListener("click", () => selectSite(docSnap.id));
      siteListEl.appendChild(item);
    });
  });
}

const emptyState = document.getElementById("empty-state");
const editorView = document.getElementById("editor-view");
const codeArea = document.getElementById("code-area");
const commitLog = document.getElementById("commit-log");

async function selectSite(siteId) {
  currentSiteId = siteId;
  const snap = await getDoc(doc(db, "sites", siteId));
  if (!snap.exists()) return;
  currentSiteData = snap.data();

  const vSnap = await getDoc(doc(db, "sites", siteId, "versions", currentSiteData.latestVersionId));
  currentVersionDoc = vSnap.exists() ? vSnap.data() : { html: "", css: "", js: "", editCount: 0 };
  localCode = { html: currentVersionDoc.html || "", css: currentVersionDoc.css || "", js: currentVersionDoc.js || "" };

  document.getElementById("site-name").textContent = currentSiteData.name;
  document.getElementById("site-repo").textContent =
    `${currentSiteData.repo || "no repo linked"} · editing v${currentSiteData.latestVersionId} ` +
    `(${currentVersionDoc.editCount || 0}/${MAX_EDITS_PER_VERSION} edits) · live: v${currentSiteData.liveVersionId}`;

  emptyState.style.display = "none";
  editorView.style.display = "flex";
  setTab("html");
  loadHistory(siteId);
}

document.querySelectorAll(".tab").forEach((tabEl) => {
  tabEl.addEventListener("click", () => setTab(tabEl.dataset.lang));
});
function setTab(lang) {
  localCode[activeTab] = codeArea.value;
  activeTab = lang;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.lang === lang));
  codeArea.value = localCode[lang];
}

document.getElementById("save-version-btn").addEventListener("click", async () => {
  if (!currentSiteId) return;
  localCode[activeTab] = codeArea.value;
  const msg = document.getElementById("commit-msg").value.trim() || "Update";
  const author = { uid: currentUser.uid, name: currentUserData.name || currentUser.email, role: "user" };
  const versionId = currentSiteData.latestVersionId;
  const newEditCount = (currentVersionDoc.editCount || 0) + 1;

  await updateDoc(doc(db, "sites", currentSiteId, "versions", versionId), {
    html: localCode.html, css: localCode.css, js: localCode.js,
    editCount: newEditCount, author, message: msg, updatedAt: serverTimestamp()
  });

  await updateDoc(doc(db, "sites", currentSiteId), {
    html: localCode.html, css: localCode.css, js: localCode.js,
    liveVersionId: versionId, updatedAt: serverTimestamp()
  });

  await logAction("version_saved", `Saved v${versionId} on "${currentSiteData.name}" (${msg})`, currentSiteId);

  if (newEditCount >= MAX_EDITS_PER_VERSION) {
    await updateDoc(doc(db, "sites", currentSiteId, "versions", versionId), { locked: true });
    const [maj] = versionId.split(".").map(Number);
    const nextVersionId = `${maj + 1}.0`;
    await setDoc(doc(db, "sites", currentSiteId, "versions", nextVersionId), {
      major: maj + 1, minor: 0, editCount: 0, locked: false,
      html: localCode.html, css: localCode.css, js: localCode.js,
      author, message: "Auto-created after edit limit", createdAt: serverTimestamp(), updatedAt: serverTimestamp()
    });
    await updateDoc(doc(db, "sites", currentSiteId), { latestVersionId: nextVersionId });
    await logAction("version_locked", `v${versionId} reached ${MAX_EDITS_PER_VERSION} edits and locked; v${nextVersionId} created`, currentSiteId);
  }

  document.getElementById("commit-msg").value = "";
  selectSite(currentSiteId);
});

async function loadHistory(siteId) {
  commitLog.innerHTML = "Loading…";
  const snap = await getDocs(query(collection(db, "sites", siteId, "versions"), orderBy("major", "desc")));
  commitLog.innerHTML = "";
  if (snap.empty) { commitLog.innerHTML = '<div class="commit"><div class="msg">No versions yet.</div></div>'; return; }
  snap.forEach((docSnap) => {
    const v = docSnap.data();
    const vid = docSnap.id;
    const isLive = vid === currentSiteData.liveVersionId;
    const isLatest = vid === currentSiteData.latestVersionId;
    const el = document.createElement("div");
    el.className = "commit" + (isLive ? " current" : "");
    el.innerHTML = `
      <div class="v">v${vid} ${isLatest ? "· editable" : "· locked"} ${isLive ? "· live" : ""}</div>
      <div class="msg">${escapeHtml(v.message || "")} — by ${escapeHtml(v.author?.name || "?")} (${escapeHtml(v.author?.role || "?")})</div>
      <div class="time">${v.updatedAt ? v.updatedAt.toDate().toLocaleString() : ""}</div>
      ${isLive ? "" : `<button data-v="${vid}" class="rollback-btn">Restore this version</button>`}
    `;
    commitLog.appendChild(el);
  });
  commitLog.querySelectorAll(".rollback-btn").forEach((btn) => {
    btn.addEventListener("click", () => rollback(btn.dataset.v));
  });
}

async function rollback(versionId) {
  const vSnap = await getDoc(doc(db, "sites", currentSiteId, "versions", versionId));
  if (!vSnap.exists()) return;
  const v = vSnap.data();
  await updateDoc(doc(db, "sites", currentSiteId), {
    html: v.html, css: v.css, js: v.js, liveVersionId: versionId, updatedAt: serverTimestamp()
  });
  await logAction("version_restored", `Restored v${versionId} live on "${currentSiteData.name}"`, currentSiteId);
  selectSite(currentSiteId);
}

/* =========================================================
   CHAT — admin thread + groups I'm a member of, plus requests
   ========================================================= */
let unsubMessages = null;

function listenToThreads() {
  onSnapshot(query(collection(db, "groups"), where("members", "array-contains", currentUser.uid)), (snap) => {
    myGroups = {};
    snap.forEach((d) => myGroups[d.id] = d.data());
    renderThreadList();
    renderRequestBox();
  });
}

function renderThreadList() {
  const list = document.getElementById("thread-list");
  list.innerHTML = "";
  const adminItem = document.createElement("div");
  adminItem.className = "thread-item" + (currentThread?.type === "admin" ? " active" : "");
  adminItem.innerHTML = `<span class="t-name">Admin</span>`;
  adminItem.addEventListener("click", () => openThread("admin", currentUser.uid, "Admin"));
  list.appendChild(adminItem);

  list.innerHTML += "<div style='padding:8px 14px;font-size:10px;color:var(--muted);'>GROUPS</div>";
  Object.entries(myGroups).forEach(([gid, g]) => {
    const item = document.createElement("div");
    item.className = "thread-item" + (currentThread?.type === "group" && currentThread.id === gid ? " active" : "");
    item.innerHTML = `<span class="t-name">${escapeHtml(g.name)}</span>`;
    item.addEventListener("click", () => openThread("group", gid, g.name));
    document.getElementById("thread-list").appendChild(item);
  });
}

function renderRequestBox() {
  // Only people who already share a group with me can be requested for a direct chat —
  // admin approves before any 1:1 thread with another user is created.
  const peers = new Set();
  Object.values(myGroups).forEach((g) => (g.members || []).forEach((uid) => { if (uid !== currentUser.uid) peers.add(uid); }));
  const box = document.getElementById("request-chat-box");
  box.innerHTML = "";
  if (peers.size === 0) {
    box.innerHTML = "<p style='font-size:11px;color:var(--muted);'>Join a group to request a direct chat with someone in it.</p>";
    return;
  }
  peers.forEach((uid) => {
    const btn = document.createElement("button");
    btn.style.cssText = "font-size:11px;margin-top:6px;width:100%;";
    btn.textContent = `Request chat with ${uid.slice(0, 6)}…`;
    btn.addEventListener("click", async () => {
      await addDoc(collection(db, "chatRequests"), {
        fromUid: currentUser.uid, targetUid: uid, status: "pending", at: serverTimestamp()
      });
      btn.textContent = "Request sent";
      btn.disabled = true;
    });
    box.appendChild(btn);
  });
}

function openThread(type, id, label) {
  currentThread = { type, id };
  document.getElementById("chat-empty").style.display = "none";
  document.getElementById("chat-thread").style.display = "flex";
  document.getElementById("chat-title").textContent = label;
  renderThreadList();

  if (unsubMessages) unsubMessages();
  const path = type === "admin" ? ["chats", currentUser.uid, "messages"] : ["groups", id, "messages"];
  const q = query(collection(db, ...path), orderBy("at", "asc"));
  unsubMessages = onSnapshot(q, (snap) => {
    const box = document.getElementById("chat-messages");
    box.innerHTML = "";
    snap.forEach((d) => {
      const m = d.data();
      const mine = m.senderUid === currentUser.uid;
      const el = document.createElement("div");
      el.className = "bubble " + (mine ? "mine" : "theirs");
      el.innerHTML = `${escapeHtml(m.text)}<span class="meta">${escapeHtml(m.senderName || m.senderUid)}</span>`;
      box.appendChild(el);
    });
    box.scrollTop = box.scrollHeight;
  });
}

document.getElementById("chat-send-btn").addEventListener("click", sendChatMessage);
document.getElementById("chat-input-box").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChatMessage(); });

async function sendChatMessage() {
  if (!currentThread) return;
  const input = document.getElementById("chat-input-box");
  const text = input.value.trim();
  if (!text) return;
  const path = currentThread.type === "admin" ? ["chats", currentUser.uid, "messages"] : ["groups", currentThread.id, "messages"];
  await addDoc(collection(db, ...path), {
    senderUid: currentUser.uid, senderName: currentUserData.name || currentUser.email, senderRole: "user",
    text, at: serverTimestamp()
  });
  input.value = "";
}
