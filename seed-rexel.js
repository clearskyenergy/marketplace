/* ============================================================
   seed-rexel.js
   ------------------------------------------------------------
   Seeds the ClearSky-OMEGA Distribution Marketplace with the
   Rexel Energy Solutions distributor record + a starter catalog
   of real Rexel BESS / EV / solar products.

   Item #s and CAT #s are taken verbatim from rexelusa.com listings.
   PRICES are placeholder list estimates (Rexel gates real pricing
   behind sign-in) — overwrite them with your actual Rexel pricing
   from the distributor's "My Catalog" tab or by editing this file.

   USAGE:
     1. Firebase Console -> Project settings -> Service accounts ->
        "Generate new private key". Save it next to this file as
        serviceAccountKey.json  (DO NOT commit it to git).
     2. npm install firebase-admin
     3. node seed-rexel.js

   Re-running is safe: the distributor is upserted (merge) and each
   product is written by a deterministic id (its CAT #), so a second
   run updates in place rather than duplicating.
   ============================================================ */

var admin = require("firebase-admin");
var serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: "clearsky-portal"
});

var db = admin.firestore();
var FieldValue = admin.firestore.FieldValue;

var DIST_ID = "rexel-energy";

var distributor = {
  name: "Rexel Energy Solutions",
  slug: "rexel-energy",
  location: "Charlotte, NC",
  contact: "energy@rexelusa.com",
  logo: "",                       /* add a logo URL later if you have one */
  active: true,
  apiEnabled: false,              /* flip to true when the availability API is wired */
  apiUrl: "",
  ownerUids: [],
  createdAt: FieldValue.serverTimestamp(),
  updatedAt: FieldValue.serverTimestamp()
};

/* Real Rexel products. price = placeholder list estimate (USD). */
var products = [
  {
    name: "Enphase IQ Battery 5P \u2014 5 kWh AC-coupled storage",
    brand: "Enphase",
    sku: "2142572",                 /* Rexel Item # */
    catNumber: "IQBATTERY-5P-1P-NA",
    upc: "",
    category: "bess",
    uom: "ea",
    unitPrice: 2199.00,
    stockStatus: "in",
    stockQty: 24,
    leadTimeDays: 2,
    description: "IQ Battery 5P, 16 Amp, 3.84 kW continuous, 5 kWh usable, (6) embedded IQ8D-BAT microinverters, LFP chemistry, NEMA 3R. Includes cover and wall-mount bracket. 15-yr limited warranty."
  },
  {
    name: "Enphase IQ Battery 5P Kit \u2014 Made in USA (DOM)",
    brand: "Enphase",
    sku: "2478119",
    catNumber: "IQBATTERY-5P-1P-NA-DOM",
    upc: "",
    category: "bess",
    uom: "ea",
    unitPrice: 2299.00,
    stockStatus: "order",
    stockQty: null,
    leadTimeDays: 10,
    description: "IQ Battery 5P kit assembly for shipment to customer. Includes one IQ Battery 5P, one cover kit, and wall-mount bracket with top-shield. Made in USA / domestic-content."
  },
  {
    name: "Enphase IQ System Controller 3 \u2014 160 A",
    brand: "Enphase",
    sku: "2142579",
    catNumber: "SC200D111C240US01",
    upc: "",
    category: "bess",
    uom: "ea",
    unitPrice: 1249.00,
    stockStatus: "in",
    stockQty: 15,
    leadTimeDays: 2,
    description: "IQ System Controller 3/3G, 160 A. Provides grid isolation and backup transition for Enphase Energy Systems with IQ Battery."
  },
  {
    name: "Enphase IQ8M Microinverter",
    brand: "Enphase",
    sku: "2030218",
    catNumber: "IQ8M-72-M-US",
    upc: "",
    category: "bess",
    uom: "ea",
    unitPrice: 129.00,
    stockStatus: "in",
    stockQty: 340,
    leadTimeDays: 2,
    description: "IQ8M microinverter, MC4 connector, 60 V DC, 330 VA, Class II double-insulated enclosure. For 60\u201372 cell PV modules."
  },
  {
    name: "Enphase 40 A 2-Pole Breaker (10-circuit)",
    brand: "Enphase",
    sku: "2291696",
    catNumber: "BRK-40A-2P-240V-10",
    upc: "",
    category: "gear",
    uom: "ea",
    unitPrice: 39.00,
    stockStatus: "in",
    stockQty: 88,
    leadTimeDays: 2,
    description: "40 A, 2-pole, 240 V breaker for use with the IQ System Controller and IQ Combiner-4. Pack for 10-circuit configuration."
  },
  {
    name: "Enphase Cellular Modem (M1, 6-yr)",
    brand: "Enphase",
    sku: "2260813",
    catNumber: "COMMS-CELLMODEM-M1-06",
    upc: "",
    category: "connectivity",
    uom: "ea",
    unitPrice: 249.00,
    stockStatus: "in",
    stockQty: 42,
    leadTimeDays: 2,
    description: "COMMS-CELLMODEM-M1-06 cellular modem for Enphase IQ Gateway. 6-year cellular data plan for sites without reliable broadband."
  },
  {
    name: "Enphase Q Cable Female Field-Wireable Connector (bag of 10)",
    brand: "Enphase",
    sku: "1126247",
    catNumber: "Q-CONN-10F",
    upc: "",
    category: "cable",
    uom: "bag",
    unitPrice: 74.00,
    stockStatus: "in",
    stockQty: 60,
    leadTimeDays: 2,
    description: "Female field-wireable Q connector for Q cable. Bag of 10. For terminating Enphase AC trunk cable runs."
  }
];

function run() {
  var distRef = db.collection("mkt_distributors").doc(DIST_ID);

  return distRef.set(distributor, { merge: true }).then(function () {
    console.log("\u2713 Distributor upserted: " + DIST_ID + " (" + distributor.name + ")");

    var batch = db.batch();
    for (var i = 0; i < products.length; i++) {
      var p = products[i];
      /* deterministic doc id from CAT # so re-runs update in place */
      var docId = String(p.catNumber || p.sku).replace(/[^A-Za-z0-9_-]/g, "_");
      var ref = distRef.collection("catalog").doc(docId);
      var data = Object.assign({}, p, {
        active: true,
        imageUrl: p.imageUrl || "",
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });
      batch.set(ref, data, { merge: true });
    }
    return batch.commit().then(function () {
      console.log("\u2713 Seeded " + products.length + " products into " + DIST_ID + "/catalog");
    });
  });
}

run()
  .then(function () {
    console.log("\nDone. Log in as a developer, open Catalog & Shop, and browse Rexel.");
    console.log("Remember: prices are PLACEHOLDER estimates \u2014 overwrite with real Rexel pricing.");
    process.exit(0);
  })
  ["catch"](function (err) {
    console.error("Seed failed:", err);
    process.exit(1);
  });
