import { auth, db, rtdb, firebaseConfig } from "./firebase-config.js";
import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  onAuthStateChanged, signOut,
  getAuth, createUserWithEmailAndPassword, sendPasswordResetEmail,
  signOut as signOutSecondary
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  ref, set, update, remove, onValue
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";
import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  addDoc, query, orderBy, where, limit, onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const MAX_EDITS_PER_VERSION = 5;

// ---------------------------------------------------------------------------
// Creating a Firebase Auth user with createUserWithEmailAndPassword() on the
// *primary* app would sign the admin's own session out and into the brand-new
// account — the client SDK only ever has one signed-in user per app instance.
// The fix (no Cloud Functions / Admin SDK / Blaze plan required): spin up a
// second, throwaway Firebase app + Auth instance just for the create call,
// then tear it down. The admin's real session in `auth` is never touched.
// ---------------------------------------------------------------------------
async function createAuthUserWithoutSigningOutAdmin(email, password) {
  const secondaryApp = initializeApp(firebaseConfig, "secondary-" + Date.now());
  const secondaryAuth = getAuth(secondaryApp);
  try {
    const cred = await createUserWithEmailAndPassword(secondaryAuth, email, password);
    // Send the reset email right away so the account owner sets their own password
    // instead of ever relying on the admin-chosen temp one.
    await sendPasswordResetEmail(secondaryAuth, email);
    await signOutSecondary(secondaryAuth);
    return cred.user.uid;
  } finally {
    await deleteApp(secondaryApp);
  }
}

let currentUser = null;
let currentSiteId = null;
let currentSiteData = null;
let currentVersionDoc = null; // the editable "latest" version
let activeTab = "html";
let localCode = { html: "", css: "", js: "" };
let usersCache = {}; // uid -> user doc data
let currentThread = null; // { type:'user'|'group', id }

// ---------------- Auth guard ----------------
onAuthStateChanged(auth, async (user) => {
  if (!user) { window.location.href = "index.html"; return; }
  const adminSnap = await getDoc(doc(db, "admins", user.uid));
  if (!adminSnap.exists()) { await signOut(auth); window.location.href = "index.html"; return; }
  currentUser = user;
  init();
});
document.getElementById("logout-btn").addEventListener("click", () => signOut(auth));

function init() {
  listenToSites();
  listenToUsers();
  listenToLogs();
  listenToThreadsAndChat();
  wireSectionTabs();
}

// ---------------- Section tabs ----------------
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

// ---------------- Modal helper ----------------
function openModal(html) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `<div class="modal-box">${html}</div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  return overlay;
}

async function logAction(action, detail, siteId) {
  await addDoc(collection(db, "logs"), {
    action, detail, siteId: siteId || null,
    byUid: currentUser.uid, byName: currentUser.email, role: "admin",
    at: serverTimestamp()
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : str;
  return div.innerHTML;
}

/* =========================================================
   SITES
   ========================================================= */
const siteListEl = document.getElementById("site-list");

function listenToSites() {
  onSnapshot(query(collection(db, "sites"), orderBy("name")), (snap) => {
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

document.getElementById("new-site-btn").addEventListener("click", async () => {
  const name = prompt("Site name (e.g. my-portfolio):");
  if (!name) return;
  const repo = prompt("GitHub repo URL (optional):") || "";

  const siteRef = await addDoc(collection(db, "sites"), {
    name, repo, html: "", css: "", js: "",
    assignedUsers: [], latestVersionId: "1.0", liveVersionId: "1.0",
    createdBy: currentUser.uid, updatedAt: serverTimestamp()
  });

  await setDoc(doc(db, "sites", siteRef.id, "versions", "1.0"), {
    major: 1, minor: 0, editCount: 0, locked: false,
    html: "", css: "", js: "",
    author: { uid: currentUser.uid, name: currentUser.email, role: "admin" },
    message: "Initial version", createdAt: serverTimestamp(), updatedAt: serverTimestamp()
  });

  await logAction("site_created", `Created site "${name}"`, siteRef.id);
  selectSite(siteRef.id);
});

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
  const author = { uid: currentUser.uid, name: currentUser.email, role: "admin" };
  const versionId = currentSiteData.latestVersionId;
  const newEditCount = (currentVersionDoc.editCount || 0) + 1;

  // Update the editable head version in place.
  await updateDoc(doc(db, "sites", currentSiteId, "versions", versionId), {
    html: localCode.html, css: localCode.css, js: localCode.js,
    editCount: newEditCount, author, message: msg, updatedAt: serverTimestamp()
  });

  // Auto-publish: live site always serves whatever was just saved to latest.
  await updateDoc(doc(db, "sites", currentSiteId), {
    html: localCode.html, css: localCode.css, js: localCode.js,
    liveVersionId: versionId, updatedAt: serverTimestamp()
  });

  await logAction("version_saved", `Saved v${versionId} on "${currentSiteData.name}" (${msg})`, currentSiteId);

  if (newEditCount >= MAX_EDITS_PER_VERSION) {
    // Roll over into a brand-new version. The just-filled one locks forever.
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
  // Restoring only changes what's LIVE. It never edits the old version doc,
  // and never touches the latest editable head.
  await updateDoc(doc(db, "sites", currentSiteId), {
    html: v.html, css: v.css, js: v.js, liveVersionId: versionId, updatedAt: serverTimestamp()
  });
  await logAction("version_restored", `Restored v${versionId} live on "${currentSiteData.name}"`, currentSiteId);
  selectSite(currentSiteId);
}

document.getElementById("delete-site-btn").addEventListener("click", async () => {
  if (!currentSiteId) return;
  if (!confirm(`Delete "${currentSiteData.name}"? This cannot be undone.`)) return;
  await logAction("site_deleted", `Deleted site "${currentSiteData.name}"`, currentSiteId);
  await deleteDoc(doc(db, "sites", currentSiteId));
  currentSiteId = null;
  editorView.style.display = "none";
  emptyState.style.display = "flex";
});

document.getElementById("copy-loader-btn").addEventListener("click", () => {
  if (!currentSiteId) return;
  const snippet = `<script src="https://YOUR_HOSTING_DOMAIN/loader/site-loader.js" data-site-id="${currentSiteId}"><\/script>`;
  navigator.clipboard.writeText(snippet);
  alert("Loader snippet copied.");
});

document.getElementById("assign-users-btn").addEventListener("click", () => {
  if (!currentSiteId) return;
  const assigned = new Set(currentSiteData.assignedUsers || []);
  const rows = Object.entries(usersCache).map(([uid, u]) => `
    <label><input type="checkbox" value="${uid}" ${assigned.has(uid) ? "checked" : ""}> ${escapeHtml(u.name || u.email)}</label>
  `).join("") || "<p style='color:var(--muted);font-size:12px;'>No users yet.</p>";

  const overlay = openModal(`
    <h3>Assign users to "${escapeHtml(currentSiteData.name)}"</h3>
    <div class="checkbox-list">${rows}</div>
    <div class="modal-actions">
      <button class="ghost" id="assign-cancel">Cancel</button>
      <button class="primary" style="width:auto;" id="assign-save">Save</button>
    </div>
  `);
  overlay.querySelector("#assign-cancel").addEventListener("click", () => overlay.remove());
  overlay.querySelector("#assign-save").addEventListener("click", async () => {
    const checked = [...overlay.querySelectorAll("input[type=checkbox]:checked")].map((c) => c.value);
    const added = checked.filter((uid) => !assigned.has(uid));
    const removed = [...assigned].filter((uid) => !checked.includes(uid));

    // The Firestore array on the site doc is the source of truth security rules check
    // (see isAssigned() in firestore.rules). The Realtime Database side is a display-only
    // mirror so the admin panel can show each user's assigned-site count.
    await updateDoc(doc(db, "sites", currentSiteId), { assignedUsers: checked });
    for (const uid of added) await set(ref(rtdb, `users/${uid}/assignedSites/${currentSiteId}`), true);
    for (const uid of removed) await remove(ref(rtdb, `users/${uid}/assignedSites/${currentSiteId}`));

    await logAction("site_assigned", `Assigned "${currentSiteData.name}" to: ${checked.map(u => usersCache[u]?.email).join(", ") || "none"}`, currentSiteId);
    currentSiteData.assignedUsers = checked;
    overlay.remove();
  });
});

/* =========================================================
   USERS
   ========================================================= */
const usersTableBody = document.getElementById("users-table-body");

// usersCache is keyed by uid -> { uid, name, email, status, assignedSites, createdAt, createdBy }
function listenToUsers() {
  onValue(ref(rtdb, "users"), (snap) => {
    usersCache = snap.val() || {};
    renderUsersTable();
    renderThreadList();
  });
}

function assignedSiteCount(u) {
  return u.assignedSites ? Object.keys(u.assignedSites).length : 0;
}

function renderUsersTable() {
  usersTableBody.innerHTML = "";
  Object.entries(usersCache).forEach(([uid, u]) => {
    const isActive = u.status === "active";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(u.name || "—")}</td>
      <td>${escapeHtml(u.email)}</td>
      <td><span class="badge ${isActive ? "ok" : "blocked"}">${escapeHtml(u.status || "unknown")}</span></td>
      <td>${assignedSiteCount(u)}</td>
      <td class="row-actions">
        <button data-action="toggle-status" data-uid="${uid}">${isActive ? "Suspend" : "Reactivate"}</button>
        <button data-action="delete" data-uid="${uid}" class="danger">Delete</button>
      </td>`;
    usersTableBody.appendChild(tr);
  });

  // Suspending/reactivating is just a status flag in the Realtime Database — no Admin SDK
  // needed. The login gate in js/auth.js is what actually stops a non-active account.
  usersTableBody.querySelectorAll("button[data-action=toggle-status]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const uid = btn.dataset.uid;
      const nextStatus = usersCache[uid].status === "active" ? "suspended" : "active";
      await update(ref(rtdb, `users/${uid}`), { status: nextStatus });
      await logAction(nextStatus === "active" ? "user_reactivated" : "user_suspended",
        `${nextStatus === "active" ? "Reactivated" : "Suspended"} user ${usersCache[uid].email}`);
    });
  });
  usersTableBody.querySelectorAll("button[data-action=delete]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const uid = btn.dataset.uid;
      const email = usersCache[uid].email;
      if (!confirm(`Delete ${email}'s Cloud-Code profile? This cannot be undone.\n\n` +
        `Note: this removes their access and profile, but their underlying Firebase Auth ` +
        `account isn't deleted (that still requires the Admin SDK / Cloud Functions). ` +
        `Their login attempts will simply be rejected at sign-in.`)) return;
      await remove(ref(rtdb, `users/${uid}`));
      await logAction("user_deleted", `Deleted user profile for ${email}`);
    });
  });
}

document.getElementById("new-user-btn").addEventListener("click", () => {
  const overlay = openModal(`
    <h3>New user</h3>
    <label>Name</label><input type="text" id="nu-name">
    <label>Email</label><input type="email" id="nu-email">
    <label>Temporary password</label><input type="text" id="nu-password">
    <p style="font-size:11px;color:var(--muted);margin:-8px 0 12px;">
      A password reset email is sent to them immediately, so they'll set their own
      password rather than using this one.
    </p>
    <div id="nu-error" style="color:var(--remove);font-size:12px;margin-bottom:8px;"></div>
    <div class="modal-actions">
      <button class="ghost" id="nu-cancel">Cancel</button>
      <button class="primary" style="width:auto;" id="nu-create">Create</button>
    </div>
  `);
  overlay.querySelector("#nu-cancel").addEventListener("click", () => overlay.remove());
  overlay.querySelector("#nu-create").addEventListener("click", async () => {
    const name = overlay.querySelector("#nu-name").value.trim();
    const email = overlay.querySelector("#nu-email").value.trim();
    const password = overlay.querySelector("#nu-password").value;
    const createBtn = overlay.querySelector("#nu-create");
    if (!email || !password) {
      overlay.querySelector("#nu-error").textContent = "Email and temporary password are required.";
      return;
    }
    createBtn.disabled = true;
    createBtn.textContent = "Creating…";
    try {
      const uid = await createAuthUserWithoutSigningOutAdmin(email, password);
      await set(ref(rtdb, `users/${uid}`), {
        uid, name, email, status: "active", assignedSites: null,
        createdAt: Date.now(), createdBy: currentUser.uid
      });
      await logAction("user_created", `Created user ${email}`);
      overlay.remove();
    } catch (err) {
      overlay.querySelector("#nu-error").textContent = err.message || "Could not create user.";
      createBtn.disabled = false;
      createBtn.textContent = "Create";
    }
  });
});

/* =========================================================
   LOGS (admin-only)
   ========================================================= */
function listenToLogs() {
  const q = query(collection(db, "logs"), orderBy("at", "desc"), limit(200));
  onSnapshot(q, (snap) => {
    const body = document.getElementById("logs-table-body");
    body.innerHTML = "";
    snap.forEach((d) => {
      const l = d.data();
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${l.at ? l.at.toDate().toLocaleString() : ""}</td>
        <td>${escapeHtml(l.action)}</td>
        <td>${escapeHtml(l.byName || l.byUid)} (${escapeHtml(l.role || "user")})</td>
        <td>${escapeHtml(l.detail || "")}</td>`;
      body.appendChild(tr);
    });
  });
}

/* =========================================================
   CHAT
   ========================================================= */
let unsubMessages = null;

function listenToThreadsAndChat() {
  // usersCache is kept live by listenToUsers() (Realtime Database) and re-renders the
  // thread list itself whenever it changes — see renderUsersTable().
  onSnapshot(collection(db, "groups"), (snap) => {
    window._groupsCache = {};
    snap.forEach((d) => window._groupsCache[d.id] = d.data());
    renderThreadList();
  });
  onSnapshot(query(collection(db, "chatRequests"), where("status", "==", "pending")), (snap) => {
    const box = document.getElementById("chat-requests");
    box.innerHTML = "";
    snap.forEach((d) => {
      const r = d.data();
      const el = document.createElement("div");
      el.style.cssText = "font-size:11px;color:var(--muted);margin-top:8px;";
      el.innerHTML = `${escapeHtml(usersCache[r.fromUid]?.email || r.fromUid)} wants to chat with ${escapeHtml(usersCache[r.targetUid]?.email || r.targetUid)}
        <div class="row-actions" style="margin-top:4px;">
          <button data-id="${d.id}" data-act="approve">Approve</button>
          <button data-id="${d.id}" data-act="deny">Deny</button>
        </div>`;
      box.appendChild(el);
    });
    box.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const reqSnap = await getDoc(doc(db, "chatRequests", btn.dataset.id));
        const r = reqSnap.data();
        if (btn.dataset.act === "approve") {
          await addDoc(collection(db, "groups"), {
            name: `${usersCache[r.fromUid]?.email || r.fromUid} <> ${usersCache[r.targetUid]?.email || r.targetUid}`,
            members: [r.fromUid, r.targetUid], createdBy: currentUser.uid, createdAt: serverTimestamp()
          });
          await updateDoc(doc(db, "chatRequests", btn.dataset.id), { status: "approved" });
          await logAction("chat_request_approved", `Approved chat between ${r.fromUid} and ${r.targetUid}`);
        } else {
          await updateDoc(doc(db, "chatRequests", btn.dataset.id), { status: "denied" });
        }
      });
    });
  });
}

function renderThreadList() {
  const list = document.getElementById("thread-list");
  list.innerHTML = "<div style='padding:8px 14px;font-size:10px;color:var(--muted);'>USERS</div>";
  Object.entries(usersCache).forEach(([uid, u]) => {
    const item = document.createElement("div");
    item.className = "thread-item" + (currentThread?.type === "user" && currentThread.id === uid ? " active" : "");
    item.innerHTML = `<span class="t-name">${escapeHtml(u.name || u.email)}</span>${u.status && u.status !== "active" ? `<span class='badge blocked'>${escapeHtml(u.status)}</span>` : ""}`;
    item.addEventListener("click", () => openThread("user", uid, u.name || u.email));
    list.appendChild(item);
  });
  list.innerHTML += "<div style='padding:8px 14px;font-size:10px;color:var(--muted);'>GROUPS</div>";
  Object.entries(window._groupsCache || {}).forEach(([gid, g]) => {
    const item = document.createElement("div");
    item.className = "thread-item" + (currentThread?.type === "group" && currentThread.id === gid ? " active" : "");
    item.innerHTML = `<span class="t-name">${escapeHtml(g.name)}</span>`;
    item.addEventListener("click", () => openThread("group", gid, g.name));
    list.appendChild(item);
  });
}

document.getElementById("new-group-btn").addEventListener("click", () => {
  const rows = Object.entries(usersCache).map(([uid, u]) => `
    <label><input type="checkbox" value="${uid}"> ${escapeHtml(u.name || u.email)}</label>
  `).join("") || "<p style='color:var(--muted);font-size:12px;'>No users yet.</p>";
  const overlay = openModal(`
    <h3>New group</h3>
    <label>Group name</label><input type="text" id="grp-name">
    <div class="checkbox-list">${rows}</div>
    <div class="modal-actions">
      <button class="ghost" id="grp-cancel">Cancel</button>
      <button class="primary" style="width:auto;" id="grp-create">Create</button>
    </div>
  `);
  overlay.querySelector("#grp-cancel").addEventListener("click", () => overlay.remove());
  overlay.querySelector("#grp-create").addEventListener("click", async () => {
    const name = overlay.querySelector("#grp-name").value.trim() || "Group";
    const members = [...overlay.querySelectorAll("input[type=checkbox]:checked")].map((c) => c.value);
    await addDoc(collection(db, "groups"), { name, members, createdBy: currentUser.uid, createdAt: serverTimestamp() });
    await logAction("group_created", `Created group "${name}" with ${members.length} member(s)`);
    overlay.remove();
  });
});

function openThread(type, id, label) {
  currentThread = { type, id };
  document.getElementById("chat-empty").style.display = "none";
  document.getElementById("chat-thread").style.display = "flex";
  document.getElementById("chat-title").textContent = label;
  renderThreadList();

  if (unsubMessages) unsubMessages();
  const path = type === "user" ? ["chats", id, "messages"] : ["groups", id, "messages"];
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
  const path = currentThread.type === "user" ? ["chats", currentThread.id, "messages"] : ["groups", currentThread.id, "messages"];
  await addDoc(collection(db, ...path), {
    senderUid: currentUser.uid, senderName: currentUser.email, senderRole: "admin",
    text, at: serverTimestamp()
  });
  input.value = "";
}
