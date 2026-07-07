// Shared Firebase initialization (v10 modular SDK, loaded via CDN in each HTML file)
// No firebase-functions here anymore — user create/block/delete now runs entirely on the
// client SDK (Auth + Realtime Database), so this app needs zero Cloud Functions and works
// fully on the free Spark plan.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { initializeFirestore } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";

// Exported (not just used internally) because admin.js needs it to spin up a *second*,
// throwaway Firebase app instance when creating a new user — see js/admin.js for why.
export const firebaseConfig = {
  apiKey: "AIzaSyDmfjad1r45YG3nnVWh6yuMyeNYc1KPyR8",
  authDomain: "cloud-code-db99e.firebaseapp.com",
  databaseURL: "https://cloud-code-db99e-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "cloud-code-db99e",
  storageBucket: "cloud-code-db99e.firebasestorage.app",
  messagingSenderId: "33867123556",
  appId: "1:33867123556:web:fe55e262a274e6087a8871"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
// experimentalAutoDetectLongPolling avoids the "channel?VER=8..." streaming request that
// ad blockers / some corporate networks flag as tracking and block with a CORS-looking error.
export const db = initializeFirestore(app, {
  experimentalAutoDetectLongPolling: true,
  useFetchStreams: false
});                                         // sites, versions, logs, chats, groups
export const rtdb = getDatabase(app);      // user profiles + status (admins/, users/)
