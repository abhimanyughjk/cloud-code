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
// and injects the HTML/CSS/JS into the page. No auth, no write access.
//
// Improvements over the original:
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

  // ---- Render ---------------------------------------------------------------
  function render({ html, css, js }) {
    if (html) {
      const container = document.createElement("div");
      container.id = "cloud-code-root";
      container.innerHTML = extractBodyContent(html);
      document.body.appendChild(container);
      requestAnimationFrame(() => container.classList.add("cc-visible"));
    }
    if (css) {
      const styleEl = document.createElement("style");
      styleEl.textContent = css;
      document.head.appendChild(styleEl);
    }
    if (js) {
      const scriptEl = document.createElement("script");
      scriptEl.textContent = js;
      document.body.appendChild(scriptEl);
    }
    removeLoader();
  }

  function parseDoc(doc) {
    const fields = doc.fields || {};
    return {
      html: fields.html?.stringValue || "",
      css: fields.css?.stringValue || "",
      js: fields.js?.stringValue || "",
      versionId: fields.liveVersionId?.stringValue || "",
    };
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
      if (!data.html && !data.css && !data.js) {
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