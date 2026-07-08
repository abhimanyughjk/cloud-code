# 🌩️ Cloud-Code

**A self-hosted control panel for editing and publishing several static websites' HTML, CSS, and JS from one place — no redeploys, no build step, just Firebase.**

![No Build Step](https://img.shields.io/badge/build-none-brightgreen)
![Firebase](https://img.shields.io/badge/backend-Firebase-FFA000?logo=firebase&logoColor=white)
![Vanilla JS](https://img.shields.io/badge/frontend-vanilla%20JS-F7DF1E?logo=javascript&logoColor=black)
![Firebase Plan](https://img.shields.io/badge/Firebase%20plan-Spark%20free-4285F4)

Write a site's code in the browser, click save, and every page embedding the loader script picks it up immediately — no git push, no CI, no redeploy. One panel can manage as many sites as you want, with full version history and role-based access for a team.

## Table of Contents

- [Features](#features)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [How It Works](#how-it-works)
- [Quick Start Checklist](#quick-start-checklist)
- [Beginner Setup Guide](#beginner-setup-guide)
- [Using the Panel](#using-the-panel)
- [Security Rules Reference](#security-rules-reference)
- [Troubleshooting](#troubleshooting)
- [Extending This Project](#extending-this-project)
- [License](#license)

## Features

- 🖥️ **One panel, many sites** — create as many sites as you want, each with its own HTML/CSS/JS.
- 🧑‍🤝‍🧑 **Two roles** — admins manage everything; regular users only see the sites assigned to them.
- 🕒 **Full version history** — every save is kept forever; roll back to any previous version in one click.
- 🔒 **Auto-locking versions** — after 5 edits, a version locks itself and a fresh one opens, so history stays meaningful instead of one giant diff.
- 📝 **Real code editor feel** — HTML/CSS/JS tabs with a synced line-number gutter, on both the admin and user side.
- 📁 **Per-site file manager** — upload files, or create blank ones (`index.html`, `style.css`, `script.js`, …) directly in the panel.
- 🚦 **Live account status** — suspend, block, or disable a user and they're locked out — with an appeal form, not a dead end — the moment their status changes, even mid-session.
- 💬 **Built-in chat** — 1:1 admin↔user threads, admin-managed groups, and user-to-user chat requests that admins approve.
- ⚡ **No build step, no server** — plain HTML/CSS/JS, no `npm install` for the app itself, deploys straight to Firebase Hosting or any static host.
- 🆓 **Runs on Firebase's free Spark plan** — no Cloud Functions, so nothing here requires a paid plan or a credit card on file.

## Tech Stack

| Layer | What it uses |
|---|---|
| Frontend | Plain HTML, CSS, and JavaScript (ES modules) — no framework, no bundler |
| Auth | Firebase Authentication — email/password, plus passwordless email-link sign-in |
| Database | Cloud Firestore (sites, versions, assets, chat, logs) + Realtime Database (user profiles & live status) |
| Hosting | Firebase Hosting, or any static file host — it's just files |
| Firebase SDK | v10.13.0, modular, loaded straight from the `gstatic.com` CDN — no `npm install` needed for the app |

## Project Structure

```
cloud-code/
├── index.html            # Login page — email/password + email-link sign-in, password reset
├── admin.html             # Admin panel: sites, editor, assets, users, settings, chat
├── user.html                # Regular-user panel: assigned sites, editor, status, chat
├── css/
│   └── style.css            # Shared styling for all three pages
├── js/
│   ├── firebase-config.js   # Your Firebase project config + initialized app/auth/db/rtdb
│   ├── auth.js               # Sign-in, routing, password reset, email-link auth
│   ├── admin.js              # All admin-only logic (sites, versions, assets, users, settings)
│   └── user.js                # All regular-user logic (assigned sites, status, chat)
├── loader/
│   └── site-loader.js        # Tiny script a connected site embeds to pull in its content
├── firestore.rules           # Cloud Firestore security rules
├── database.rules.json       # Realtime Database security rules
└── README.md
```

## How It Works

```
GitHub repo (site A) --loader script--> Firestore: sites/{siteId} <--edits-- Panel (you, signed in)
                                               │
                                               ├── versions/{n}   full history
                                               └── assets/{id}    uploaded/created files + screenshot

Realtime Database: users/{uid}    profile + live status (active/suspended/blocked/disabled)
                    admins/{uid}   mirrors the Firestore admin allowlist for RTDB rules
```

- **`index.html`** is sign-in only — there's no public sign-up page. New accounts are created by an admin from inside the panel.
- **`sites/{siteId}`** holds the *currently published* `html`, `css`, `js`, and a version counter. It's the only document that's publicly readable (no login), so the loader script can fetch it from anywhere.
- **`sites/{siteId}/versions/{n}`** is the permanent history of every save — admin or assigned-user only, never exposed publicly.
- **`sites/{siteId}/assets/{id}`** stores extra files (uploaded or created blank) plus the site's screenshot, as base64 data URLs.
- **`users/{uid}`**, in the *Realtime* Database (not Firestore), holds each user's profile and live `status`. It's checked at sign-in and continuously while the panel is open — that's what makes the status lockout instant.
- **`loader/site-loader.js`** is the one file every connected site embeds. It calls the Firestore REST API directly (no SDK, no auth) to fetch that site's current HTML/CSS/JS and injects it into the page.

## Quick Start Checklist

Already comfortable with Firebase? Here's the whole setup at a glance — each item links to the full details below.

1. [What you need](#step-1-what-you-need)
2. [Get the code](#step-2-get-the-code)
3. [Create a Firebase project](#step-3-create-a-firebase-project)
4. [Register a Web App](#step-4-register-a-web-app)
5. [Turn on email/password + email-link sign-in](#step-5-turn-on-email-and-password-sign-in)
6. [Create the Firestore database — **name it `default`**](#step-6-create-the-firestore-database)
7. [Create the Realtime Database](#step-7-create-the-realtime-database)
8. [Paste your config into `js/firebase-config.js`](#step-8-add-your-config-to-the-code)
9. [Install the Firebase CLI](#step-9-install-the-firebase-cli)
10. [`firebase init` — Firestore + Realtime Database + Hosting](#step-10-connect-the-cli-to-your-project)
11. [Deploy `firestore.rules` and `database.rules.json`](#step-11-deploy-the-security-rules)
12. [Deploy hosting](#step-12-host-the-panel)
13. [Create your admin account — Auth + Firestore + RTDB](#step-13-create-your-admin-account)
14. [Sign in and create your first site](#step-14-sign-in-and-create-your-first-site)
15. [Embed the loader snippet in a live site](#step-15-connect-a-live-site-to-the-loader)

## Beginner Setup Guide

> [!NOTE]
> This walks through everything from zero — no prior Firebase experience needed. It takes about 20–30 minutes the first time. Every step is something you click or paste; you won't write any new code.

### Step 1: What You Need

- A **Google account** — Firebase is free for everything this project uses, no credit card required.
- **[Node.js](https://nodejs.org)** installed (any current LTS version) — this gives you `npm`, needed for exactly one thing: installing the Firebase CLI.
- A **code editor** — [VS Code](https://code.visualstudio.com/) is a solid free option if you don't already have one.
- *(Optional)* **[Git](https://git-scm.com/downloads)** — only needed if you'd rather `git clone` than download a ZIP.

### Step 2: Get the Code

Pick whichever feels more comfortable:

**Option A — Download ZIP (no Git needed)**
1. Go to the repo: **https://github.com/abhimanyughjk/cloud-code**
2. Click the green **Code** button → **Download ZIP**.
3. Extract it somewhere memorable, e.g. `Documents/cloud-code`.

**Option B — Git clone**
```bash
git clone https://github.com/abhimanyughjk/cloud-code.git
cd cloud-code
```

From here on, "the project folder" means this folder — the one with `index.html` directly inside it.

### Step 3: Create a Firebase Project

1. Open the [Firebase Console](https://console.firebase.google.com/) and sign in with your Google account.
2. Click **Add project** (or **Create a project**).
3. Name it anything — e.g. `cloud-code` — and click **Continue**.
4. When asked about Google Analytics, you can safely turn it off; this project doesn't use it.
5. Click **Create project** and wait for it to finish setting up.

### Step 4: Register a Web App

1. On the new project's home page, click the **`</>`** (Web) icon to add a web app.
2. Give it a nickname (e.g. `cloud-code-web`) — just a label, doesn't need to match anything.
3. Leave **"Also set up Firebase Hosting"** unchecked — you'll do that with the CLI in Step 12.
4. Click **Register app**, then **Continue to console**. Don't worry about copying the config yet — you'll grab the final version in Step 8, once every service below is switched on.

### Step 5: Turn on Email and Password Sign-In

Cloud-Code signs people in with **email/password**, and optionally a **passwordless email link** — both live under the same Firebase Auth provider.

1. In the left sidebar, under **Build**, click **Authentication** → **Get started**.
2. On the **Sign-in method** tab, click **Email/Password**.
3. Toggle **Email/Password** on. Also toggle on **Email link (passwordless sign-in)** just below it, since the login page offers both.
4. Click **Save**.

> [!IMPORTANT]
> There's no public sign-up page anywhere in this app. Every account — including your own first admin account — is created manually (Step 13) or by an admin from inside the panel afterward. That's intentional: this is a private panel for a team, not a public service.

### Step 6: Create the Firestore Database

1. In the left sidebar, under **Build**, click **Firestore Database** → **Create database**.
2. You'll see a **Database ID** field pre-filled with `(default)`.

> [!WARNING]
> **Clear that field and type exactly:** `default` **— no parentheses.** This code deliberately connects to a Firestore database *named* `default`, not Firebase's special `(default)` database — both `js/firebase-config.js` and `loader/site-loader.js` call this out directly. Skip it, and the app fails the first time it touches Firestore, with an error like `database (default) does not exist`.
>
> **Already created it as `(default)`?** No need to start over — after Step 8, open `js/firebase-config.js` and change `getFirestore(app, "default")` to just `getFirestore(app)`. That points the code at whichever database already exists.

3. Choose a location close to you (this can't be changed later) and click **Next**.
4. Choose **Start in production mode** — you'll deploy this repo's real rules in Step 11 anyway, so there's no reason to start wide open.
5. Click **Create**.

### Step 7: Create the Realtime Database

This is a separate product from Firestore, used only for user profiles and live status.

1. In the left sidebar, under **Build**, click **Realtime Database** → **Create Database**.
2. Choose a location and click **Next**.
3. Choose **Start in locked mode** and click **Enable**.

### Step 8: Add Your Config to the Code

1. Click the **⚙️ gear icon** next to "Project Overview" → **Project settings**.
2. Scroll to **Your apps** and find the web app from Step 4.
3. Under **SDK setup and configuration**, select **Config** — you'll see an object like this:

```js
const firebaseConfig = {
  apiKey: "AIzaSy...",
  authDomain: "your-project.firebaseapp.com",
  databaseURL: "https://your-project-default-rtdb.<region>.firebasedatabase.app",
  projectId: "your-project",
  storageBucket: "your-project.firebasestorage.app",
  messagingSenderId: "...",
  appId: "1:...:web:..."
};
```

4. In the project folder, open **`js/firebase-config.js`**.
5. Replace the existing `firebaseConfig` object's seven values with your own from the console. Leave the variable names and the rest of the file exactly as they are.
6. Save the file.

> [!NOTE]
> These are all client-side identifiers, not secrets — Firebase enforces access with the security rules from Step 11, not by hiding this config. It's normal for this file to sit in a public GitHub repo.

### Step 9: Install the Firebase CLI

In a terminal, run:

```bash
npm install -g firebase-tools
firebase login
```

The second command opens a browser window — sign in with the same Google account you used in Step 3.

### Step 10: Connect the CLI to Your Project

From inside the project folder (the one with `index.html` in it):

```bash
firebase init
```

Answer the prompts like this:

1. **"Which Firebase features do you want to set up?"** → select **Firestore**, **Realtime Database**, and **Hosting** (Space to select each, Enter to confirm). Leave everything else unselected.
2. **"Please select an option"** → **Use an existing project** → pick the project from Step 3.
3. **"What file should be used for Firestore Rules?"** → press Enter to accept `firestore.rules`.
4. **"File firestore.rules already exists. Overwrite?"** → type **N**.

> [!WARNING]
> Always answer **N (No)** to any "overwrite" prompt for `firestore.rules` or `database.rules.json`. Those files already contain this project's real security rules — overwriting them with the CLI's blank template would leave your database wide open.

5. **"What file should be used for Firestore indexes?"** → press Enter to accept the default (this file doesn't exist yet, so it's fine to let the CLI create it).
6. **"What file should be used for Realtime Database Rules?"** → press Enter to accept `database.rules.json`.
7. **"File database.rules.json already exists. Overwrite?"** → type **N**.
8. **"What do you want to use as your public directory?"** → type a single dot: `.`
9. **"Configure as a single-page app (rewrite all urls to /index.html)?"** → type **N**.
10. **"Set up automatic builds and deploys with GitHub?"** → type **N**.
11. **"File ./index.html already exists. Overwrite?"** → type **N**.

This generates a `firebase.json` and `.firebaserc` in the project folder without touching any existing file.

<details>
<summary>Prefer to skip the wizard? Create <code>firebase.json</code> by hand</summary>

Create a new file named `firebase.json` in the project folder:

```json
{
  "firestore": {
    "rules": "firestore.rules"
  },
  "database": {
    "rules": "database.rules.json"
  },
  "hosting": {
    "public": ".",
    "ignore": ["firebase.json", "**/.*", "**/node_modules/**"]
  }
}
```

Then run `firebase use --add` and pick your project — that generates `.firebaserc` for you.
</details>

### Step 11: Deploy the Security Rules

```bash
firebase deploy --only firestore:rules,database
```

This pushes `firestore.rules` and `database.rules.json` to your project — see [Security Rules Reference](#security-rules-reference) for what they actually enforce.

### Step 12: Host the Panel

```bash
firebase deploy --only hosting
```

When it finishes, it prints a **Hosting URL** like `https://your-project.web.app` — that's your panel's address.

> [!TIP]
> This app is just static files, so Firebase Hosting isn't mandatory — GitHub Pages, Netlify, Vercel, or any static host works too. Firebase Hosting is simplest here since the CLI is already set up, and it's free.

### Step 13: Create Your Admin Account

An admin account needs to exist in **three** places. This is the fiddliest step — follow it in order.

**a) Create the sign-in credentials**
1. In the Firebase Console, go to **Authentication → Users → Add user**.
2. Enter your email and a password, click **Add user**.
3. Copy the **User UID** shown in the table — you'll need it below.

**b) Add yourself to the Firestore admin allowlist**
1. Go to **Firestore Database → Data → Start collection**, collection ID: `admins`.
2. For **Document ID**, paste your **User UID** from step (a).
3. Add one field: `email` (type *string*) → your email address. Click **Save**.

**c) Mirror yourself into the Realtime Database admin list**
1. Go to **Realtime Database → Data**.
2. Hover the root node, click **+** to add a child named `admins`.
3. Under it, add a child named **your User UID**, with value `true` (boolean).

Your tree should read `admins / <your-uid> / true`.

> [!NOTE]
> Both allowlists exist because Firestore rules can't read the Realtime Database, and vice versa — each database needs its own copy of "who's an admin." `admin.js` keeps both in sync automatically when you create users through the panel; this manual step is only needed once, for your very first account.

### Step 14: Sign In and Create Your First Site

1. Open your Hosting URL and sign in with the email/password from Step 13a.
2. You should land on `admin.html`. If you're bounced back to the login page with an error, see [Troubleshooting](#troubleshooting).
3. Click **+ New site**, give it a name, and optionally its GitHub repo URL.
4. Type something into the HTML tab and click **Save new version**.

### Step 15: Connect a Live Site to the Loader

To make a real website pull its content from Cloud-Code:

1. In the panel, open the site and note its **Site ID**, plus your **Hosting URL** from Step 12.
2. In that site's own repo, add this near the end of `<body>` in its `index.html`:

```html
<script
  src="https://YOUR_HOSTING_DOMAIN/loader/site-loader.js"
  data-site-id="YOUR_SITE_ID">
</script>
```

3. Replace `YOUR_HOSTING_DOMAIN` with your Hosting URL's domain (e.g. `your-project.web.app`) and `YOUR_SITE_ID` with the site's ID.
4. Deploy that site as usual, wherever it lives. The loader fetches the site's published HTML/CSS/JS straight from Firestore — read-only, no login required — and injects it into the page.

🎉 That's the full setup. Everything below is day-to-day use.

---

## Using the Panel

### Roles
- **Admin** (`admin.html`) — full access: create/delete sites, manage users, assign sites, moderate chat, configure settings.
- **User** (`user.html`) — only sees sites assigned to them; can edit code and chat, nothing else.

### Sites and Versioning
- Each site has three code tabs: **HTML**, **CSS**, **JS**.
- **Save new version** writes a new entry to that site's permanent history.
- A version **locks** automatically after **5 edits**, and a fresh unlocked version opens — keeping history broken into meaningful chunks instead of one endless diff.
- Any past version can be restored, which creates a new unlocked version with that content — nothing is ever deleted.

### Code Editor
Every code tab has a **line-number gutter**, synced to typing, scrolling, and tab switches — identical behavior on both `admin.html` and `user.html`.

### Site Assets (File Manager)
Admin-only, per site:
- **+ Add file** uploads a file from disk (capped around 683KB per file, to stay comfortably under Firestore's 1MB document limit).
- **+ Create file** makes a *blank* file without uploading anything — pick an extension and a name; it defaults to `index.html` / `style.css` / `script.js` for those extensions, or `untitled.<ext>` otherwise.
- **Settings → Allowed file extensions** restricts what both buttons accept. Leave it empty to allow anything.

### User Status and the Lockout Modal
Admins set each user's status to `active`, `suspended`, `blocked`, or `disabled` from **Users**. Whenever a signed-in user's status isn't `active`:
- A modal opens automatically — on page load, and instantly on any live status change — asking them to submit a note for an admin to review.
- It **can't be dismissed** by clicking outside it; it only goes away once an admin sets the account back to `active`.
- Every mutating action (saving code, sending messages) is re-checked against live status too, so this isn't only a UI-level lock.

### Chat
- **1:1** — every user has one persistent thread with admins.
- **Groups** — admin-created, admin-managed membership.
- **Chat requests** — a user can request to chat with another user; an admin approves or denies before the thread opens.

---

## Security Rules Reference

Full rules live in [`firestore.rules`](./firestore.rules) and [`database.rules.json`](./database.rules.json), deployed in Step 11.

| Path | Who can read | Who can write |
|---|---|---|
| `sites/{id}` | anyone — the loader needs public read | admin creates/deletes; admin or an assigned user updates |
| `sites/{id}/versions/{n}` | admin or assigned user | admin or assigned user, only on the unlocked version |
| `sites/{id}/assets/{id}` | admin or assigned user | admin or assigned user |
| `admins/{uid}` | that admin, about themselves | nobody — Console only |
| `settings/{doc}` | admin | admin |
| `logs/{id}` | admin | any signed-in user, for their own actions |
| `chats/{uid}/messages` | admin or that user | admin or that user |
| `groups/{id}/messages` | admin or members | admin or members |
| `chatRequests/{id}` | admin or the requester | created by the requester; approved by admin |
| `statusReviewRequests/{id}` | admin or that user | created by that user; resolved by admin |
| RTDB `users/{uid}` | that user, or any admin | admin only |
| RTDB `admins/{uid}` | any signed-in user | nobody — Console only |

> [!NOTE]
> A suspended user's Firestore access isn't gated by their `status` flag directly — Firestore can't read the Realtime Database where that flag lives. Real enforcement is (1) the status check at sign-in and on every mutating action in `user.js`, and (2) unassigning a suspended user from their sites, which makes the `isAssigned()` rule stop passing for them immediately.

---

## Troubleshooting

<details>
<summary><strong>"Missing or insufficient permissions" right after signing in</strong></summary>

Almost always means Step 13 is incomplete — you're missing either the Firestore `admins/{uid}` doc or the Realtime Database `admins/{uid}: true` entry. Double-check both, and make sure the document ID / node name is your exact User UID from Authentication → Users.
</details>

<details>
<summary><strong>"database (default) does not exist" or similar Firestore errors</strong></summary>

Your Firestore database wasn't named `default` when created — see the warning in [Step 6](#step-6-create-the-firestore-database). Either create a new database with ID `default`, or edit `js/firebase-config.js` and change `getFirestore(app, "default")` to `getFirestore(app)`.
</details>

<details>
<summary><strong>Stuck on the login page, or "Could not verify account status"</strong></summary>

Usually means the Realtime Database rules haven't been deployed, or your account has no `users/{uid}` record and isn't in either admin allowlist. Re-run Step 11, and confirm your account exists in exactly one of the two allowlists from Step 13.
</details>

<details>
<summary><strong>Email-link sign-in says the link is invalid</strong></summary>

Email links expire and are single-use. Also check **Authentication → Settings → Authorized domains** includes the domain you opened the login page from — Firebase Hosting domains and `localhost` are added automatically; custom domains need to be added by hand.
</details>

<details>
<summary><strong>A connected site shows nothing, or logs a loader error</strong></summary>

Open the browser console on that site. A 404/"not found" usually means `data-site-id` doesn't match a real site, or `firestore.rules` from this repo hasn't been deployed yet — the loader needs public read access to `sites/{id}`.
</details>

---

## Extending This Project

A few things worth knowing if you build on this:

- **No Cloud Functions, by design** — everything runs on Firebase's free Spark plan. If you outgrow that (e.g. sending real emails on status changes), a Cloud Function is the natural next step, which needs the Blaze (pay-as-you-go) plan.
- **A couple of unused CSS classes** — `#status-banner` and `.review-request-box` are leftovers from an earlier version of the status UI. Harmless, safe to remove if you're cleaning up.
- **Duplication is intentional** — `admin.js` and `user.js` repeat some constants and small helpers rather than sharing a module, to keep the project buildless. If you introduce a bundler later, that's a natural first refactor.

## License

No license file is included yet. If you plan to let others use, fork, or contribute to this, consider adding a `LICENSE` — [MIT](https://choosealicense.com/licenses/mit/) is a common, permissive default for a project like this.

---

Built without a single `npm run build`. 🌩️
