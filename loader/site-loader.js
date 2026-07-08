// Cloud-Code loader.
// Add this in the site's GitHub repo:
// <script src="https://YOUR_HOSTING_DOMAIN/loader/site-loader.js" data-site-id="YOUR_SITE_ID"></script>
//
// Optional attributes on the same <script> tag:
//   data-loader-html    custom HTML shown while the site loads (default: a small spinner)
//   data-loader-timeout milliseconds before giving up (default: 10000)
//   data-loader-cache   set to "false" to disable the localStorage cache (default: on)
//
// It fetches the site's currently published version from Firestore (public read-only)
// and injects it into the page. No auth, no write access.
//
// Supports any number of editable files (not just a fixed html/css/js trio):
// the site doc's `files` map holds every file, `fileOrder` controls apply
// order, and `entryFile` marks which one is rendered as the page body. Every
// other .css file becomes a <style>, every other .js file executes, in order.
// Sites saved before multi-file support existed (plain html/css/js fields)
// are still read correctly via an automatic fallback.
//
// Other improvements over the original:
//  - Visible loading indicator instead of a blank page while the fetch is in flight.
//  - Instant repaint from a cached copy on repeat visits, refreshed in the background.
//  - Timeout + friendly on-page error message (in addition to console logging).
//  - Guards against double-init if the script tag ends up on the page twice.

(function () {
  const thisScript = document.currentScript;
  const siteId = thisScript && thisScript.getAttribute("data-site-id");

  if (!siteId) {
    console.error("[cloud-code] Missing data-site-id on loader script tag.");
    return;
  }

  // Avoid loading the same site twice if the tag is accidentally included more than once.
  window.__cloudCodeSites = window.__cloudCodeSites || new Set();
  if (window.__cloudCodeSites.has(siteId)) return;
  window.__cloudCodeSites.add(siteId);

  const TIMEOUT_MS = parseInt(thisScript.getAttribute("data-loader-timeout"), 10) || 10000;
  const USE_CACHE = thisScript.getAttribute("data-loader-cache") !== "false";
  const CACHE_KEY = `cloud-code:${siteId}`;

  // Only projectId is actually needed for the public REST read below.
  const PROJECT_ID = "cloud-code-db99e";

  // NOTE: this project's Firestore database is named "default" (a named database),
  // not the reserved "(default)" database id — using "(default)" here 404s.
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/default/documents/sites/${siteId}`;

  // ---- Loading indicator --------------------------------------------------
  const loaderStyle = document.createElement("style");
  loaderStyle.textContent = `
    #cloud-code-loader {
      position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
      background: #0b0b0f; z-index: 2147483647; transition: opacity .25s ease;
    }
    #cloud-code-loader .cc-spinner {
      width: 36px; height: 36px; border-radius: 50%;
      border: 3px solid rgba(255,255,255,0.15); border-top-color: rgba(255,255,255,0.85);
      animation: cc-spin .8s linear infinite;
    }
    @keyframes cc-spin { to { transform: rotate(360deg); } }
    #cloud-code-root { opacity: 0; transition: opacity .25s ease; }
    #cloud-code-root.cc-visible { opacity: 1; }
  `;
  document.head.appendChild(loaderStyle);

  const customLoaderHtml = thisScript.getAttribute("data-loader-html");
  const loaderEl = document.createElement("div");
  loaderEl.id = "cloud-code-loader";
  loaderEl.innerHTML = customLoaderHtml || `<div class="cc-spinner" role="status" aria-label="Loading"></div>`;
  document.documentElement.appendChild(loaderEl);

  function removeLoader() {
    if (!loaderEl.parentNode) return;
    loaderEl.style.opacity = "0";
    setTimeout(() => loaderEl.remove(), 250);
  }

  function showError(message) {
    loaderEl.innerHTML = `
      <div style="color:#f2a3a3;font:14px/1.4 system-ui,sans-serif;text-align:center;max-width:320px;padding:0 16px;">
        Couldn't load this page.<br><span style="opacity:.7">${message}</span>
      </div>`;
  }

  // Some sites store a full document (<!DOCTYPE>, <html>, <head>, <body>) in the
  // html field — e.g. whatever the starter template shipped, boilerplate
  // <link rel="stylesheet" href="style.css"> and <script src="script.js">
  // tags included. Those files don't exist on the static host (the repo only
  // contains index.html + this loader), so they 404. The real CSS/JS for the
  // site are the separate css/js fields already injected below, so this pulls
  // out just the <body> content and drops any relative-path <link>/<script>
  // tags. Absolute URLs (CDNs, fonts, etc.) are left untouched. Along the way,
  // <title> and the description <meta> — if present — are applied to the real
  // page so basic SEO/tab-title still works even though only body content is injected.
  function extractBodyContent(rawHtml) {
    try {
      const doc = new DOMParser().parseFromString(rawHtml, "text/html");

      const titleEl = doc.querySelector("title");
      if (titleEl && titleEl.textContent) document.title = titleEl.textContent;

      const descEl = doc.querySelector('meta[name="description"]');
      if (descEl && descEl.content) {
        let liveDesc = document.head.querySelector('meta[name="description"]');
        if (!liveDesc) {
          liveDesc = document.createElement("meta");
          liveDesc.name = "description";
          document.head.appendChild(liveDesc);
        }
        liveDesc.content = descEl.content;
      }

      const isRelative = (u) => !!u && !/^([a-z]+:)?\/\//i.test(u);
      doc.querySelectorAll('link[rel="stylesheet"][href]').forEach((el) => {
        if (isRelative(el.getAttribute("href"))) el.remove();
      });
      doc.querySelectorAll("script[src]").forEach((el) => {
        if (isRelative(el.getAttribute("src"))) el.remove();
      });

      return doc.body ? doc.body.innerHTML : rawHtml;
    } catch (e) {
      return rawHtml;
    }
  }

  function extOf(name) {
    const m = /\.([a-z0-9]+)$/i.exec(name || "");
    return m ? m[1].toLowerCase() : "";
  }

  // ---- Render ---------------------------------------------------------------
  // `files` is a filename -> content map (any number of files, not just a fixed
  // html/css/js trio). `order` controls the sequence css/js files are applied
  // in, which matters when one script depends on another. `entryFile` is the
  // one file rendered as the actual page body; every other .css file becomes a
  // <style>, every other .js file gets executed, in order — the same "always
  // applied" behavior the old fixed css/js fields had, just generalized to N
  // files. Anything else (e.g. a .json or .svg file) is stored/versioned but
  // not auto-injected; it's only useful if something else reads it by name,
  // which isn't supported by this loader.
  function render({ files, order, entryFile }) {
    const names = order && order.length ? order : Object.keys(files || {});
    if (!names.length) return removeLoader();

    const entryHtml = entryFile && files[entryFile] != null ? files[entryFile] : "";
    if (entryHtml) {
      const container = document.createElement("div");
      container.id = "cloud-code-root";
      container.innerHTML = extractBodyContent(entryHtml);
      document.body.appendChild(container);
      requestAnimationFrame(() => container.classList.add("cc-visible"));
    }

    names.forEach((name) => {
      if (name === entryFile) return;
      const ext = extOf(name);
      if (ext === "css") {
        const styleEl = document.createElement("style");
        styleEl.textContent = files[name];
        document.head.appendChild(styleEl);
      } else if (ext === "js" || ext === "mjs") {
        const scriptEl = document.createElement("script");
        scriptEl.textContent = files[name];
        document.body.appendChild(scriptEl);
      }
    });

    removeLoader();
  }

  function parseDoc(doc) {
    const fields = doc.fields || {};
    const filesField = fields.files && fields.files.mapValue && fields.files.mapValue.fields;

    let files = {};
    let order = [];

    if (filesField) {
      Object.keys(filesField).forEach((name) => {
        files[name] = filesField[name].stringValue || "";
      });
      const orderField = fields.fileOrder && fields.fileOrder.arrayValue && fields.fileOrder.arrayValue.values;
      order = orderField
        ? orderField.map((v) => v.stringValue).filter((n) => files[n] !== undefined)
        : [];
      Object.keys(files).forEach((n) => { if (!order.includes(n)) order.push(n); });
    } else {
      // Legacy 3-field schema, from before multi-file support existed.
      if (fields.html?.stringValue) files["index.html"] = fields.html.stringValue;
      if (fields.css?.stringValue) files["style.css"] = fields.css.stringValue;
      if (fields.js?.stringValue) files["script.js"] = fields.js.stringValue;
      order = Object.keys(files);
    }

    const entryFile =
      (fields.entryFile && fields.entryFile.stringValue && files[fields.entryFile.stringValue] !== undefined && fields.entryFile.stringValue) ||
      (files["index.html"] !== undefined ? "index.html" : order.find((n) => /\.html?$/i.test(n))) ||
      null;

    return { files, order, entryFile, versionId: fields.liveVersionId?.stringValue || "" };
  }

  function readCache() {
    if (!USE_CACHE) return null;
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function writeCache(data) {
    if (!USE_CACHE) return;
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(data));
    } catch (e) {
      // storage full or disabled — not fatal, just skip caching
    }
  }

  // Paint a cached copy instantly (if any) while the network fetch runs. This
  // makes repeat visits feel instant and avoids a spinner flash every time.
  const cached = readCache();
  if (cached) render(cached);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  fetch(url, { signal: controller.signal })
    .then((res) => {
      clearTimeout(timeoutId);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then((doc) => {
      const data = parseDoc(doc);
      if (!Object.keys(data.files).length) {
        throw new Error("Site has no published content yet");
      }

      if (cached && cached.versionId && cached.versionId === data.versionId) {
        // Already showing the current version — nothing more to do.
        removeLoader();
        return;
      }

      writeCache(data);

      if (cached) {
        // Something newer arrived after we'd already painted the cached
        // version. Re-running injected JS in place risks double-initializing
        // it (e.g. a second animation loop), so reload once to apply the
        // update cleanly. The next visit will load the fresh version from
        // cache instantly with no reload needed.
        location.reload();
        return;
      }

      render(data);
    })
    .catch((err) => {
      clearTimeout(timeoutId);
      const message =
        err.name === "AbortError" ? "Timed out — check your connection." : err.message;
      console.error("[cloud-code] Failed to load site content:", err);
      if (!cached) showError(message);
      else removeLoader();
    });
})();