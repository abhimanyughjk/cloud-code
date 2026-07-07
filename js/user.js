import { auth, db, rtdb } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc,
  addDoc, query, orderBy, where, onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { ref, get, onValue } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";

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

// Human-readable copy for each non-active status — shown in the banner and used to explain
// why actions are blocked. Anything not listed falls back to a generic message so a new
// status value an admin invents later never leaks internals or shows "undefined".
const STATUS_MESSAGES = {
  suspended: "This account has been suspended by an admin.",
  blocked: "This account has been blocked by an admin.",
  disabled: "This account has been disabled by an admin."
};

let statusUnsub = null;
let appInitted = false;

onAuthStateChanged(auth, async (user) => {
  if (!user) { window.location.href = "index.html"; return; }
  currentUser = user;

  const uRef = ref(rtdb, "users/" + user.uid);
  const snap = await get(uRef);
  if (!snap.exists()) {
    // No profile at all (never provisioned, or fully removed) — nothing to review, so
    // there's no "suspended" state to show here; just send them back to sign in.
    await signOut(auth);
    window.location.href = "index.html";
    return;
  }

  currentUserData = snap.val();
  if (!appInitted) { init(); appInitted = true; }
  renderStatusBanner();

  // Live from here on: if an admin changes status while this tab is open, the banner and
  // every action's authority check reflect it immediately, without needing a reload.
  if (statusUnsub) statusUnsub();
  statusUnsub = onValue(uRef, (s) => {
    if (!s.exists()) { signOut(auth); window.location.href = "index.html"; return; }
    currentUserData = s.val();
    renderStatusBanner();
  });
});
document.getElementById("logout-btn").addEventListener("click", () => signOut(auth));

function isActive() {
  return !!currentUserData && currentUserData.status === "active";
}

// Call at the top of every action that writes/mutates something. Re-checks the *current*
// in-memory status (kept live by the onValue listener above) rather than trusting a value
// fetched once at login, so a mid-session suspension takes effect on the very next action.
function requireActive(actionLabel) {
  if (isActive()) return true;
  const status = currentUserData?.status || "unknown";
  const reason = STATUS_MESSAGES[status] || "This account is not active.";
  alert(`Can't ${actionLabel} — ${reason}\n\nSubmit a request for review below and an admin will need to reactivate your account first.`);
  return false;
}

function openModal(html) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `<div class="modal-box">${html}</div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  return overlay;
}

// Small pill next to "Sign out" showing account status. Clicking it opens a modal —
// for an active account, just a confirmation; for anything else, the appeal form.
function renderStatusBanner() {
  const pill = document.getElementById("status-pill");
  const status = currentUserData?.status;
  const isOk = status === "active";

  pill.style.display = "inline-block";
  pill.textContent = isOk ? "Active" : (status || "unknown");
  pill.className = "status-pill " + (isOk ? "ok" : "blocked");
  pill.onclick = () => (isOk ? openActiveStatusModal() : openAppealModal(status));
}

function openActiveStatusModal() {
  const overlay = openModal(`
    <h3>Account status</h3>
    <p style="font-size:13px;color:var(--muted);">Your account is active — you have full access.</p>
    <div class="modal-actions"><button class="ghost" id="st-close">Close</button></div>
  `);
  overlay.querySelector("#st-close").addEventListener("click", () => overlay.remove());
}

/* =========================================================
   Status appeal — lets a suspended/blocked/disabled user ask
   an admin to re-review their account, instead of just being
   locked out with no path forward.
   ========================================================= */
async function openAppealModal(status) {
  const overlay = openModal(`
    <h3>Account ${escapeHtml(status || "unknown")}</h3>
    <p style="font-size:13px;color:var(--muted);">${escapeHtml(STATUS_MESSAGES[status] || "This account is not active.")}
      Editing sites and sending messages are disabled until an admin resolves this.</p>
    <div id="appeal-body">Checking for an existing request…</div>
  `);
  const body = overlay.querySelector("#appeal-body");

  // Don't let someone spam multiple requests — check for an existing unresolved one first.
  let existingSnap;
  try {
    const existingQ = query(
      collection(db, "statusReviewRequests"),
      where("uid", "==", currentUser.uid),
      where("reviewed", "==", false)
    );
    existingSnap = await getDocs(existingQ);
  } catch (err) {
    body.innerHTML = `<p style="font-size:12px;color:var(--remove);">Could not check request status: ${escapeHtml(err.message)}</p>`;
    return;
  }

  if (!existingSnap.empty) {
    body.innerHTML = `<p style="font-size:12px;color:var(--muted);">
      A request for review is already pending — an admin will follow up.
    </p>
    <div class="modal-actions"><button class="ghost" id="ap-close">Close</button></div>`;
    body.querySelector("#ap-close").addEventListener("click", () => overlay.remove());
    return;
  }

  body.innerHTML = `
    <strong style="font-size:12px;">Appeal to admin</strong>
    <p style="font-size:12px;color:var(--muted);margin:4px 0 0;">
      Explain why you think this account should be reactivated. An admin will see this request.
    </p>
    <textarea id="review-request-msg" placeholder="Optional message to the admin…"></textarea>
    <div id="review-request-status"></div>
    <div class="modal-actions">
      <button class="ghost" id="ap-cancel">Cancel</button>
      <button class="primary" style="width:auto;" id="submit-review-request-btn">Submit for review</button>
    </div>
  `;
  body.querySelector("#ap-cancel").addEventListener("click", () => overlay.remove());
  body.querySelector("#submit-review-request-btn").addEventListener("click", async () => {
    const msg = body.querySelector("#review-request-msg").value.trim();
    const statusEl = body.querySelector("#review-request-status");
    try {
      await addDoc(collection(db, "statusReviewRequests"), {
        uid: currentUser.uid,
        name: currentUserData.name || currentUser.email,
        email: currentUser.email,
        statusAtRequest: status,
        message: msg,
        reviewed: false,
        submittedAt: serverTimestamp()
      });
      statusEl.textContent = "Request submitted — an admin will review your account.";
      statusEl.style.color = "var(--add)";
      setTimeout(() => overlay.remove(), 1200);
    } catch (err) {
      statusEl.textContent = "Could not submit request. Try again.";
      statusEl.style.color = "var(--remove)";
    }
  });
}

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
  if (!requireActive("save changes")) return;
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
  if (!requireActive("restore a version")) return;
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
      if (!requireActive("request a chat")) return;
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
  const box = document.getElementById("chat-messages");
  box.innerHTML = "Loading…";
  unsubMessages = onSnapshot(q, (snap) => {
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
  }, (err) => {
    console.error("[chat]", err);
    box.innerHTML = `<p style="color:var(--remove);font-size:12px;">Couldn't load this conversation: ${escapeHtml(err.message)}</p>`;
  });
}

document.getElementById("chat-send-btn").addEventListener("click", sendChatMessage);
document.getElementById("chat-input-box").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChatMessage(); });

async function sendChatMessage() {
  if (!currentThread) return;
  if (!requireActive("send a message")) return;
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
