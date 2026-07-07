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
let sitesCache = {}; // siteId -> site doc data (kept live by listenToSites)
let currentThread = null; // { type:'user'|'group', id }
let globalSettings = {}; // settings/global doc (hostingDomain, allowedExtensions, etc.)
let unsubAssets = null;
let pendingExtensions = []; // extensions being edited in Settings, before "Save allowed extensions"

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
  listenToReviewRequests();
  loadSettings();
  wireSectionTabs();
  wireSidebarToggle();
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
    sitesCache = {};
    siteListEl.innerHTML = "";
    snap.forEach((docSnap) => {
      const data = docSnap.data();
      sitesCache[docSnap.id] = data;
      const item = document.createElement("div");
      item.className = "site-item" + (docSnap.id === currentSiteId ? " active" : "");
      const thumb = data.screenshot ? `<img class="site-thumb" src="${data.screenshot}" alt="">` : "";
      item.innerHTML = `<span class="site-item-main">${thumb}<span class="site-item-name">${escapeHtml(data.name)}</span></span><span class="ver-badge">${escapeHtml(data.latestVersionId || "-")}</span>`;
      item.title = data.name;
      item.addEventListener("click", () => selectSite(docSnap.id));
      siteListEl.appendChild(item);
    });
  });
}

function wireSidebarToggle() {
  document.getElementById("sidebar-toggle").addEventListener("click", () => {
    document.getElementById("sites-sidebar").classList.toggle("collapsed");
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
  document.getElementById("sites-sidebar").classList.add("collapsed");
  setTab("html");
  loadHistory(siteId);
  renderScreenshotPreview(currentSiteData.screenshot || null);
  listenAssets(siteId);
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
  if (unsubAssets) { unsubAssets(); unsubAssets = null; }
  currentSiteId = null;
  editorView.style.display = "none";
  emptyState.style.display = "flex";
  document.getElementById("sites-sidebar").classList.remove("collapsed");
});

document.getElementById("copy-loader-btn").addEventListener("click", () => {
  if (!currentSiteId) return;
  const domain = (globalSettings.hostingDomain || "").trim();
  const host = domain ? domain.replace(/^https?:\/\//, "").replace(/\/$/, "") : "YOUR_HOSTING_DOMAIN";
  const snippet = `<script src="https://${host}/loader/site-loader.js" data-site-id="${currentSiteId}"><\/script>`;
  navigator.clipboard.writeText(snippet);
  if (!domain) {
    alert("Loader snippet copied — but no hosting domain is saved yet. Go to Settings and save one so this URL actually works.");
  } else {
    alert("Loader snippet copied.");
  }
});

document.getElementById("site-settings-btn").addEventListener("click", () => {
  if (!currentSiteId) return;
  const overlay = openModal(`
    <h3>Site settings</h3>
    <label>Site name</label><input type="text" id="ss-name" value="${escapeHtml(currentSiteData.name)}">
    <label>GitHub repo URL</label><input type="text" id="ss-repo" value="${escapeHtml(currentSiteData.repo || "")}">
    <label>Description (optional)</label><input type="text" id="ss-desc" value="${escapeHtml(currentSiteData.description || "")}">
    <div class="modal-actions">
      <button class="ghost" id="ss-cancel">Cancel</button>
      <button class="primary" style="width:auto;" id="ss-save">Save</button>
    </div>
  `);
  overlay.querySelector("#ss-cancel").addEventListener("click", () => overlay.remove());
  overlay.querySelector("#ss-save").addEventListener("click", async () => {
    const name = overlay.querySelector("#ss-name").value.trim() || currentSiteData.name;
    const repo = overlay.querySelector("#ss-repo").value.trim();
    const description = overlay.querySelector("#ss-desc").value.trim();
    await updateDoc(doc(db, "sites", currentSiteId), { name, repo, description, updatedAt: serverTimestamp() });
    await logAction("site_settings_updated", `Updated settings for "${name}"`, currentSiteId);
    currentSiteData.name = name;
    currentSiteData.repo = repo;
    currentSiteData.description = description;
    document.getElementById("site-name").textContent = name;
    document.getElementById("site-repo").textContent =
      `${repo || "no repo linked"} · editing v${currentSiteData.latestVersionId} ` +
      `(${currentVersionDoc.editCount || 0}/${MAX_EDITS_PER_VERSION} edits) · live: v${currentSiteData.liveVersionId}`;
    overlay.remove();
  });
});

/* =========================================================
   SITE ASSETS (arbitrary files + a screenshot per site)
   ========================================================= */
const MAX_ASSET_BYTES = 700000; // headroom under Firestore's 1MB document cap

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}

function renderScreenshotPreview(dataUrl) {
  const img = document.getElementById("screenshot-img");
  const ph = document.getElementById("screenshot-placeholder");
  if (dataUrl) { img.src = dataUrl; img.style.display = "block"; ph.style.display = "none"; }
  else { img.removeAttribute("src"); img.style.display = "none"; ph.style.display = "flex"; }
}

function listenAssets(siteId) {
  if (unsubAssets) unsubAssets();
  const list = document.getElementById("asset-list");
  unsubAssets = onSnapshot(collection(db, "sites", siteId, "assets"), (snap) => {
    list.innerHTML = "";
    if (snap.empty) { list.innerHTML = '<p style="font-size:11px;color:var(--muted);">No files yet.</p>'; return; }
    snap.forEach((d) => {
      const a = d.data();
      const kb = a.size ? Math.max(1, Math.round(a.size / 1024)) : 0;
      const row = document.createElement("div");
      row.className = "asset-row";
      row.innerHTML = `
        <span class="asset-name" title="${escapeHtml(a.mime || "")}">${escapeHtml(a.name)}</span>
        <span class="asset-size">${kb}KB</span>
        <a class="asset-dl" href="${a.content}" download="${escapeHtml(a.name)}" title="Download">↓</a>
        <button class="asset-del" data-id="${d.id}" title="Delete">✕</button>`;
      list.appendChild(row);
    });
    list.querySelectorAll(".asset-del").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Delete this file?")) return;
        await deleteDoc(doc(db, "sites", currentSiteId, "assets", btn.dataset.id));
        await logAction("asset_deleted", "Deleted a site file", currentSiteId);
      });
    });
  }, (err) => {
    console.error("[assets]", err);
    list.innerHTML = `<p style="font-size:11px;color:var(--remove);">Failed to load files: ${escapeHtml(err.message)}</p>`;
  });
}

function fileExtension(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || "");
  return m ? m[1].toLowerCase() : "";
}

function isExtensionAllowed(name) {
  const allowed = globalSettings.allowedExtensions || [];
  if (allowed.length === 0) return true; // empty list = no restriction
  return allowed.includes(fileExtension(name));
}

document.getElementById("add-asset-btn").addEventListener("click", () => document.getElementById("asset-input").click());
document.getElementById("asset-input").addEventListener("change", async (e) => {
  if (!currentSiteId) { e.target.value = ""; return; }
  const files = [...e.target.files];
  for (const file of files) {
    if (!isExtensionAllowed(file.name)) {
      alert(`"${file.name}" was not uploaded: ".${fileExtension(file.name) || "?"}" isn't in the allowed file types.\n` +
        `An admin can add it under Settings → Allowed file extensions.`);
      continue;
    }
    if (file.size > MAX_ASSET_BYTES) {
      alert(`"${file.name}" is too large (${Math.round(file.size / 1024)}KB). Keep files under ~${Math.round(MAX_ASSET_BYTES / 1024)}KB.`);
      continue;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      await addDoc(collection(db, "sites", currentSiteId, "assets"), {
        name: file.name, mime: file.type || "application/octet-stream", size: file.size,
        content: dataUrl, uploadedBy: currentUser.uid, createdAt: serverTimestamp()
      });
      await logAction("asset_uploaded", `Uploaded file "${file.name}"`, currentSiteId);
    } catch (err) {
      alert(`Could not upload "${file.name}": ${err.message}`);
    }
  }
  e.target.value = "";
});

document.getElementById("screenshot-btn").addEventListener("click", () => document.getElementById("screenshot-input").click());
document.getElementById("screenshot-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!currentSiteId || !file) { e.target.value = ""; return; }
  if (file.size > MAX_ASSET_BYTES) {
    alert(`Screenshot is too large (${Math.round(file.size / 1024)}KB). Keep it under ~${Math.round(MAX_ASSET_BYTES / 1024)}KB.`);
    e.target.value = "";
    return;
  }
  try {
    const dataUrl = await readFileAsDataUrl(file);
    await updateDoc(doc(db, "sites", currentSiteId), { screenshot: dataUrl, updatedAt: serverTimestamp() });
    currentSiteData.screenshot = dataUrl;
    renderScreenshotPreview(dataUrl);
    await logAction("screenshot_updated", "Updated site screenshot", currentSiteId);
  } catch (err) {
    alert("Could not upload screenshot: " + err.message);
  }
  e.target.value = "";
});

/* =========================================================
   GLOBAL SETTINGS (hosting domain used by every loader snippet)
   ========================================================= */
async function loadSettings() {
  try {
    const snap = await getDoc(doc(db, "settings", "global"));
    globalSettings = snap.exists() ? snap.data() : {};
  } catch (err) {
    console.error("[settings]", err);
    globalSettings = {};
  }
  const input = document.getElementById("hosting-domain-input");
  if (input) input.value = globalSettings.hostingDomain || "";

  pendingExtensions = [...(globalSettings.allowedExtensions || [])];
  renderExtList();
  applyAssetInputAccept();
}

document.getElementById("save-settings-btn").addEventListener("click", async () => {
  const statusEl = document.getElementById("settings-save-status");
  const raw = document.getElementById("hosting-domain-input").value.trim();
  const domain = raw.replace(/^https?:\/\//, "").replace(/\/$/, "");
  try {
    await setDoc(doc(db, "settings", "global"), {
      hostingDomain: domain, updatedAt: serverTimestamp(), updatedBy: currentUser.uid
    }, { merge: true });
    globalSettings.hostingDomain = domain;
    await logAction("settings_updated", `Set hosting domain to "${domain}"`);
    statusEl.textContent = "Saved.";
    statusEl.style.color = "var(--add)";
  } catch (err) {
    statusEl.textContent = "Could not save: " + err.message;
    statusEl.style.color = "var(--remove)";
  }
});

/* =========================================================
   ALLOWED FILE EXTENSIONS (Site file manager, "+ Add file")
   Stored at settings/global.allowedExtensions (array of lowercase
   extensions without the leading dot). Empty array = no restriction.
   ========================================================= */
function normalizeExtension(raw) {
  return raw.trim().toLowerCase().replace(/^\./, "").replace(/[^a-z0-9]/g, "");
}

function renderExtList() {
  const box = document.getElementById("ext-list");
  if (!box) return;
  box.innerHTML = "";
  if (pendingExtensions.length === 0) {
    box.innerHTML = `<p style="font-size:11px;color:var(--muted);margin:0;">No restriction — any file type can be uploaded.</p>`;
    return;
  }
  pendingExtensions.forEach((ext) => {
    const chip = document.createElement("span");
    chip.className = "ext-chip";
    chip.innerHTML = `.${escapeHtml(ext)}<button data-ext="${escapeHtml(ext)}" title="Remove">✕</button>`;
    chip.querySelector("button").addEventListener("click", () => {
      pendingExtensions = pendingExtensions.filter((e) => e !== ext);
      renderExtList();
    });
    box.appendChild(chip);
  });
}

function addExtensionFromInput() {
  const input = document.getElementById("new-ext-input");
  const raw = input.value;
  if (!raw.trim()) return;
  raw.split(",").map(normalizeExtension).filter(Boolean).forEach((ext) => {
    if (!pendingExtensions.includes(ext)) pendingExtensions.push(ext);
  });
  input.value = "";
  renderExtList();
}

document.getElementById("add-ext-btn").addEventListener("click", addExtensionFromInput);
document.getElementById("new-ext-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); addExtensionFromInput(); }
});

function applyAssetInputAccept() {
  const assetInput = document.getElementById("asset-input");
  if (!assetInput) return;
  const exts = globalSettings.allowedExtensions || [];
  assetInput.setAttribute("accept", exts.length ? exts.map((e) => "." + e).join(",") : "");
}

document.getElementById("save-extensions-btn").addEventListener("click", async () => {
  const statusEl = document.getElementById("extensions-save-status");
  try {
    await setDoc(doc(db, "settings", "global"), {
      allowedExtensions: pendingExtensions, updatedAt: serverTimestamp(), updatedBy: currentUser.uid
    }, { merge: true });
    globalSettings.allowedExtensions = [...pendingExtensions];
    applyAssetInputAccept();
    await logAction("settings_updated", `Set allowed file extensions to: ${pendingExtensions.join(", ") || "(any)"}`);
    statusEl.textContent = "Saved.";
    statusEl.style.color = "var(--add)";
  } catch (err) {
    statusEl.textContent = "Could not save: " + err.message;
    statusEl.style.color = "var(--remove)";
  }
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

/* =========================================================
   STATUS REVIEW REQUESTS — submitted by suspended/blocked/
   disabled users from user.html asking to be reactivated.
   ========================================================= */
const reviewRequestsPanel = document.getElementById("review-requests-panel");

function listenToReviewRequests() {
  const q = query(collection(db, "statusReviewRequests"), where("reviewed", "==", false));
  onSnapshot(q, (snap) => renderReviewRequests(snap));
}

function renderReviewRequests(snap) {
  if (snap.empty) {
    reviewRequestsPanel.innerHTML = `<p style="font-size:12px;color:var(--muted);">No pending requests.</p>`;
    return;
  }
  reviewRequestsPanel.innerHTML = "";
  snap.forEach((docSnap) => {
    const r = docSnap.data();
    const row = document.createElement("div");
    row.style.cssText = "border:1px solid var(--border);border-radius:var(--radius);padding:10px 12px;margin-bottom:8px;";
    row.innerHTML = `
      <div style="font-size:13px;"><strong>${escapeHtml(r.name || r.email)}</strong>
        <span class="badge blocked" style="margin-left:6px;">${escapeHtml(r.statusAtRequest || "unknown")}</span>
      </div>
      <div style="font-size:12px;color:var(--muted);margin:4px 0;">${escapeHtml(r.email)}</div>
      ${r.message ? `<div style="font-size:12px;margin:6px 0;">"${escapeHtml(r.message)}"</div>` : ""}
      <div class="row-actions" style="margin-top:6px;">
        <button data-action="approve" data-id="${docSnap.id}" data-uid="${r.uid}">Reactivate</button>
        <button data-action="dismiss" data-id="${docSnap.id}">Dismiss</button>
      </div>`;
    reviewRequestsPanel.appendChild(row);
  });

  reviewRequestsPanel.querySelectorAll("button[data-action=approve]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const uid = btn.dataset.uid;
      await update(ref(rtdb, `users/${uid}`), { status: "active" });
      await updateDoc(doc(db, "statusReviewRequests", btn.dataset.id), { reviewed: true, outcome: "approved" });
      await logAction("user_reactivated", `Reactivated ${usersCache[uid]?.email || uid} via review request`);
    });
  });
  reviewRequestsPanel.querySelectorAll("button[data-action=dismiss]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await updateDoc(doc(db, "statusReviewRequests", btn.dataset.id), { reviewed: true, outcome: "dismissed" });
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

function threadListLabel(text) {
  const label = document.createElement("div");
  label.style.cssText = "padding:8px 14px;font-size:10px;color:var(--muted);";
  label.textContent = text;
  return label;
}

function renderThreadList() {
  const list = document.getElementById("thread-list");
  // IMPORTANT: build this list with real DOM nodes only (createElement/appendChild).
  // Never use `list.innerHTML +=` here — that serializes the whole list (including
  // items that already have addEventListener click handlers attached) back to a
  // string and re-parses it, which silently strips every listener already attached
  // and is why thread items stopped being clickable.
  list.innerHTML = "";
  list.appendChild(threadListLabel("USERS"));
  Object.entries(usersCache).forEach(([uid, u]) => {
    const item = document.createElement("div");
    item.className = "thread-item" + (currentThread?.type === "user" && currentThread.id === uid ? " active" : "");
    item.innerHTML = `<span class="t-name">${escapeHtml(u.name || u.email)}</span>${u.status && u.status !== "active" ? `<span class='badge blocked'>${escapeHtml(u.status)}</span>` : ""}`;
    item.addEventListener("click", () => openThread("user", uid, u.name || u.email));
    list.appendChild(item);
  });
  list.appendChild(threadListLabel("GROUPS"));
  Object.entries(window._groupsCache || {}).forEach(([gid, g]) => {
    const item = document.createElement("div");
    item.className = "thread-item" + (currentThread?.type === "group" && currentThread.id === gid ? " active" : "");
    const siteLabel = g.siteId && sitesCache[g.siteId] ? `<span class="t-site">site: ${escapeHtml(sitesCache[g.siteId].name)}</span>` : "";
    item.innerHTML = `<span class="t-main"><span class="t-name">${escapeHtml(g.name)}</span>${siteLabel}</span><button class="manage-group-btn" data-gid="${gid}" title="Manage group">⚙</button>`;
    item.querySelector(".t-main").addEventListener("click", () => openThread("group", gid, g.name));
    item.querySelector(".manage-group-btn").addEventListener("click", (e) => { e.stopPropagation(); openManageGroupModal(gid); });
    list.appendChild(item);
  });
}

function openManageGroupModal(gid) {
  const g = (window._groupsCache || {})[gid];
  if (!g) return;
  const rows = Object.entries(usersCache).map(([uid, u]) => `
    <label><input type="checkbox" value="${uid}" ${(g.members || []).includes(uid) ? "checked" : ""}> ${escapeHtml(u.name || u.email)}</label>
  `).join("") || "<p style='color:var(--muted);font-size:12px;'>No users yet.</p>";
  const siteOptions = `<option value="">— none —</option>` + Object.entries(sitesCache)
    .map(([sid, s]) => `<option value="${sid}" ${g.siteId === sid ? "selected" : ""}>${escapeHtml(s.name)}</option>`).join("");

  const overlay = openModal(`
    <h3>Manage group</h3>
    <label>Group name</label><input type="text" id="mg-name" value="${escapeHtml(g.name)}">
    <label>Affiliated site (optional)</label>
    <select id="mg-site">${siteOptions}</select>
    <label>Members</label>
    <div class="checkbox-list">${rows}</div>
    <div class="modal-actions">
      <button class="danger" id="mg-delete" style="margin-right:auto;">Delete group</button>
      <button class="ghost" id="mg-cancel">Cancel</button>
      <button class="primary" style="width:auto;" id="mg-save">Save</button>
    </div>
  `);
  overlay.querySelector("#mg-cancel").addEventListener("click", () => overlay.remove());
  overlay.querySelector("#mg-delete").addEventListener("click", async () => {
    if (!confirm(`Delete group "${g.name}"? This cannot be undone.`)) return;
    await deleteDoc(doc(db, "groups", gid));
    await logAction("group_deleted", `Deleted group "${g.name}"`);
    if (currentThread?.type === "group" && currentThread.id === gid) {
      currentThread = null;
      if (unsubMessages) unsubMessages();
      document.getElementById("chat-thread").style.display = "none";
      document.getElementById("chat-empty").style.display = "flex";
    }
    overlay.remove();
  });
  overlay.querySelector("#mg-save").addEventListener("click", async () => {
    const name = overlay.querySelector("#mg-name").value.trim() || g.name;
    const siteId = overlay.querySelector("#mg-site").value || null;
    const members = [...overlay.querySelectorAll("input[type=checkbox]:checked")].map((c) => c.value);
    await updateDoc(doc(db, "groups", gid), { name, siteId, members });
    await logAction("group_updated", `Updated group "${name}" (${members.length} member(s))`);
    overlay.remove();
  });
}

document.getElementById("new-group-btn").addEventListener("click", () => {
  const rows = Object.entries(usersCache).map(([uid, u]) => `
    <label><input type="checkbox" value="${uid}"> ${escapeHtml(u.name || u.email)}</label>
  `).join("") || "<p style='color:var(--muted);font-size:12px;'>No users yet.</p>";
  const siteOptions = `<option value="">— none —</option>` + Object.entries(sitesCache)
    .map(([sid, s]) => `<option value="${sid}">${escapeHtml(s.name)}</option>`).join("");
  const overlay = openModal(`
    <h3>New group</h3>
    <label>Group name</label><input type="text" id="grp-name">
    <label>Affiliated site (optional)</label>
    <select id="grp-site">${siteOptions}</select>
    <div class="checkbox-list">${rows}</div>
    <div class="modal-actions">
      <button class="ghost" id="grp-cancel">Cancel</button>
      <button class="primary" style="width:auto;" id="grp-create">Create</button>
    </div>
  `);
  overlay.querySelector("#grp-cancel").addEventListener("click", () => overlay.remove());
  overlay.querySelector("#grp-create").addEventListener("click", async () => {
    const name = overlay.querySelector("#grp-name").value.trim() || "Group";
    const siteId = overlay.querySelector("#grp-site").value || null;
    const members = [...overlay.querySelectorAll("input[type=checkbox]:checked")].map((c) => c.value);
    await addDoc(collection(db, "groups"), { name, siteId, members, createdBy: currentUser.uid, createdAt: serverTimestamp() });
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
