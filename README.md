# Cloud-Code

A panel for managing the live code of many websites from one place, backed by Firebase.
Connected sites stop reading their code from GitHub — GitHub only hosts a tiny loader
snippet that pulls the real HTML/CSS/JS from Firestore at runtime. Editing code in the
panel updates every visitor instantly, with full version history and one-click rollback.

## How it fits together

```
GitHub repo (site A)  --loader script-->  Firestore: sites/{siteId}  <--edits-- Panel (you, logged in)
                                                 |
                                                 +-- versions/{n}  (full history)
                                                 +-- appdata/{uid} (optional per-site user data)

Realtime Database: users/{uid}  <-- profile + status (active/suspended), written by admin.html
                    admins/{uid} <-- mirrors the Firestore admins allowlist for RTDB rules
```

- **Login** (`index.html`) routes to **`admin.html`** (full panel) or **`user.html`** (assigned-sites
  + chat only) based on the signed-in account's role. Sign-in only — there is no registration screen,
  and no signup call is made anywhere in the code except from the admin panel's "+ New user" flow.
- **`sites/{siteId}`**: holds the *currently published* `html`, `css`, `js` and a `version` number.
  This document is publicly readable (no login) so the loader script on each live site can fetch it,
  but only an admin can write to it.
- **`sites/{siteId}/versions/{n}`**: immutable history of every save. Admin read/write only —
  never exposed to the public site.
- **`loader/site-loader.js`**: the file each connected GitHub repo embeds. It fetches the site's
  `sites/{siteId}` doc via the Firestore REST API (no SDK needed on the target site) and injects
  the HTML/CSS/JS into the page.
- **`sites/{siteId}/appdata/{uid}`** (optional): if a connected site wants its own visitors to sign in
  and store personal data, this pattern keeps every site's user data isolated from every other site.
- **`users/{uid}`** (Realtime Database, not Firestore): each user's profile and live `status`
  (`active` / `suspended`), created by the admin panel and checked at every sign-in and page load.
  See "User management" below for the full picture.

## Setup

1. **Enable Email/Password sign-in**
   Firebase Console → Authentication → Sign-in method → enable *Email/Password*.
   Do **not** enable any other provider or self-serve signup. There is still no public sign-up
   screen — `createUserWithEmailAndPassword` is only ever called from `admin.html → Users → + New user`
   (see the "User management" section below for how that avoids signing the admin out).

2. **Create your admin account**
   Firebase Console → Authentication → Users → *Add user* (enter your email + a password).
   Copy the generated **UID**.

3. **Add yourself to the admins allowlist — in both databases**
   - Firebase Console → Firestore → create collection `admins` → document ID = the UID from step 2 → add field `email` (string).
     This is what `firestore.rules` checks to decide who can write to `sites`, `logs`, etc.
   - Firebase Console → Realtime Database → create node `admins/{same UID}` → value `true`.
     This is what `database.rules.json` checks to decide who can read/write the `users` node
     (Realtime Database rules can't read Firestore, so the allowlist is mirrored — keep both
     in sync whenever you add or remove an admin).

4. **Deploy the security rules**
   ```bash
   firebase deploy --only firestore:rules,database
   ```
   (uses `firestore.rules` for sites/chat/logs and `database.rules.json` for the Realtime
   Database's `users`/`admins` nodes — see Setup step 3 for why both matter.)

5. **Host the panel**
   Firebase Hosting, GitHub Pages, or any static host works — it's plain HTML/JS, no build step.
   ```bash
   firebase deploy --only hosting
   ```

6. **Connect a site**
   - Open the panel, sign in, click **+ New site**, give it a name and (optionally) its GitHub repo URL.
   - Write the site's HTML/CSS/JS in the editor tabs and click **Save new version**.
   - Click **Copy loader snippet** and paste it into that site's GitHub repo, e.g. in `index.html`:
     ```html
     <script src="https://YOUR_HOSTING_DOMAIN/loader/site-loader.js" data-site-id="abc123"></script>
     ```
   - From then on, editing the site's code in the panel updates the live site immediately —
     no commits, pushes, or redeploys of that repo needed.

7. **Versioning**
   Every **Save new version** adds a new entry to the commit-log panel on the right, with an
   optional message. Click **Restore this version** on any past entry to instantly point the
   live site back at that version's code (this doesn't delete history — it just changes what's published).

## User management, roles, chat & versioning (v2)

**Roles**: `admins/{uid}` (full panel, allowlisted in both Firestore and the Realtime Database —
see Setup step 3), `users/{uid}` (assigned-sites-only). There is still no public sign-up screen
anywhere — every account is created by an admin.

**Creating real accounts runs entirely on the client SDK — no Cloud Functions, no Admin SDK, no
Blaze plan.** The only genuinely tricky part is that `createUserWithEmailAndPassword` signs
*whoever calls it* into the new account — on the admin's own Firebase app instance, that would log
the admin out of their own session. `admin.html → Users → + New user` works around this by:

1. Spinning up a second, throwaway Firebase app instance (`initializeApp(config, "secondary-…")`)
   just for the create call, so the admin's real session in the main app is never touched.
2. Calling `createUserWithEmailAndPassword` on that secondary instance with the email + temporary
   password the admin entered.
3. Immediately calling `sendPasswordResetEmail` for that address, so the new user sets their own
   password by email instead of ever relying on the admin-chosen temp one.
4. Signing out of and deleting the secondary app instance.
5. Writing the profile — `uid`, `name`, `email`, `status: "active"`, `assignedSites`, `createdAt`,
   `createdBy` — to `users/{uid}` in the **Realtime Database** (not Firestore).

**Blocking/unblocking and deleting are just Realtime Database writes**, not Auth-level operations
— no Admin SDK is involved:
- **Suspend/Reactivate** flips `users/{uid}.status` between `"active"` and `"suspended"`.
- **Delete** removes the `users/{uid}` node entirely. This deletes their Cloud-Code *profile and
  access*, but not the underlying Firebase Auth account itself (that still requires the Admin SDK)
  — a deleted user's Auth login will simply fail the status check below and land back at the
  sign-in screen.

All three actions are also written to the `logs` collection (Firestore) automatically.

**Enforcing status at login/session time**: both `index.html` (`js/auth.js`, right after sign-in)
and `user.html` (`js/user.js`, on every load) read `users/{uid}` from the Realtime Database and
check `status` *before* granting any further access. Anything other than `"active"` shows that
status as a notice on the sign-in screen, signs the session back out, and stops — the account never
reaches `user.html` or any site/chat data. Because Firestore's security rules can't read the
Realtime Database, this app-level check is the primary enforcement; `firestore.rules` documents
this trade-off and recommends also unassigning a suspended user's sites for defense in depth.

**Sign-in options**: alongside email + password, the sign-in screen (`index.html`) also offers
**Forgot password?** (`sendPasswordResetEmail`) and **Email me a sign-in link** — passwordless
sign-in via `sendSignInLinkToEmail` / `signInWithEmailLink` — since users are never expected to
keep using the admin-set temporary password.

**Assigning sites**: `admin.html → Sites → Assign users` lets you check which users can edit a given
site. This writes `sites/{id}.assignedUsers` in Firestore — the security rules only allow a
non-admin to write to a site if their uid is in that array, so this is the actual access-control
source of truth. It also mirrors each assignment onto `users/{uid}/assignedSites/{siteId}` in the
**Realtime Database** (a simple `true` flag) purely so the admin panel's Users table can display an
assigned-site count; that mirror isn't itself security-enforcing. Users can edit and save versions
on assigned sites; they cannot create or delete sites.

**Versioning**: each site has one *editable* version at a time (`latestVersionId`). Every **Save**
overwrites that version in place, goes live immediately, and increments its edit counter. After
5 edits (`MAX_EDITS_PER_VERSION` in `admin.js`/`user.js`) that version **locks** permanently and a
new version is created automatically to keep editing — so the version number always advances on
its own schedule instead of needing a manual bump. Locked versions can only be **restored** (their
code is copied back to what's live) — they can never be edited again. Every version records its
`author` (name + role: admin or user), visible in the history panel.

**Logging**: every site action (create, delete, save, lock, restore, assignment) and every user
action (create, suspend, reactivate, delete) writes a doc to `logs/{id}`. The Firestore rules make
this collection readable by admins only — regular users can write their own log entries but never
read the log.

**Chat**:
- Admin ↔ any user: 1:1 thread at `chats/{userUid}/messages`. Admin sees every user as a thread;
  each user only ever sees their own thread with admin.
- Groups: only admins create them (`admin.html → Chat → + Group`), picking members from the user list.
  Members can post in a group; admin can read/post in every group regardless of membership.
- Cross-user chat: a user can request a direct line to someone they already share a group with
  (`user.html → Chat → Request a chat`). This writes to `chatRequests`, which only admin can see and
  approve/deny. Approving creates a 2-person group so the conversation is still subject to the same
  admin-visible group rules — there's no way for two users to chat without an admin having created
  that channel.

## Notes / things to decide as you extend this

- **Multiple admins**: add the UID under `admins/{uid}` in **both** Firestore and the Realtime
  Database (see Setup step 3) — the two allowlists must stay in sync since neither database's
  rules can read the other.
- **Deleting a site** currently removes the `sites/{siteId}` doc but Firestore doesn't cascade-delete
  subcollections — clean up `versions` manually, or add a scheduled Cloud Function later if you
  move to the Blaze plan for other reasons; it isn't required for anything else in this app.
- **Deleting a user** removes their `users/{uid}` Cloud-Code profile (Realtime Database) but not
  their underlying Firebase Auth account — that still needs the Admin SDK. If you eventually add
  Cloud Functions for something else, a `deleteUser` callable is a natural thing to add then; until
  then, a "deleted" account just fails the status check at sign-in and can be recreated with a new
  temp password if needed.
- **appdata isolation**: if a connected site needs its visitors to log in and store their own data,
  point that site's Firebase Auth + Firestore calls at `sites/{siteId}/appdata/{their-uid}` — the rules
  already restrict each user to their own doc.
- The Firebase Web config in `js/firebase-config.js` and `loader/site-loader.js` is a *client* config
  (API key, project ID, etc.) — it's meant to be public and ships in every browser; it is not a secret.
  All real protection comes from `firestore.rules` (sites, chat, logs) and `database.rules.json`
  (user profiles + status), so double-check both before going live.
