/* ============================================================
   Firebase config for the ClearSky-OMEGA Distribution Marketplace.
   Uses the SHARED clearsky-portal project so mkt_*, fin_*, and OMEGA
   data all live in one Firestore. Values below match your existing
   portals — only the apiKey/appId are project-wide and safe to ship
   client-side (Firestore rules do the real access control).
   ============================================================ */
var firebaseConfig = {
  apiKey: "REPLACE_WITH_WEB_API_KEY",
  authDomain: "clearsky-portal.firebaseapp.com",
  projectId: "clearsky-portal",
  storageBucket: "clearsky-portal.appspot.com",
  messagingSenderId: "742134484347",
  appId: "REPLACE_WITH_APP_ID"
};

firebase.initializeApp(firebaseConfig);
