/* ============================================================
   Firebase configuration — ClearSky-OMEGA Distribution Marketplace
   ------------------------------------------------------------
   clearsky-portal project (shared with the Financing portal, SPATCO,
   NextNRG, and OMEGA). These web-SDK values are NOT secret — they are
   meant to ship to the browser. Real security comes from the Firestore
   + Storage rules (firestore.rules / storage.rules).

   NOTE: unlike the financing portal's config, this file does NOT create
   the global auth/db/storage/FieldValue handles — the marketplace app.js
   initializes those itself inside boot(). Keep it that way to avoid
   duplicate declarations.
   ============================================================ */

var firebaseConfig = {
  apiKey: "AIzaSyABoM1lgOYUnd5ZadaoTMhYmA9cHa8Tyo0",
  authDomain: "clearsky-portal.firebaseapp.com",
  projectId: "clearsky-portal",
  storageBucket: "clearsky-portal.firebasestorage.app",
  messagingSenderId: "742134484347",
  appId: "1:742134484347:web:ab0f95fd221536158481de",
  measurementId: "G-8D92GNW555"
};

firebase.initializeApp(firebaseConfig);
