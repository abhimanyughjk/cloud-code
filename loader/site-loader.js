// Cloud-Code loader.
// Add this in the site's GitHub repo:
// <script src="https://YOUR_HOSTING_DOMAIN/loader/site-loader.js" data-site-id="YOUR_SITE_ID"></script>
//
// It fetches the site's currently published version from Firestore (public read-only)
// and injects the HTML/CSS/JS into the page. No auth, no write access.

(async function () {
  const thisScript = document.currentScript;
  const siteId = thisScript.getAttribute("data-site-id");
  if (!siteId) {
    console.error("[cloud-code] Missing data-site-id on loader script tag.");
    return;
  }

  const firebaseConfig = {
    apiKey: "AIzaSyDmfjad1r45YG3nnVWh6yuMyeNYc1KPyR8",
    authDomain: "cloud-code-db99e.firebaseapp.com",
    projectId: "cloud-code-db99e",
    appId: "1:33867123556:web:fe55e262a274e6087a8871"
  };

  // Firestore REST endpoint avoids needing the full SDK on every connected site.
  // NOTE: this project's Firestore database is named "default" (a named database),
  // not the reserved "(default)" database id — using "(default)" here 404s.
  const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/default/documents/sites/${siteId}`;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Site not found or not readable (HTTP ${res.status})`);
    const doc = await res.json();
    const fields = doc.fields || {};
    const html = fields.html?.stringValue || "";
    const css = fields.css?.stringValue || "";
    const js = fields.js?.stringValue || "";

    if (html) {
      const container = document.createElement("div");
      container.id = "cloud-code-root";
      container.innerHTML = html;
      document.body.appendChild(container);
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
  } catch (err) {
    console.error("[cloud-code] Failed to load site content:", err);
  }
})();
