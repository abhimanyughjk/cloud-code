import { auth, db, rtdb } from "./firebase-config.js";
import {
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  sendSignInLinkToEmail,
  isSignInWithEmailLink,
  signInWithEmailLink,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { ref, get } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";

const form = document.getElementById("login-form");
const errorBox = document.getElementById("login-error");
const resetLink = document.getElementById("reset-password-link");
const emailLinkBtn = document.getElementById("email-link-btn");
const emailLinkStatus = document.getElementById("email-link-status");

// Human-readable copy for each non-active account status. Anything not listed falls back
// to a generic "contact your admin" message so a new status value never leaks internals.
const STATUS_MESSAGES = {
  suspended: "This account has been suspended by an admin. Contact your admin for access.",
  blocked: "This account has been blocked by an admin. Contact your admin for access.",
  disabled: "This account has been disabled by an admin. Contact your admin for access."
};

// If already logged in, route straight to the right screen.
onAuthStateChanged(auth, async (user) => {
  if (user) await routeUser(user);
});

// Wraps a promise so a stuck network call (e.g. a Firestore long-poll channel that a
// browser extension is silently swallowing) surfaces as a real error instead of hanging
// the sign-in button forever.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    )
  ]);
}

async function routeUser(user) {
  // Admin allowlist still lives in Firestore (see firestore.rules) — checked first so
  // admins are never blocked out by their own users/{uid} status record (they don't have one).
  const adminSnap = await withTimeout(
    getDoc(doc(db, "admins", user.uid)),
    8000,
    "Admin check"
  );
  if (adminSnap.exists()) {
    window.location.href = "admin.html";
    return;
  }

  // Everyone else's profile + live status lives in the Realtime Database, written by the
  // admin panel at user-creation time (see js/admin.js) — no Cloud Functions involved.
  let userSnap;
  try {
    userSnap = await withTimeout(get(ref(rtdb, "users/" + user.uid)), 8000, "Account status check");
  } catch (err) {
    errorBox.textContent = "Could not verify account status. Try again.";
    await signOut(auth);
    return;
  }

  if (!userSnap.exists()) {
    errorBox.textContent = "This account has no access to Cloud-Code.";
    await signOut(auth);
    return;
  }

  const profile = userSnap.val();
  if (profile.status !== "active") {
    errorBox.textContent = STATUS_MESSAGES[profile.status] || "This account is not active. Contact your admin.";
    await signOut(auth);
    return;
  }

  window.location.href = "user.html";
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorBox.textContent = "";
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;

  let cred;
  try {
    cred = await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    errorBox.textContent = "Wrong email or password.";
    return;
  }

  try {
    await routeUser(cred.user);
  } catch (err) {
    console.error("routeUser failed after successful sign-in:", err);
    errorBox.textContent = "Signed in, but couldn't verify your account status. Check your connection (or disable ad blockers) and try again.";
  }
});

/* ---------------------------------------------------------
   Forgot password — sendPasswordResetEmail
   --------------------------------------------------------- */
resetLink.addEventListener("click", async (e) => {
  e.preventDefault();
  errorBox.textContent = "";
  const email = document.getElementById("email").value.trim();
  if (!email) {
    errorBox.textContent = "Enter your email above first, then click \"Forgot password?\".";
    return;
  }
  try {
    await sendPasswordResetEmail(auth, email);
    errorBox.style.color = "var(--add)";
    errorBox.textContent = "Password reset email sent — check your inbox.";
  } catch (err) {
    // Don't reveal whether the email exists — same message either way.
    errorBox.style.color = "";
    errorBox.textContent = "If that email has an account, a reset link has been sent.";
  }
});

/* ---------------------------------------------------------
   Passwordless sign-in — email link (magic link)
   --------------------------------------------------------- */
const EMAIL_FOR_SIGN_IN_KEY = "cloudCodeEmailForSignIn";

emailLinkBtn.addEventListener("click", async () => {
  const email = document.getElementById("email").value.trim();
  if (!email) {
    emailLinkStatus.textContent = "Enter your email above first, then click this.";
    return;
  }
  const actionCodeSettings = {
    url: window.location.href.split("?")[0], // back to this same login page
    handleCodeInApp: true
  };
  try {
    await sendSignInLinkToEmail(auth, email, actionCodeSettings);
    window.localStorage.setItem(EMAIL_FOR_SIGN_IN_KEY, email);
    emailLinkStatus.textContent = "Sign-in link sent — open it on this device to finish signing in.";
  } catch (err) {
    emailLinkStatus.textContent = "Could not send sign-in link. Check the email and try again.";
  }
});

// Completes the flow when the user arrives back here by clicking the emailed link.
(async function completeEmailLinkSignInIfPresent() {
  if (!isSignInWithEmailLink(auth, window.location.href)) return;

  let email = window.localStorage.getItem(EMAIL_FOR_SIGN_IN_KEY);
  if (!email) {
    // Opened the link on a different device/browser than it was requested from.
    email = window.prompt("Confirm your email to finish signing in:");
  }
  if (!email) return;

  try {
    const cred = await signInWithEmailLink(auth, email, window.location.href);
    window.localStorage.removeItem(EMAIL_FOR_SIGN_IN_KEY);
    history.replaceState({}, document.title, window.location.pathname); // strip the link token from the URL
    await routeUser(cred.user);
  } catch (err) {
    errorBox.textContent = "That sign-in link is invalid or has expired.";
  }
})();
