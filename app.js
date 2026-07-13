/* ============================================================
   ClearSky-OMEGA · Distribution Marketplace
   app.js — single-file ES5 application logic
   ------------------------------------------------------------
   Constraints (ClearSky house style):
   - ES5 only: no arrow functions, no template literals,
     no let/const, no optional chaining, no async/await.
   - Firebase compat SDK v8 (window.firebase.*).
   ------------------------------------------------------------
   Roles (mkt_profiles.role):
     developer   — submits projects, browses catalogs, builds carts,
                   accepts/pays invoices.
     distributor — receives projects, prices them, manages a catalog,
                   sends invoices, records payment.
     admin       — onboards distributors, sees everything.

   Data model — see firestore.rules header. Collections:
     mkt_profiles/{uid}
     mkt_distributors/{distId}         (+ /catalog/{productId})
     mkt_projects/{projectId}          (+ /quote/{q}, /invoice/{inv}, /messages/{m})
   ============================================================ */

/* ---------- collection names ---------- */
var COL_PROFILES     = "mkt_profiles";
var COL_DISTRIBUTORS = "mkt_distributors";
var COL_PROJECTS     = "mkt_projects";
var COL_ALLOWLIST    = "partnerAllowlist"; /* SHARED — gates distributor role */

/* ---------- firebase handles (set in boot) ---------- */
var db, auth, storage, FieldValue;

/* ---------- global state ---------- */
var STATE = {
  user: null,
  profile: null,
  role: null,            /* developer | distributor | admin */
  distributorId: null,   /* set for distributor users */
  distributors: [],      /* cached distributor list */
  projects: [],          /* role-scoped project list */
  activeTab: null,
  regRole: "developer",
  unsub: null,
  view: "projects",      /* projects | catalog | admin */
  cart: []               /* developer shopping cart: [{distId, product, qty}] */
};

var STATUS_LABELS = {
  submitted: "Submitted",
  accepted:  "Accepted",
  quoted:    "Quoted",
  invoiced:  "Invoiced",
  paid:      "Paid",
  fulfilled: "Fulfilled",
  declined:  "Declined"
};

var STATUS_ORDER = ["submitted", "accepted", "quoted", "invoiced", "paid", "fulfilled"];

var TYPE_LABELS = {
  bess: "BESS / Storage",
  ev: "EV Charging",
  microgrid: "Microgrid",
  solar_storage: "Solar + Storage",
  service: "Electrical Service",
  other: "Other"
};

var CATEGORY_LABELS = {
  gear: "Gear / Switchgear",
  fixtures: "Fixtures",
  roughin: "Rough-in",
  connectivity: "Connectivity",
  cable: "Cable / Wire",
  ev: "EV Charging",
  bess: "BESS / Storage",
  conduit: "Conduit / Raceway",
  misc: "Miscellaneous"
};

/* ---------- tiny helpers ---------- */
function $(id) { return document.getElementById(id); }

function el(tag, cls, html) {
  var e = document.createElement(tag);
  if (cls) { e.className = cls; }
  if (html !== undefined && html !== null) { e.innerHTML = html; }
  return e;
}

function esc(s) {
  if (s === undefined || s === null) { return ""; }
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function initials(name) {
  if (!name) { return "?"; }
  var parts = name.trim().split(/\s+/);
  if (parts.length === 1) { return parts[0].charAt(0).toUpperCase(); }
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

function money(n) {
  if (n === undefined || n === null || n === "" || isNaN(n)) { return "\u2014"; }
  n = Number(n);
  return "$" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function moneyShort(n) {
  if (n === undefined || n === null || n === "" || isNaN(n)) { return "\u2014"; }
  n = Number(n);
  if (n >= 1000000) { return "$" + (n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 2) + "M"; }
  if (n >= 1000) { return "$" + (n / 1000).toFixed(0) + "K"; }
  return "$" + n.toFixed(0);
}

function fmtDate(ts) {
  if (!ts) { return ""; }
  var d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function timeAgo(ts) {
  if (!ts) { return ""; }
  var d = ts.toDate ? ts.toDate() : new Date(ts);
  var s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) { return "just now"; }
  if (s < 3600) { return Math.floor(s / 60) + "m ago"; }
  if (s < 86400) { return Math.floor(s / 3600) + "h ago"; }
  if (s < 604800) { return Math.floor(s / 86400) + "d ago"; }
  return fmtDate(ts);
}

function slugify(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function toast(msg, isErr) {
  var t = $("toast");
  t.textContent = msg;
  t.className = isErr ? "err show" : "show";
  setTimeout(function () { t.className = t.className.replace("show", "").trim(); }, 2600);
}

function showAuthErr(msg) {
  var e = $("authErr");
  e.textContent = msg;
  e.className = "auth-err show";
}
function clearAuthErr() { $("authErr").className = "auth-err"; }

function friendlyErr(err) {
  var c = err && err.code ? err.code : "";
  if (c.indexOf("email-already-in-use") > -1) { return "That email already has an account. Try logging in."; }
  if (c.indexOf("invalid-email") > -1) { return "That doesn't look like a valid email."; }
  if (c.indexOf("weak-password") > -1) { return "Password must be at least 6 characters."; }
  if (c.indexOf("wrong-password") > -1 || c.indexOf("invalid-credential") > -1) { return "Incorrect email or password."; }
  if (c.indexOf("user-not-found") > -1) { return "No account found for that email."; }
  if (c.indexOf("too-many-requests") > -1) { return "Too many attempts. Please wait and try again."; }
  if (c.indexOf("popup-closed") > -1) { return "Sign-in was cancelled."; }
  if (c.indexOf("permission-denied") > -1) { return "You don't have permission to do that."; }
  return (err && err.message) ? err.message : "Something went wrong. Please try again.";
}

function row(k, v) {
  return '<div class="kv-row"><span class="kv-k">' + esc(k) + '</span><span class="kv-v">' + v + '</span></div>';
}

/* ============================================================
   AUTH WIRING
   ============================================================ */
function wireAuthUI() {
  $("toRegister").onclick = function () {
    clearAuthErr();
    $("loginForm").style.display = "none";
    $("registerForm").style.display = "block";
  };
  $("toLogin").onclick = function () {
    clearAuthErr();
    $("registerForm").style.display = "none";
    $("loginForm").style.display = "block";
  };

  $("roleDev").onclick = function () { selectRegRole("developer"); };
  $("roleDist").onclick = function () { selectRegRole("distributor"); };

  $("loginBtn").onclick = doLogin;
  $("loginPass").onkeydown = function (e) { if (e.key === "Enter") { doLogin(); } };
  $("googleLoginBtn").onclick = doGoogle;

  $("registerBtn").onclick = doRegister;
  $("regPass").onkeydown = function (e) { if (e.key === "Enter") { doRegister(); } };

  if (window.location.search.indexOf("mode=register") > -1) {
    $("loginForm").style.display = "none";
    $("registerForm").style.display = "block";
  }

  $("signOutBtn").onclick = function () {
    if (STATE.unsub) { STATE.unsub(); STATE.unsub = null; }
    auth.signOut();
  };
}

function selectRegRole(role) {
  STATE.regRole = role;
  $("roleDev").className = "role-opt" + (role === "developer" ? " sel" : "");
  $("roleDist").className = "role-opt" + (role === "distributor" ? " sel" : "");
}

function doLogin() {
  clearAuthErr();
  var email = $("loginEmail").value.trim();
  var pass = $("loginPass").value;
  if (!email || !pass) { showAuthErr("Enter your email and password."); return; }
  $("loginBtn").disabled = true;
  auth.signInWithEmailAndPassword(email, pass)
    ["catch"](function (err) { showAuthErr(friendlyErr(err)); })
    .then(function () { $("loginBtn").disabled = false; });
}

function doRegister() {
  clearAuthErr();
  var name = $("regName").value.trim();
  var org = $("regOrg").value.trim();
  var email = $("regEmail").value.trim();
  var pass = $("regPass").value;
  if (!name || !org || !email || !pass) { showAuthErr("Please fill in every field."); return; }
  if (pass.length < 6) { showAuthErr("Password must be at least 6 characters."); return; }

  $("registerBtn").disabled = true;
  var wantsDist = (STATE.regRole === "distributor");
  var emailKey = email.toLowerCase();

  /* Distributor role is gated by the shared partnerAllowlist
     (role == 'distributor', active == true). Developers self-select freely. */
  db.collection(COL_ALLOWLIST).doc(emailKey).get()
    .then(function (snap) {
      var d = snap.exists ? snap.data() : null;
      var allowedDist = !!(d && d.active === true && d.role === "distributor");

      if (wantsDist && !allowedDist) {
        throw { code: "app/not-allowlisted" };
      }

      var role = allowedDist ? "distributor" : "developer";
      var distributorId = (allowedDist && d.distributorId) ? d.distributorId : null;
      var finalOrg = org;
      if (allowedDist && d["partner account"]) { finalOrg = d["partner account"]; }

      return auth.createUserWithEmailAndPassword(email, pass).then(function (cred) {
        return db.collection(COL_PROFILES).doc(cred.user.uid).set({
          name: name, org: finalOrg, email: email, emailLower: emailKey,
          role: role, distributorId: distributorId,
          createdAt: FieldValue.serverTimestamp()
        });
      });
    })
    ["catch"](function (err) {
      if (err && err.code === "app/not-allowlisted") {
        showAuthErr("That email isn't onboarded as a distributor yet. Register as a developer, or contact info@csebuilders.com to onboard your distribution company.");
      } else {
        showAuthErr(friendlyErr(err));
      }
    })
    .then(function () { $("registerBtn").disabled = false; });
}

function doGoogle() {
  clearAuthErr();
  var provider = new firebase.auth.GoogleAuthProvider();
  auth.signInWithPopup(provider)
    .then(function (result) {
      var u = result.user;
      var ref = db.collection(COL_PROFILES).doc(u.uid);
      return ref.get().then(function (snap) {
        if (snap.exists) { return null; }
        var emailKey = (u.email || "").toLowerCase();
        return db.collection(COL_ALLOWLIST).doc(emailKey).get().then(function (al) {
          var d = al.exists ? al.data() : null;
          var allowedDist = !!(d && d.active === true && d.role === "distributor");
          var role = allowedDist ? "distributor" : "developer";
          var distributorId = (allowedDist && d.distributorId) ? d.distributorId : null;
          var org = (u.email || "").split("@")[1] || "";
          if (allowedDist && d["partner account"]) { org = d["partner account"]; }
          return ref.set({
            name: u.displayName || u.email, org: org, email: u.email,
            emailLower: emailKey, role: role, distributorId: distributorId,
            createdAt: FieldValue.serverTimestamp()
          });
        });
      });
    })
    ["catch"](function (err) { showAuthErr(friendlyErr(err)); });
}

/* ============================================================
   AUTH STATE OBSERVER
   ============================================================ */
function onAuth(user) {
  if (!user) {
    STATE.user = null; STATE.profile = null; STATE.role = null; STATE.distributorId = null;
    $("appView").style.display = "none";
    $("authView").style.display = "flex";
    return;
  }
  STATE.user = user;
  db.collection(COL_PROFILES).doc(user.uid).get().then(function (snap) {
    if (!snap.exists) {
      setTimeout(function () { onAuth(auth.currentUser); }, 600);
      return;
    }
    STATE.profile = snap.data();
    STATE.role = STATE.profile.role || "developer";
    STATE.distributorId = STATE.profile.distributorId || null;
    /* admin override by email domain, even without a stored role */
    if (isAdminEmail(STATE.profile.email)) { STATE.role = "admin"; }
    enterApp();
  })["catch"](function (err) {
    toast(friendlyErr(err), true);
  });
}

function isAdminEmail(email) {
  if (!email) { return false; }
  var e = email.toLowerCase();
  return /@clearsky-usa\.com$/.test(e) || /@csebuilders\.com$/.test(e);
}

/* ============================================================
   APP SHELL
   ============================================================ */
function enterApp() {
  $("authView").style.display = "none";
  $("appView").style.display = "block";

  $("userName").textContent = STATE.profile.name || STATE.profile.email;
  $("userAvatar").textContent = initials(STATE.profile.name || STATE.profile.email);

  var chip = $("roleChip");
  if (STATE.role === "developer") {
    chip.className = "role-chip dev"; chip.textContent = "Developer";
  } else if (STATE.role === "distributor") {
    chip.className = "role-chip dist"; chip.textContent = "Distributor";
  } else {
    chip.className = "role-chip admin"; chip.textContent = "Admin";
  }

  buildNav();
  /* preload distributors (used by both roles) then route */
  loadDistributors().then(function () {
    routeTo(STATE.view || "projects");
  });
}

function buildNav() {
  var nav = $("mainNav");
  nav.innerHTML = "";
  var items = [];
  if (STATE.role === "developer") {
    items = [
      { id: "projects", label: "My Projects" },
      { id: "catalog", label: "Catalog & Shop" }
    ];
  } else if (STATE.role === "distributor") {
    items = [
      { id: "projects", label: "Incoming Projects" },
      { id: "catalog", label: "My Catalog" }
    ];
  } else {
    items = [
      { id: "projects", label: "All Projects" },
      { id: "catalog", label: "Catalogs" },
      { id: "admin", label: "Admin" }
    ];
  }
  for (var i = 0; i < items.length; i++) {
    (function (it) {
      var b = el("button", "nav-item" + (STATE.view === it.id ? " active" : ""), esc(it.label));
      b.onclick = function () { routeTo(it.id); };
      nav.appendChild(b);
    })(items[i]);
  }

  /* cart button for developers */
  var cartWrap = $("cartBtnWrap");
  if (STATE.role === "developer") {
    cartWrap.style.display = "block";
    updateCartBadge();
    $("cartBtn").onclick = openCartModal;
  } else {
    cartWrap.style.display = "none";
  }
}

function routeTo(view) {
  STATE.view = view;
  if (STATE.unsub) { STATE.unsub(); STATE.unsub = null; }
  /* highlight nav */
  var btns = document.querySelectorAll(".nav-item");
  for (var i = 0; i < btns.length; i++) { btns[i].className = "nav-item"; }
  buildNav();

  if (view === "projects") { renderProjectsView(); }
  else if (view === "catalog") { renderCatalogView(); }
  else if (view === "admin") { renderAdminView(); }
}

/* ============================================================
   DISTRIBUTORS — load + cache
   ============================================================ */
function loadDistributors() {
  return db.collection(COL_DISTRIBUTORS).where("active", "==", true).get()
    .then(function (snap) {
      var arr = [];
      snap.forEach(function (d) { var x = d.data(); x._id = d.id; arr.push(x); });
      arr.sort(function (a, b) { return (a.name || "").localeCompare(b.name || ""); });
      STATE.distributors = arr;
      return arr;
    })["catch"](function () { STATE.distributors = []; return []; });
}

function distName(distId) {
  for (var i = 0; i < STATE.distributors.length; i++) {
    if (STATE.distributors[i]._id === distId) { return STATE.distributors[i].name; }
  }
  return distId || "\u2014";
}

/* ============================================================
   PROJECTS VIEW
   ============================================================ */
function renderProjectsView() {
  var main = $("mainArea");
  main.innerHTML = "";

  var head = el("div", "page-head");
  var htxt = el("div");
  if (STATE.role === "developer") {
    htxt.innerHTML = '<h1>My Projects</h1><p class="ph-sub">Submit a material request to a distributor \u2014 attach the BOM from the editor, a PDF, and optional data. Track quotes, invoices, and fulfillment.</p>';
  } else if (STATE.role === "distributor") {
    htxt.innerHTML = '<h1>Incoming Projects</h1><p class="ph-sub">Accept material requests, price them, send invoices, and manage fulfillment and shipping.</p>';
  } else {
    htxt.innerHTML = '<h1>All Projects</h1><p class="ph-sub">Every material request across the marketplace.</p>';
  }
  head.appendChild(htxt);

  if (STATE.role === "developer") {
    var newBtn = el("button", "btn btn-primary");
    newBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> New material request';
    newBtn.onclick = function () { openIntakeModal(); };
    head.appendChild(newBtn);
  }
  main.appendChild(head);

  var tabs = el("div", "tabs"); tabs.id = "projTabs";
  main.appendChild(tabs);

  var listArea = el("div"); listArea.id = "projListArea";
  listArea.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  main.appendChild(listArea);

  buildProjectTabs();
  subscribeProjects();
}

function buildProjectTabs() {
  var tabs = $("projTabs");
  if (!tabs) { return; }
  tabs.innerHTML = "";
  var defs = [
    { id: "all", label: "All" },
    { id: "active", label: "Active" },
    { id: "invoiced", label: "Invoiced" },
    { id: "paid", label: "Paid" },
    { id: "fulfilled", label: "Fulfilled" }
  ];
  if (!STATE.activeTab) { STATE.activeTab = "all"; }
  for (var i = 0; i < defs.length; i++) {
    (function (d) {
      var b = el("button", "tab" + (STATE.activeTab === d.id ? " active" : ""), esc(d.label));
      var cnt = el("span", "cnt", "0"); cnt.id = "pcnt-" + d.id;
      b.appendChild(cnt);
      b.onclick = function () {
        STATE.activeTab = d.id;
        var all = tabs.querySelectorAll(".tab");
        for (var j = 0; j < all.length; j++) { all[j].className = "tab"; }
        b.className = "tab active";
        renderProjectList();
      };
      tabs.appendChild(b);
    })(defs[i]);
  }
}

function subscribeProjects() {
  if (STATE.unsub) { STATE.unsub(); STATE.unsub = null; }
  var q;
  if (STATE.role === "developer") {
    q = db.collection(COL_PROJECTS).where("developerUid", "==", STATE.user.uid);
  } else if (STATE.role === "distributor") {
    q = db.collection(COL_PROJECTS).where("targetDistId", "==", STATE.distributorId);
  } else {
    q = db.collection(COL_PROJECTS);
  }

  STATE.unsub = q.onSnapshot(function (snap) {
    var list = [];
    snap.forEach(function (doc) { var d = doc.data(); d._id = doc.id; list.push(d); });
    STATE.projects = list;
    renderProjectList();
  }, function (err) {
    var area = $("projListArea");
    if (area) {
      area.innerHTML = '<div class="empty"><h3>Could not load projects</h3><p>' +
        esc(friendlyErr(err)) + '</p></div>';
    }
  });
}

function filteredProjects() {
  var p = STATE.projects.slice();
  var t = STATE.activeTab;
  if (t === "active") { return p.filter(function (x) { return ["submitted", "accepted", "quoted"].indexOf(x.status) > -1; }); }
  if (t === "invoiced") { return p.filter(function (x) { return x.status === "invoiced"; }); }
  if (t === "paid") { return p.filter(function (x) { return x.status === "paid"; }); }
  if (t === "fulfilled") { return p.filter(function (x) { return x.status === "fulfilled"; }); }
  return p;
}

function updateProjTabCounts() {
  var p = STATE.projects;
  function setc(id, n) { var e = $("pcnt-" + id); if (e) { e.textContent = n; } }
  setc("all", p.length);
  setc("active", p.filter(function (x) { return ["submitted", "accepted", "quoted"].indexOf(x.status) > -1; }).length);
  setc("invoiced", p.filter(function (x) { return x.status === "invoiced"; }).length);
  setc("paid", p.filter(function (x) { return x.status === "paid"; }).length);
  setc("fulfilled", p.filter(function (x) { return x.status === "fulfilled"; }).length);
}

function renderProjectList() {
  updateProjTabCounts();
  var area = $("projListArea");
  if (!area) { return; }
  area.innerHTML = "";
  var items = filteredProjects();
  items.sort(function (a, b) {
    var ta = a.createdAt && a.createdAt.seconds ? a.createdAt.seconds : 0;
    var tb = b.createdAt && b.createdAt.seconds ? b.createdAt.seconds : 0;
    return tb - ta;
  });
  if (items.length === 0) { area.appendChild(projEmptyState()); return; }
  var grid = el("div", "proj-grid");
  for (var i = 0; i < items.length; i++) { grid.appendChild(projectCard(items[i])); }
  area.appendChild(grid);
}

function projEmptyState() {
  var e = el("div", "empty");
  var icon = '<div class="e-ic"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 9h6M9 13h6M9 17h3"/></svg></div>';
  if (STATE.role === "developer") {
    e.innerHTML = icon + '<h3>No material requests yet</h3><p>Submit your first project \u2014 attach the BOM export, a PDF plan set, and pick a distributor to fulfill it.</p>';
    var b = el("button", "btn btn-primary", "New material request");
    b.onclick = function () { openIntakeModal(); };
    e.appendChild(b);
  } else if (STATE.role === "distributor") {
    e.innerHTML = icon + '<h3>No incoming projects</h3><p>When a developer submits a material request to your company, it appears here in real time.</p>';
  } else {
    e.innerHTML = icon + '<h3>No projects yet</h3><p>Nothing has been submitted across the marketplace.</p>';
  }
  return e;
}

function statusPill(status) {
  var cls = "st-open";
  if (status === "submitted") { cls = "st-open"; }
  else if (status === "accepted") { cls = "st-accepted"; }
  else if (status === "quoted") { cls = "st-offered"; }
  else if (status === "invoiced") { cls = "st-amber"; }
  else if (status === "paid") { cls = "st-awarded"; }
  else if (status === "fulfilled") { cls = "st-fulfilled"; }
  else if (status === "declined") { cls = "st-withdrawn"; }
  return '<span class="status-pill ' + cls + '">' + esc(STATUS_LABELS[status] || status) + '</span>';
}

function projectCard(p) {
  var card = el("div", "proj-card");
  var top = el("div", "pc-top");
  var left = el("div");
  var sub = (TYPE_LABELS[p.type] || p.type || "Project");
  if (STATE.role === "developer") { sub += " \u00b7 " + esc(distName(p.targetDistId)); }
  else { sub += " \u00b7 " + esc(p.developerOrg || p.developerName || ""); }
  left.innerHTML = '<div class="pc-name">' + esc(p.name || "Untitled") + '</div>' +
    '<div class="pc-meta">' + sub + (p.jobCity ? " \u00b7 " + esc(p.jobCity) + (p.jobState ? ", " + esc(p.jobState) : "") : "") + '</div>';
  top.appendChild(left);
  var pill = el("div"); pill.innerHTML = statusPill(p.status);
  top.appendChild(pill.firstChild);
  card.appendChild(top);

  var stats = el("div", "pc-stats");
  var itemCount = (p.cartItems && p.cartItems.length) ? p.cartItems.length : 0;
  stats.innerHTML =
    '<div class="pc-stat"><div class="k">Line items</div><div class="v">' + itemCount + '</div></div>' +
    '<div class="pc-stat"><div class="k">Est. materials</div><div class="v">' + moneyShort(p.estMaterialsTotal) + '</div></div>';
  card.appendChild(stats);

  var foot = el("div", "pc-foot");
  foot.innerHTML = '<div class="pc-offers">Submitted ' + esc(fmtDate(p.createdAt)) + '</div>';
  var open = el("button", "btn btn-ghost btn-sm", "View");
  foot.appendChild(open);
  card.appendChild(foot);

  card.onclick = function () { openProjectDetail(p._id); };
  return card;
}

/* ============================================================
   MODAL HELPERS
   ============================================================ */
function openModal(node, wide) {
  var m = $("modalEl");
  m.className = "modal" + (wide ? " wide" : "");
  m.innerHTML = "";
  m.appendChild(node);
  $("modalBackdrop").className = "modal-backdrop show";
}
function closeModal() { $("modalBackdrop").className = "modal-backdrop"; }

function modalHead(title, sub) {
  var h = el("div", "modal-head");
  var left = el("div");
  left.innerHTML = '<h2>' + esc(title) + '</h2>' + (sub ? '<div class="mh-sub">' + esc(sub) + '</div>' : "");
  var x = el("button", "modal-close", "&times;"); x.onclick = closeModal;
  h.appendChild(left); h.appendChild(x);
  return h;
}

/* pending file refs for the intake form */
var PENDING = { bom: null, pdf: null, data: null };

function fileDropField(key, label, hint) {
  var f = el("div", "field");
  f.innerHTML = '<label>' + esc(label) + '</label>';
  var drop = el("div", "file-drop"); drop.id = "drop-" + key;
  drop.innerHTML =
    '<label for="file-' + key + '">' +
      '<div class="fd-ic"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg></div>' +
      '<div class="fd-main">Click to upload</div>' +
      '<div class="fd-sub">' + esc(hint) + '</div>' +
    '</label>' +
    '<input type="file" id="file-' + key + '" style="display:none;">';
  f.appendChild(drop);
  var chipHolder = el("div"); chipHolder.id = "chip-" + key;
  f.appendChild(chipHolder);
  setTimeout(function () {
    var input = $("file-" + key);
    if (!input) { return; }
    input.onchange = function () {
      if (input.files && input.files[0]) {
        PENDING[key] = input.files[0];
        renderFileChip(key, input.files[0].name);
      }
    };
  }, 0);
  return f;
}

function renderFileChip(key, name) {
  var holder = $("chip-" + key);
  var drop = $("drop-" + key);
  if (drop) { drop.style.display = "none"; }
  holder.innerHTML = "";
  var chip = el("div", "file-chip");
  chip.innerHTML =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--cs-blue)" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>' +
    '<span class="fc-name">' + esc(name) + '</span>';
  var x = el("button", "fc-x", "&times;");
  x.onclick = function () {
    PENDING[key] = null;
    holder.innerHTML = "";
    if (drop) { drop.style.display = "block"; }
    var input = $("file-" + key); if (input) { input.value = ""; }
  };
  chip.appendChild(x);
  holder.appendChild(chip);
}

/* ============================================================
   INTAKE MODAL — new material request (developer)
   Fields mirror the Rexel Job Information Sheet.
   fromCart: optional array of cart items to seed cartItems.
   ============================================================ */
function openIntakeModal(fromCart) {
  PENDING = { bom: null, pdf: null, data: null };

  var seededItems = fromCart || [];
  var seededDist = (seededItems.length && seededItems[0].distId) ? seededItems[0].distId : "";
  var estTotal = 0;
  for (var s = 0; s < seededItems.length; s++) {
    estTotal += Number(seededItems[s].product.unitPrice || 0) * Number(seededItems[s].qty || 1);
  }

  var wrap = el("div");
  wrap.appendChild(modalHead("New material request",
    "Attach the BOM export from the SiteMap Designer, a PDF plan set, and optional data. Pick the distributor to fulfill it."));

  var body = el("div", "modal-body");

  /* distributor picker */
  var distOpts = '<option value="">Select a distributor\u2026</option>';
  for (var i = 0; i < STATE.distributors.length; i++) {
    var d = STATE.distributors[i];
    distOpts += '<option value="' + esc(d._id) + '"' + (d._id === seededDist ? " selected" : "") + '>' + esc(d.name) + '</option>';
  }

  body.innerHTML =
    '<div class="form-section-title">Project</div>' +
    '<div class="field"><label>Project / Job name *</label><input type="text" id="f-name" placeholder="e.g. Riverside BESS \u2014 Clinton, IA"></div>' +
    '<div class="field-row">' +
      '<div class="field"><label>Project type</label><select id="f-type">' +
        '<option value="bess">BESS / Storage</option>' +
        '<option value="ev">EV Charging</option>' +
        '<option value="solar_storage">Solar + Storage</option>' +
        '<option value="microgrid">Microgrid</option>' +
        '<option value="service">Electrical Service</option>' +
        '<option value="other">Other</option>' +
      '</select></div>' +
      '<div class="field"><label>Submit to distributor *</label><select id="f-dist">' + distOpts + '</select></div>' +
    '</div>' +
    '<div class="field-row">' +
      '<div class="field"><label>PO # (optional)</label><input type="text" id="f-po" placeholder="PO number"></div>' +
      '<div class="field"><label>Requested job limit (optional)</label><input type="text" id="f-limit" placeholder="$"></div>' +
    '</div>' +

    '<div class="form-section-title">Job site</div>' +
    '<div class="field"><label>Job address</label><input type="text" id="f-jaddr" placeholder="Street address"></div>' +
    '<div class="field-row-3">' +
      '<div class="field"><label>City</label><input type="text" id="f-jcity"></div>' +
      '<div class="field"><label>State</label><input type="text" id="f-jstate" maxlength="2" placeholder="IA"></div>' +
      '<div class="field"><label>Zip</label><input type="text" id="f-jzip"></div>' +
    '</div>' +
    '<div class="field-row">' +
      '<div class="field"><label>Beginning date</label><input type="date" id="f-begin"></div>' +
      '<div class="field"><label>Est. completion</label><input type="text" id="f-complete" placeholder="e.g. Q3 2026"></div>' +
    '</div>' +

    '<div class="form-section-title">Contacts</div>' +
    '<div class="field-row">' +
      '<div class="field"><label>Job contact name</label><input type="text" id="f-contact"></div>' +
      '<div class="field"><label>Contact phone</label><input type="text" id="f-phone"></div>' +
    '</div>' +
    '<div class="field-row">' +
      '<div class="field"><label>General contractor</label><input type="text" id="f-gc"></div>' +
      '<div class="field"><label>Property owner</label><input type="text" id="f-owner"></div>' +
    '</div>' +

    '<div class="form-section-title">Tax &amp; classification</div>' +
    '<div class="field-row">' +
      '<div class="field"><label>Type of work</label><select id="f-worktype">' +
        '<option value="private">Private work</option>' +
        '<option value="public">Public work</option>' +
        '<option value="federal">Federal work</option>' +
        '<option value="state">State work</option>' +
        '<option value="other">Other</option>' +
      '</select></div>' +
      '<div class="field"><label>Taxable?</label><select id="f-taxable">' +
        '<option value="yes">Yes</option>' +
        '<option value="no">No \u2014 exemption cert on file</option>' +
      '</select></div>' +
    '</div>' +
    '<div class="field"><label>Project nature</label><select id="f-nature">' +
      '<option value="new">New structure</option>' +
      '<option value="addition">Addition to structure</option>' +
      '<option value="renovation">Renovation of existing</option>' +
      '<option value="retrofit">Retrofit</option>' +
      '<option value="other">Other</option>' +
    '</select></div>' +

    '<div class="form-section-title">Estimated material cost (optional)</div>' +
    '<div class="field-row-3">' +
      '<div class="field"><label>Gear $</label><input type="number" id="f-c-gear" min="0"></div>' +
      '<div class="field"><label>Fixtures $</label><input type="number" id="f-c-fixtures" min="0"></div>' +
      '<div class="field"><label>Rough-in $</label><input type="number" id="f-c-roughin" min="0"></div>' +
    '</div>' +
    '<div class="field-row-3">' +
      '<div class="field"><label>Connectivity $</label><input type="number" id="f-c-conn" min="0"></div>' +
      '<div class="field"><label>Cable $</label><input type="number" id="f-c-cable" min="0"></div>' +
      '<div class="field"><label>Misc $</label><input type="number" id="f-c-misc" min="0"></div>' +
    '</div>' +

    '<div class="form-section-title">Notes</div>' +
    '<div class="field"><textarea id="f-notes" placeholder="Spec billing, directs, initial order amount, lead time, material type, draw cut-off date, delivery instructions\u2026"></textarea></div>' +

    '<div class="form-section-title">Documents</div>';

  wrap.appendChild(body);

  /* file drops */
  body.appendChild(fileDropField("bom", "BOM export", "CSV or XLSX from the SiteMap Designer editor"));
  body.appendChild(fileDropField("pdf", "PDF plan set", "Site map / permit set / spec sheet (PDF)"));
  body.appendChild(fileDropField("data", "Optional data file", "Extra CSV or Excel — schedules, takeoffs, etc."));

  /* seeded cart preview */
  if (seededItems.length) {
    var cartNote = el("div", "cart-seed-note");
    cartNote.innerHTML = '<b>' + seededItems.length + '</b> catalog item' + (seededItems.length === 1 ? "" : "s") +
      ' from your cart (' + esc(distName(seededDist)) + ') will be attached to this request \u2014 est. ' + moneyShort(estTotal) + '.';
    body.appendChild(cartNote);
  }

  var foot = el("div", "modal-foot");
  var cancel = el("button", "btn btn-ghost", "Cancel"); cancel.onclick = closeModal;
  var submit = el("button", "btn btn-primary", "Submit request"); submit.id = "submitProjBtn";
  submit.onclick = function () { doSubmitProject(seededItems); };
  foot.appendChild(cancel); foot.appendChild(submit);
  wrap.appendChild(foot);

  openModal(wrap, true);
}

function numOrNull(id) {
  var v = $(id).value;
  return v === "" ? null : Number(v);
}

function doSubmitProject(seededItems) {
  var name = $("f-name").value.trim();
  var targetDistId = $("f-dist").value;
  if (!name) { toast("Give the project a name.", true); return; }
  if (!targetDistId) { toast("Pick a distributor to submit to.", true); return; }

  var btn = $("submitProjBtn");
  btn.disabled = true; btn.textContent = "Submitting\u2026";

  var cGear = numOrNull("f-c-gear"), cFix = numOrNull("f-c-fixtures"), cRough = numOrNull("f-c-roughin");
  var cConn = numOrNull("f-c-conn"), cCable = numOrNull("f-c-cable"), cMisc = numOrNull("f-c-misc");
  var estFromCategories = (cGear || 0) + (cFix || 0) + (cRough || 0) + (cConn || 0) + (cCable || 0) + (cMisc || 0);

  var cartItems = [];
  var estFromCart = 0;
  for (var i = 0; i < (seededItems || []).length; i++) {
    var it = seededItems[i];
    cartItems.push({
      productId: it.product._id || null,
      sku: it.product.sku || "",
      name: it.product.name || "",
      category: it.product.category || "misc",
      unitPrice: Number(it.product.unitPrice || 0),
      uom: it.product.uom || "ea",
      qty: Number(it.qty || 1)
    });
    estFromCart += Number(it.product.unitPrice || 0) * Number(it.qty || 1);
  }

  var proj = {
    name: name,
    type: $("f-type").value,
    targetDistId: targetDistId,
    targetDistName: distName(targetDistId),
    poNumber: $("f-po").value.trim(),
    requestedLimit: $("f-limit").value.trim(),
    jobAddress: $("f-jaddr").value.trim(),
    jobCity: $("f-jcity").value.trim(),
    jobState: $("f-jstate").value.trim().toUpperCase(),
    jobZip: $("f-jzip").value.trim(),
    beginDate: $("f-begin").value || "",
    completeDate: $("f-complete").value.trim(),
    contactName: $("f-contact").value.trim(),
    contactPhone: $("f-phone").value.trim(),
    generalContractor: $("f-gc").value.trim(),
    propertyOwner: $("f-owner").value.trim(),
    workType: $("f-worktype").value,
    taxable: $("f-taxable").value,
    projectNature: $("f-nature").value,
    costGear: cGear, costFixtures: cFix, costRoughin: cRough,
    costConnectivity: cConn, costCable: cCable, costMisc: cMisc,
    notes: $("f-notes").value.trim(),
    cartItems: cartItems,
    estMaterialsTotal: estFromCart > 0 ? estFromCart : (estFromCategories > 0 ? estFromCategories : null),
    developerUid: STATE.user.uid,
    developerOrg: STATE.profile.org || "",
    developerName: STATE.profile.name || STATE.profile.email,
    developerEmail: STATE.profile.email || "",
    status: "submitted",
    docs: {},
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  };

  db.collection(COL_PROJECTS).add(proj).then(function (ref) {
    var pid = ref.id;
    var keys = ["bom", "pdf", "data"];
    var uploads = [];
    for (var k = 0; k < keys.length; k++) {
      (function (key) {
        var file = PENDING[key];
        if (!file) { return; }
        var path = "mkt_projects/" + pid + "/" + key + "_" + Date.now() + "_" + file.name;
        var task = storage.ref(path).put(file).then(function (snap) {
          return snap.ref.getDownloadURL().then(function (url) {
            return { key: key, meta: { name: file.name, url: url, path: path } };
          });
        });
        uploads.push(task);
      })(keys[k]);
    }
    if (uploads.length === 0) { return finish(); }
    return Promise.all(uploads).then(function (results) {
      var patch = {};
      for (var j = 0; j < results.length; j++) { patch["docs." + results[j].key] = results[j].meta; }
      return db.collection(COL_PROJECTS).doc(pid).update(patch).then(finish);
    });
  })["catch"](function (err) {
    btn.disabled = false; btn.textContent = "Submit request";
    toast(friendlyErr(err), true);
  });

  function finish() {
    /* clear cart if we consumed it */
    if (seededItems && seededItems.length) { STATE.cart = []; updateCartBadge(); }
    PENDING = { bom: null, pdf: null, data: null };
    toast("Material request submitted to " + distName(targetDistId) + ".");
    closeModal();
  }
}

/* ============================================================
   PROJECT DETAIL — full lifecycle
   ============================================================ */
function openProjectDetail(pid) {
  var wrap = el("div");
  wrap.appendChild(modalHead("Loading\u2026", ""));
  var body = el("div", "modal-body");
  body.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  wrap.appendChild(body);
  openModal(wrap, true);

  var projRef = db.collection(COL_PROJECTS).doc(pid);
  projRef.get().then(function (snap) {
    if (!snap.exists) { closeModal(); toast("Project no longer exists.", true); return; }
    var p = snap.data(); p._id = pid;

    var quoteP = projRef.collection("quote").doc("current").get()
      .then(function (d) { return d.exists ? d.data() : null; })["catch"](function () { return null; });
    var invP = projRef.collection("invoice").doc("current").get()
      .then(function (d) { return d.exists ? d.data() : null; })["catch"](function () { return null; });
    var msgP = projRef.collection("messages").orderBy("createdAt", "asc").get()
      .then(function (s) { var a = []; s.forEach(function (m) { var x = m.data(); x._id = m.id; a.push(x); }); return a; })
      ["catch"](function () { return []; });

    Promise.all([quoteP, invP, msgP]).then(function (res) {
      renderProjectDetail(p, res[0], res[1], res[2]);
    });
  })["catch"](function (err) { closeModal(); toast(friendlyErr(err), true); });
}

function renderProjectDetail(p, quote, invoice, msgs) {
  var isDev = (STATE.role === "developer");
  var isDist = (STATE.role === "distributor");
  var isAdmin = (STATE.role === "admin");

  var wrap = el("div");
  var head = el("div", "modal-head");
  var hl = el("div");
  hl.innerHTML = '<h2>' + esc(p.name || "Project") + '</h2>' +
    '<div class="mh-sub">' + esc(TYPE_LABELS[p.type] || p.type || "") +
    " \u00b7 " + esc(distName(p.targetDistId)) + " " + statusPill(p.status) + '</div>';
  var x = el("button", "modal-close", "&times;"); x.onclick = closeModal;
  head.appendChild(hl); head.appendChild(x);
  wrap.appendChild(head);

  var body = el("div", "modal-body");

  /* ---- progress stepper ---- */
  body.appendChild(buildStepper(p.status));

  var grid = el("div", "detail-grid");

  /* ===== LEFT: package + docs + line items ===== */
  var left = el("div");

  var facts = el("div", "detail-sec");
  facts.innerHTML = '<h4>Job information</h4>';
  var kv = el("div", "kv-list");
  var siteLine = [p.jobAddress, p.jobCity, p.jobState, p.jobZip].filter(function (v) { return v; }).join(", ");
  kv.innerHTML =
    row("Developer", esc(p.developerOrg || p.developerName || "\u2014")) +
    row("Distributor", esc(distName(p.targetDistId))) +
    (p.poNumber ? row("PO #", esc(p.poNumber)) : "") +
    (siteLine ? row("Job site", esc(siteLine)) : "") +
    (p.contactName ? row("Job contact", esc(p.contactName) + (p.contactPhone ? " \u00b7 " + esc(p.contactPhone) : "")) : "") +
    (p.generalContractor ? row("GC", esc(p.generalContractor)) : "") +
    (p.beginDate ? row("Begins", esc(p.beginDate)) : "") +
    (p.completeDate ? row("Est. completion", esc(p.completeDate)) : "") +
    row("Type of work", esc(p.workType || "\u2014")) +
    row("Taxable", p.taxable === "no" ? "No (exempt)" : "Yes") +
    row("Submitted", esc(fmtDate(p.createdAt)));
  facts.appendChild(kv);
  left.appendChild(facts);

  /* estimated cost breakdown */
  if (p.costGear || p.costFixtures || p.costRoughin || p.costConnectivity || p.costCable || p.costMisc) {
    var cSec = el("div", "detail-sec");
    cSec.innerHTML = '<h4>Estimated material cost</h4>';
    var ckv = el("div", "kv-list");
    ckv.innerHTML =
      (p.costGear ? row("Gear", money(p.costGear)) : "") +
      (p.costFixtures ? row("Fixtures", money(p.costFixtures)) : "") +
      (p.costRoughin ? row("Rough-in", money(p.costRoughin)) : "") +
      (p.costConnectivity ? row("Connectivity", money(p.costConnectivity)) : "") +
      (p.costCable ? row("Cable", money(p.costCable)) : "") +
      (p.costMisc ? row("Misc", money(p.costMisc)) : "");
    cSec.appendChild(ckv);
    left.appendChild(cSec);
  }

  if (p.notes) {
    var nSec = el("div", "detail-sec");
    nSec.innerHTML = '<h4>Notes</h4><div class="detail-text">' + esc(p.notes) + '</div>';
    left.appendChild(nSec);
  }

  /* documents */
  var docSec = el("div", "detail-sec");
  docSec.innerHTML = '<h4>Documents</h4>';
  var docs = p.docs || {};
  var docDefs = [["bom", "BOM export"], ["pdf", "PDF plan set"], ["data", "Data file"]];
  var anyDoc = false;
  for (var d = 0; d < docDefs.length; d++) {
    var key = docDefs[d][0], lbl = docDefs[d][1];
    if (docs[key] && docs[key].url) {
      anyDoc = true;
      var a = el("a", "doc-link");
      a.href = docs[key].url; a.target = "_blank"; a.rel = "noopener";
      a.innerHTML =
        '<span class="dl-ic"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></span>' +
        '<span class="dl-name">' + esc(lbl) + " \u2014 " + esc(docs[key].name) + '</span>' +
        '<span class="dl-go">Open &rarr;</span>';
      docSec.appendChild(a);
    }
  }
  if (!anyDoc) { docSec.appendChild(el("div", "doc-missing", "No documents attached.")); }
  left.appendChild(docSec);

  /* line items (from cart or BOM) */
  var liSec = el("div", "detail-sec");
  liSec.innerHTML = '<h4>Line items</h4>';
  if (p.cartItems && p.cartItems.length) {
    liSec.appendChild(buildLineItemsTable(p.cartItems, quote));
  } else {
    liSec.appendChild(el("div", "doc-missing", "No catalog line items \u2014 pricing will be built from the attached BOM."));
  }
  left.appendChild(liSec);

  grid.appendChild(left);

  /* ===== RIGHT: actions (quote / invoice) + messages ===== */
  var right = el("div");
  right.appendChild(buildActionPanel(p, quote, invoice));
  right.appendChild(buildMessageThread(p, msgs));
  grid.appendChild(right);

  body.appendChild(grid);
  wrap.appendChild(body);
  openModal(wrap, true);
}

function buildStepper(status) {
  var wrap = el("div", "stepper");
  var idx = STATUS_ORDER.indexOf(status);
  if (status === "declined") { idx = -1; }
  for (var i = 0; i < STATUS_ORDER.length; i++) {
    var done = (idx >= i);
    var cur = (idx === i);
    var step = el("div", "step" + (done ? " done" : "") + (cur ? " current" : ""));
    step.innerHTML = '<div class="step-dot">' + (done ? "\u2713" : (i + 1)) + '</div>' +
      '<div class="step-label">' + esc(STATUS_LABELS[STATUS_ORDER[i]]) + '</div>';
    wrap.appendChild(step);
  }
  if (status === "declined") {
    var db2 = el("div", "declined-banner", "This request was declined by the distributor.");
    var outer = el("div");
    outer.appendChild(wrap); outer.appendChild(db2);
    return outer;
  }
  return wrap;
}

function buildLineItemsTable(items, quote) {
  var qLines = (quote && quote.lines) ? quote.lines : null;
  var t = el("table", "li-table");
  var head = '<thead><tr><th>Item</th><th>Qty</th><th class="num">Est. unit</th>';
  if (qLines) { head += '<th class="num">Quoted unit</th>'; }
  head += '<th class="num">Line</th></tr></thead>';
  var rows = "";
  var estTotal = 0, quoteTotal = 0;
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var estUnit = Number(it.unitPrice || 0);
    var qUnit = null;
    if (qLines && qLines[i] && qLines[i].unitPrice != null) { qUnit = Number(qLines[i].unitPrice); }
    var lineUnit = qUnit != null ? qUnit : estUnit;
    var line = lineUnit * Number(it.qty || 1);
    estTotal += estUnit * Number(it.qty || 1);
    quoteTotal += line;
    rows += '<tr><td><div class="li-name">' + esc(it.name) + '</div>' +
      (it.sku ? '<div class="li-sku">' + esc(it.sku) + '</div>' : "") + '</td>' +
      '<td>' + esc(it.qty) + " " + esc(it.uom || "ea") + '</td>' +
      '<td class="num">' + money(estUnit) + '</td>' +
      (qLines ? '<td class="num">' + (qUnit != null ? money(qUnit) : "\u2014") + '</td>' : "") +
      '<td class="num">' + money(line) + '</td></tr>';
  }
  var footTotal = qLines ? quoteTotal : estTotal;
  var colspan = qLines ? 4 : 3;
  rows += '<tr class="li-total"><td colspan="' + colspan + '">Materials subtotal</td><td class="num">' + money(footTotal) + '</td></tr>';
  t.innerHTML = head + '<tbody>' + rows + '</tbody>';
  return t;
}

/* ============================================================
   ACTION PANEL — role- and status-aware lifecycle controls
   ============================================================ */
function buildActionPanel(p, quote, invoice) {
  var panel = el("div", "action-panel");
  var isDev = (STATE.role === "developer");
  var isDist = (STATE.role === "distributor");
  var isAdmin = (STATE.role === "admin");
  var canDist = isDist || isAdmin;

  panel.innerHTML = '<div class="ap-title">Status &amp; actions</div>';

  /* ---- current invoice summary (if any) ---- */
  if (invoice) {
    var inv = el("div", "invoice-box");
    inv.innerHTML =
      '<div class="ib-row"><span>Invoice</span><b>' + money(invoice.amount) + '</b></div>' +
      '<div class="ib-row"><span>Provider</span><b>' + esc((invoice.provider || "external").toUpperCase()) + '</b></div>' +
      '<div class="ib-row"><span>Status</span>' + statusPill(invoice.paid ? "paid" : "invoiced") + '</div>';
    if (invoice.externalUrl) {
      var pay = el("a", "btn btn-green btn-block", invoice.paid ? "View receipt" : "Pay invoice \u2192");
      pay.href = invoice.externalUrl; pay.target = "_blank"; pay.rel = "noopener";
      pay.style.marginTop = "10px";
      inv.appendChild(pay);
    }
    panel.appendChild(inv);
  }

  /* ---- shipping info (if set) ---- */
  if (p.shipping && (p.shipping.carrier || p.shipping.tracking || p.shipping.eta)) {
    var sh = el("div", "ship-box");
    sh.innerHTML = '<div class="sb-title">Shipping</div>' +
      (p.shipping.carrier ? '<div class="ib-row"><span>Carrier</span><b>' + esc(p.shipping.carrier) + '</b></div>' : "") +
      (p.shipping.tracking ? '<div class="ib-row"><span>Tracking</span><b>' + esc(p.shipping.tracking) + '</b></div>' : "") +
      (p.shipping.eta ? '<div class="ib-row"><span>ETA</span><b>' + esc(p.shipping.eta) + '</b></div>' : "");
    panel.appendChild(sh);
  }

  var actions = el("div", "ap-actions");

  /* ===== DISTRIBUTOR actions ===== */
  if (canDist) {
    if (p.status === "submitted") {
      var acc = el("button", "btn btn-primary btn-block", "Accept project");
      acc.onclick = function () { setProjStatus(p, "accepted"); };
      actions.appendChild(acc);
      var dec = el("button", "btn btn-danger btn-block", "Decline");
      dec.style.marginTop = "8px";
      dec.onclick = function () { if (window.confirm("Decline this material request?")) { setProjStatus(p, "declined"); } };
      actions.appendChild(dec);
    }
    if (p.status === "accepted" || p.status === "quoted") {
      var qb = el("button", "btn btn-primary btn-block", quote ? "Update quote" : "Build quote / price it");
      qb.onclick = function () { openQuoteModal(p, quote); };
      actions.appendChild(qb);
    }
    if (p.status === "quoted" || (quote && p.status === "accepted")) {
      var ib = el("button", "btn btn-green btn-block", invoice ? "Update invoice" : "Send invoice");
      ib.style.marginTop = "8px";
      ib.onclick = function () { openInvoiceModal(p, quote, invoice); };
      actions.appendChild(ib);
    }
    if (p.status === "paid") {
      var sb = el("button", "btn btn-primary btn-block", (p.shipping ? "Update shipping" : "Add shipping info"));
      sb.onclick = function () { openShippingModal(p); };
      actions.appendChild(sb);
      var fb = el("button", "btn btn-green btn-block", "Mark fulfilled");
      fb.style.marginTop = "8px";
      fb.onclick = function () { if (window.confirm("Mark this project fulfilled?")) { setProjStatus(p, "fulfilled"); } };
      actions.appendChild(fb);
    }
    if (p.status === "invoiced") {
      var mp = el("button", "btn btn-green btn-block", "Mark invoice paid");
      mp.onclick = function () { markInvoicePaid(p); };
      actions.appendChild(mp);
      var sb2 = el("button", "btn btn-ghost btn-block", (p.shipping ? "Update shipping" : "Add shipping info"));
      sb2.style.marginTop = "8px";
      sb2.onclick = function () { openShippingModal(p); };
      actions.appendChild(sb2);
    }
  }

  /* ===== DEVELOPER actions ===== */
  if (isDev) {
    if (p.status === "invoiced" && invoice && !invoice.paid) {
      var note = el("div", "ap-note", "Your distributor has issued an invoice. Pay it using the button above, then mark it acknowledged.");
      actions.appendChild(note);
      var ackp = el("button", "btn btn-green btn-block", "I've paid this invoice");
      ackp.style.marginTop = "8px";
      ackp.onclick = function () { devAckPaid(p, invoice); };
      actions.appendChild(ackp);
    }
    if (p.status === "quoted") {
      actions.appendChild(el("div", "ap-note", "A quote is ready. Review the quoted unit prices at left. The distributor will send a payable invoice next."));
    }
    if (p.status === "submitted") {
      actions.appendChild(el("div", "ap-note", "Waiting for " + esc(distName(p.targetDistId)) + " to accept and price this request."));
      var del = el("button", "btn btn-danger btn-block", "Withdraw request");
      del.style.marginTop = "8px";
      del.onclick = function () { if (window.confirm("Withdraw this request? This deletes it.")) { deleteProject(p); } };
      actions.appendChild(del);
    }
  }

  if (actions.children.length === 0 && !invoice) {
    actions.appendChild(el("div", "ap-note", "No actions available at this stage."));
  }
  panel.appendChild(actions);
  return panel;
}

/* ---------- status transitions ---------- */
function setProjStatus(p, status) {
  db.collection(COL_PROJECTS).doc(p._id).update({
    status: status, updatedAt: FieldValue.serverTimestamp()
  }).then(function () {
    toast("Status: " + (STATUS_LABELS[status] || status));
    openProjectDetail(p._id);
  })["catch"](function (err) { toast(friendlyErr(err), true); });
}

function deleteProject(p) {
  db.collection(COL_PROJECTS).doc(p._id)["delete"]().then(function () {
    toast("Request withdrawn.");
    closeModal();
  })["catch"](function (err) { toast(friendlyErr(err), true); });
}

/* ============================================================
   QUOTE MODAL — distributor prices each line
   ============================================================ */
function openQuoteModal(p, existing) {
  var items = p.cartItems || [];
  var wrap = el("div");
  wrap.appendChild(modalHead("Build quote", esc(p.name)));
  var body = el("div", "modal-body");

  if (!items.length) {
    body.innerHTML = '<div class="field"><label>No catalog line items on this request.</label>' +
      '<p class="doc-missing">Price the project as a lump sum from the attached BOM instead.</p></div>' +
      '<div class="field"><label>Materials subtotal ($)</label><input type="number" id="q-lump" min="0" placeholder="e.g. 48200"></div>';
  } else {
    var existingLines = (existing && existing.lines) ? existing.lines : [];
    var html = '<div class="form-section-title">Unit pricing</div><table class="li-table edit"><thead><tr><th>Item</th><th>Qty</th><th class="num">Quoted unit $</th></tr></thead><tbody>';
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var pre = (existingLines[i] && existingLines[i].unitPrice != null) ? existingLines[i].unitPrice : (it.unitPrice || "");
      html += '<tr><td><div class="li-name">' + esc(it.name) + '</div>' +
        (it.sku ? '<div class="li-sku">' + esc(it.sku) + '</div>' : "") + '</td>' +
        '<td>' + esc(it.qty) + " " + esc(it.uom || "ea") + '</td>' +
        '<td class="num"><input type="number" class="q-unit" data-idx="' + i + '" min="0" step="0.01" value="' + esc(pre) + '"></td></tr>';
    }
    html += '</tbody></table>';
    body.innerHTML = html;
  }

  /* shipping + tax on the quote */
  body.appendChild(el("div", "form-section-title", "Adjustments"));
  var adj = el("div");
  adj.innerHTML =
    '<div class="field-row">' +
      '<div class="field"><label>Shipping / freight ($)</label><input type="number" id="q-ship" min="0" step="0.01" value="' + esc(existing && existing.shipping != null ? existing.shipping : "") + '"></div>' +
      '<div class="field"><label>Tax ($)</label><input type="number" id="q-tax" min="0" step="0.01" value="' + esc(existing && existing.tax != null ? existing.tax : "") + '"></div>' +
    '</div>' +
    '<div class="field"><label>Quote notes (lead time, substitutions, terms)</label><textarea id="q-notes" placeholder="e.g. 3-week lead on switchgear; Square D substituted for Eaton on breakers.">' + esc(existing && existing.notes ? existing.notes : "") + '</textarea></div>';
  body.appendChild(adj);
  wrap.appendChild(body);

  var foot = el("div", "modal-foot");
  var cancel = el("button", "btn btn-ghost", "Cancel"); cancel.onclick = function () { openProjectDetail(p._id); };
  var save = el("button", "btn btn-primary", "Save quote"); save.id = "saveQuoteBtn";
  save.onclick = function () { doSaveQuote(p, items); };
  foot.appendChild(cancel); foot.appendChild(save);
  wrap.appendChild(foot);
  openModal(wrap, true);
}

function doSaveQuote(p, items) {
  var lines = [];
  var subtotal = 0;
  if (items.length) {
    var inputs = document.querySelectorAll(".q-unit");
    for (var i = 0; i < inputs.length; i++) {
      var idx = Number(inputs[i].getAttribute("data-idx"));
      var unit = inputs[i].value === "" ? null : Number(inputs[i].value);
      lines[idx] = { unitPrice: unit };
      if (unit != null) { subtotal += unit * Number(items[idx].qty || 1); }
    }
  } else {
    var lump = $("q-lump") ? Number($("q-lump").value || 0) : 0;
    subtotal = lump;
  }
  var ship = $("q-ship").value === "" ? 0 : Number($("q-ship").value);
  var tax = $("q-tax").value === "" ? 0 : Number($("q-tax").value);
  var total = subtotal + ship + tax;

  var btn = $("saveQuoteBtn"); btn.disabled = true; btn.textContent = "Saving\u2026";

  var quote = {
    lines: lines,
    subtotal: subtotal, shipping: ship, tax: tax, total: total,
    notes: $("q-notes").value.trim(),
    quotedByUid: STATE.user.uid,
    quotedByOrg: STATE.profile.org || distName(p.targetDistId),
    updatedAt: FieldValue.serverTimestamp()
  };

  var projRef = db.collection(COL_PROJECTS).doc(p._id);
  projRef.collection("quote").doc("current").set(quote).then(function () {
    return projRef.update({ status: "quoted", quoteTotal: total, updatedAt: FieldValue.serverTimestamp() });
  }).then(function () {
    toast("Quote saved and sent to developer.");
    openProjectDetail(p._id);
  })["catch"](function (err) {
    btn.disabled = false; btn.textContent = "Save quote";
    toast(friendlyErr(err), true);
  });
}

/* ============================================================
   INVOICE MODAL — external payment link (Stripe-ready)
   ============================================================ */
function openInvoiceModal(p, quote, existing) {
  var wrap = el("div");
  wrap.appendChild(modalHead("Send invoice", esc(p.name)));
  var body = el("div", "modal-body");
  var defAmount = existing && existing.amount != null ? existing.amount :
    (quote && quote.total != null ? quote.total : (p.estMaterialsTotal || ""));

  body.innerHTML =
    '<div class="field"><label>Invoice amount ($) *</label><input type="number" id="inv-amount" min="0" step="0.01" value="' + esc(defAmount) + '"></div>' +
    '<div class="field"><label>Payment provider</label><select id="inv-provider">' +
      '<option value="stripe"' + (existing && existing.provider === "stripe" ? " selected" : "") + '>Stripe</option>' +
      '<option value="square"' + (existing && existing.provider === "square" ? " selected" : "") + '>Square</option>' +
      '<option value="quickbooks"' + (existing && existing.provider === "quickbooks" ? " selected" : "") + '>QuickBooks</option>' +
      '<option value="other"' + (existing && existing.provider === "other" ? " selected" : "") + '>Other</option>' +
    '</select></div>' +
    '<div class="field"><label>Payment link *</label><input type="url" id="inv-url" placeholder="https://\u2026 paste your Stripe/Square/QuickBooks invoice link" value="' + esc(existing && existing.externalUrl ? existing.externalUrl : "") + '"></div>' +
    '<div class="field"><label>Invoice # (optional)</label><input type="text" id="inv-num" value="' + esc(existing && existing.number ? existing.number : "") + '"></div>' +
    '<div class="field"><label>Terms / memo</label><textarea id="inv-memo" placeholder="Net 30, deposit required, etc.">' + esc(existing && existing.memo ? existing.memo : "") + '</textarea></div>' +
    '<div class="stripe-note">Full in-portal Stripe checkout is planned. For now, generate the invoice link in your payment tool and paste it here \u2014 the developer pays through that link and you mark it paid (or a Stripe webhook will later flip it automatically).</div>';
  wrap.appendChild(body);

  var foot = el("div", "modal-foot");
  var cancel = el("button", "btn btn-ghost", "Cancel"); cancel.onclick = function () { openProjectDetail(p._id); };
  var save = el("button", "btn btn-green", "Send invoice"); save.id = "saveInvBtn";
  save.onclick = function () { doSaveInvoice(p); };
  foot.appendChild(cancel); foot.appendChild(save);
  wrap.appendChild(foot);
  openModal(wrap, false);
}

function doSaveInvoice(p) {
  var amount = Number($("inv-amount").value || 0);
  var url = $("inv-url").value.trim();
  if (!amount) { toast("Enter an invoice amount.", true); return; }
  if (!url) { toast("Paste the payment link.", true); return; }

  var btn = $("saveInvBtn"); btn.disabled = true; btn.textContent = "Sending\u2026";
  var invoice = {
    amount: amount,
    provider: $("inv-provider").value,
    externalUrl: url,
    number: $("inv-num").value.trim(),
    memo: $("inv-memo").value.trim(),
    paid: false,
    /* reserved for Stripe serverless integration */
    stripeSessionId: null, stripePaymentIntent: null,
    issuedByUid: STATE.user.uid,
    createdAt: FieldValue.serverTimestamp()
  };
  var projRef = db.collection(COL_PROJECTS).doc(p._id);
  projRef.collection("invoice").doc("current").set(invoice).then(function () {
    return projRef.update({ status: "invoiced", invoiceAmount: amount, updatedAt: FieldValue.serverTimestamp() });
  }).then(function () {
    toast("Invoice sent to developer.");
    openProjectDetail(p._id);
  })["catch"](function (err) {
    btn.disabled = false; btn.textContent = "Send invoice";
    toast(friendlyErr(err), true);
  });
}

function markInvoicePaid(p) {
  if (!window.confirm("Mark this invoice as paid?")) { return; }
  var projRef = db.collection(COL_PROJECTS).doc(p._id);
  projRef.collection("invoice").doc("current").update({ paid: true, paidAt: FieldValue.serverTimestamp() })
    .then(function () {
      return projRef.update({ status: "paid", updatedAt: FieldValue.serverTimestamp() });
    }).then(function () {
      toast("Invoice marked paid.");
      openProjectDetail(p._id);
    })["catch"](function (err) { toast(friendlyErr(err), true); });
}

function devAckPaid(p, invoice) {
  /* developer marks their side paid; distributor still confirms receipt.
     Rules allow the dev to update invoice only if provider+amount unchanged. */
  var projRef = db.collection(COL_PROJECTS).doc(p._id);
  var patch = { provider: invoice.provider, amount: invoice.amount, devMarkedPaid: true, devMarkedPaidAt: FieldValue.serverTimestamp() };
  projRef.collection("invoice").doc("current").update(patch).then(function () {
    return addMessage(p._id, "Developer marked the invoice as paid.");
  }).then(function () {
    toast("Marked as paid \u2014 the distributor will confirm receipt.");
    openProjectDetail(p._id);
  })["catch"](function (err) { toast(friendlyErr(err), true); });
}

/* ============================================================
   SHIPPING MODAL
   ============================================================ */
function openShippingModal(p) {
  var sh = p.shipping || {};
  var wrap = el("div");
  wrap.appendChild(modalHead("Shipping information", esc(p.name)));
  var body = el("div", "modal-body");
  body.innerHTML =
    '<div class="field"><label>Carrier</label><input type="text" id="sh-carrier" value="' + esc(sh.carrier || "") + '" placeholder="e.g. R+L Carriers, will-call"></div>' +
    '<div class="field"><label>Tracking #</label><input type="text" id="sh-track" value="' + esc(sh.tracking || "") + '"></div>' +
    '<div class="field"><label>ETA / delivery date</label><input type="text" id="sh-eta" value="' + esc(sh.eta || "") + '" placeholder="e.g. Mar 14 or 3-day"></div>' +
    '<div class="field"><label>Ship-to / instructions</label><textarea id="sh-notes">' + esc(sh.notes || "") + '</textarea></div>';
  wrap.appendChild(body);
  var foot = el("div", "modal-foot");
  var cancel = el("button", "btn btn-ghost", "Cancel"); cancel.onclick = function () { openProjectDetail(p._id); };
  var save = el("button", "btn btn-primary", "Save shipping"); save.id = "saveShipBtn";
  save.onclick = function () {
    save.disabled = true;
    db.collection(COL_PROJECTS).doc(p._id).update({
      shipping: {
        carrier: $("sh-carrier").value.trim(),
        tracking: $("sh-track").value.trim(),
        eta: $("sh-eta").value.trim(),
        notes: $("sh-notes").value.trim()
      },
      updatedAt: FieldValue.serverTimestamp()
    }).then(function () {
      toast("Shipping saved.");
      openProjectDetail(p._id);
    })["catch"](function (err) { save.disabled = false; toast(friendlyErr(err), true); });
  };
  foot.appendChild(cancel); foot.appendChild(save);
  wrap.appendChild(foot);
  openModal(wrap, false);
}

/* ============================================================
   MESSAGE THREAD
   ============================================================ */
function buildMessageThread(p, msgs) {
  var sec = el("div", "msg-sec");
  sec.innerHTML = '<div class="ap-title">Messages</div>';
  var list = el("div", "msg-list");
  if (!msgs || !msgs.length) {
    list.appendChild(el("div", "doc-missing", "No messages yet. Ask a question or add a note."));
  } else {
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      var mine = (m.authorUid === STATE.user.uid);
      var bubble = el("div", "msg" + (mine ? " mine" : ""));
      bubble.innerHTML = '<div class="msg-meta">' + esc(m.authorName || "") +
        ' \u00b7 <span>' + esc(timeAgo(m.createdAt)) + '</span></div>' +
        '<div class="msg-body">' + esc(m.body) + '</div>';
      list.appendChild(bubble);
    }
  }
  sec.appendChild(list);
  var inputRow = el("div", "msg-input");
  inputRow.innerHTML = '<input type="text" id="msgInput" placeholder="Write a message\u2026">';
  var send = el("button", "btn btn-primary btn-sm", "Send");
  send.onclick = function () {
    var v = $("msgInput").value.trim();
    if (!v) { return; }
    $("msgInput").value = "";
    addMessage(p._id, v).then(function () { openProjectDetail(p._id); })
      ["catch"](function (err) { toast(friendlyErr(err), true); });
  };
  inputRow.appendChild(send);
  setTimeout(function () {
    var mi = $("msgInput");
    if (mi) { mi.onkeydown = function (e) { if (e.key === "Enter") { send.onclick(); } }; }
  }, 0);
  sec.appendChild(inputRow);
  return sec;
}

function addMessage(pid, body) {
  return db.collection(COL_PROJECTS).doc(pid).collection("messages").add({
    authorUid: STATE.user.uid,
    authorName: STATE.profile.name || STATE.profile.email,
    authorRole: STATE.role,
    body: body,
    createdAt: FieldValue.serverTimestamp()
  });
}

/* ============================================================
   CATALOG VIEW
   - developer: pick a distributor, browse, add to cart
   - distributor: manage own catalog (add/edit/remove)
   - admin: pick a distributor and view/manage
   ============================================================ */
var CATALOG = { distId: null, products: [], search: "", category: "all" };

function renderCatalogView() {
  var main = $("mainArea");
  main.innerHTML = "";

  if (STATE.role === "distributor") {
    CATALOG.distId = STATE.distributorId;
    renderDistributorCatalog();
    return;
  }
  /* developer / admin: distributor picker first */
  if (!CATALOG.distId) {
    renderDistributorPicker();
  } else {
    renderBrowseCatalog();
  }
}

function renderDistributorPicker() {
  var main = $("mainArea");
  main.innerHTML = "";
  var head = el("div", "page-head");
  head.innerHTML = '<div><h1>Catalog &amp; Shop</h1><p class="ph-sub">Pick a distributor to browse their catalog. Add products to a cart and submit them as a project \u2014 or shop it yourself.</p></div>';
  main.appendChild(head);

  if (!STATE.distributors.length) {
    main.appendChild(emptyBox("No distributors onboarded yet", "Once a distribution partner is onboarded and uploads a catalog, it appears here."));
    return;
  }
  var grid = el("div", "dist-grid");
  for (var i = 0; i < STATE.distributors.length; i++) {
    (function (d) {
      var card = el("div", "dist-card");
      card.innerHTML =
        '<div class="dist-logo">' + (d.logo ? '<img src="' + esc(d.logo) + '" alt="">' : esc(initials(d.name))) + '</div>' +
        '<div class="dist-name">' + esc(d.name) + '</div>' +
        '<div class="dist-meta">' + esc(d.location || d.contact || "Distribution partner") + '</div>' +
        (d.apiEnabled ? '<div class="dist-badge">Live availability</div>' : '');
      var b = el("button", "btn btn-ghost btn-sm btn-block", "Browse catalog");
      b.style.marginTop = "12px";
      b.onclick = function () { CATALOG.distId = d._id; CATALOG.search = ""; CATALOG.category = "all"; renderBrowseCatalog(); };
      card.appendChild(b);
      grid.appendChild(card);
    })(STATE.distributors[i]);
  }
  main.appendChild(grid);
}

function loadCatalog(distId) {
  return db.collection(COL_DISTRIBUTORS).doc(distId).collection("catalog").get()
    .then(function (snap) {
      var arr = [];
      snap.forEach(function (d) { var x = d.data(); x._id = d.id; arr.push(x); });
      arr.sort(function (a, b) { return (a.name || "").localeCompare(b.name || ""); });
      CATALOG.products = arr;
      return arr;
    })["catch"](function () { CATALOG.products = []; return []; });
}

/* ---------- developer / admin browse ---------- */
function renderBrowseCatalog() {
  var main = $("mainArea");
  main.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  loadCatalog(CATALOG.distId).then(function () {
    main.innerHTML = "";
    var head = el("div", "page-head");
    var back = '<button class="link-back" id="catBack">\u2190 All distributors</button>';
    head.innerHTML = '<div>' + back + '<h1>' + esc(distName(CATALOG.distId)) + '</h1>' +
      '<p class="ph-sub">' + CATALOG.products.length + ' products \u00b7 add to cart, then submit as a project.</p></div>';
    main.appendChild(head);
    $("catBack").onclick = function () { CATALOG.distId = null; renderCatalogView(); };

    main.appendChild(buildCatalogToolbar(false));
    var grid = el("div", "prod-grid"); grid.id = "prodGrid";
    main.appendChild(grid);
    renderProductGrid(false);
  });
}

function buildCatalogToolbar(isOwner) {
  var bar = el("div", "cat-toolbar");
  var cats = '<option value="all">All categories</option>';
  for (var key in CATEGORY_LABELS) {
    if (CATEGORY_LABELS.hasOwnProperty(key)) {
      cats += '<option value="' + key + '"' + (CATALOG.category === key ? " selected" : "") + '>' + esc(CATEGORY_LABELS[key]) + '</option>';
    }
  }
  bar.innerHTML =
    '<input type="text" id="catSearch" class="cat-search" placeholder="Search SKU or name\u2026" value="' + esc(CATALOG.search) + '">' +
    '<select id="catCategory" class="cat-cat">' + cats + '</select>';
  if (isOwner) {
    var add = el("button", "btn btn-primary btn-sm", "+ Add product");
    add.onclick = function () { openProductModal(null); };
    bar.appendChild(add);
  }
  setTimeout(function () {
    var s = $("catSearch"), c = $("catCategory");
    if (s) { s.oninput = function () { CATALOG.search = s.value; renderProductGrid(isOwner); }; }
    if (c) { c.onchange = function () { CATALOG.category = c.value; renderProductGrid(isOwner); }; }
  }, 0);
  return bar;
}

function filteredProducts() {
  var q = CATALOG.search.toLowerCase();
  return CATALOG.products.filter(function (p) {
    if (CATALOG.category !== "all" && p.category !== CATALOG.category) { return false; }
    if (!q) { return true; }
    return (p.name || "").toLowerCase().indexOf(q) > -1 ||
           (p.sku || "").toLowerCase().indexOf(q) > -1 ||
           (p.brand || "").toLowerCase().indexOf(q) > -1;
  });
}

function stockBadge(p) {
  var st = p.stockStatus || (p.stockQty > 0 ? "in" : "unknown");
  if (st === "in" || (p.stockQty && p.stockQty > 0)) {
    return '<span class="stock in">In stock' + (p.stockQty ? " \u00b7 " + p.stockQty : "") + '</span>';
  }
  if (st === "out") { return '<span class="stock out">Out of stock</span>'; }
  if (st === "order") { return '<span class="stock order">Special order</span>'; }
  return '<span class="stock unk">Check availability</span>';
}

function renderProductGrid(isOwner) {
  var grid = $("prodGrid");
  if (!grid) { return; }
  grid.innerHTML = "";
  var items = filteredProducts();
  if (!items.length) {
    grid.appendChild(emptyBox("No products", isOwner ? "Add your first product to start building this catalog." : "No products match your filter."));
    return;
  }
  for (var i = 0; i < items.length; i++) {
    (function (p) {
      var card = el("div", "prod-card");
      var img = p.imageUrl ? '<div class="prod-img"><img src="' + esc(p.imageUrl) + '" alt=""></div>'
        : '<div class="prod-img noimg"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg></div>';
      card.innerHTML = img +
        '<div class="prod-body">' +
        '<div class="prod-cat">' + esc(CATEGORY_LABELS[p.category] || p.category || "") + '</div>' +
        '<div class="prod-name">' + esc(p.name) + '</div>' +
        (p.sku ? '<div class="prod-sku">' + esc(p.sku) + (p.brand ? " \u00b7 " + esc(p.brand) : "") + '</div>' : "") +
        '<div class="prod-foot"><span class="prod-price">' + money(p.unitPrice) + ' <small>/ ' + esc(p.uom || "ea") + '</small></span>' + stockBadge(p) + '</div>' +
        '</div>';
      var actions = el("div", "prod-actions");
      if (isOwner) {
        var edit = el("button", "btn btn-ghost btn-sm", "Edit");
        edit.onclick = function () { openProductModal(p); };
        var del = el("button", "btn btn-danger btn-sm", "Remove");
        del.onclick = function () { removeProduct(p); };
        actions.appendChild(edit); actions.appendChild(del);
      } else {
        var addBtn = el("button", "btn btn-primary btn-sm btn-block", "Add to cart");
        addBtn.onclick = function () { addToCart(CATALOG.distId, p); };
        actions.appendChild(addBtn);
      }
      card.appendChild(actions);
      grid.appendChild(card);
    })(items[i]);
  }
}

/* ---------- distributor catalog management ---------- */
function renderDistributorCatalog() {
  var main = $("mainArea");
  main.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  loadCatalog(STATE.distributorId).then(function () {
    main.innerHTML = "";
    var head = el("div", "page-head");
    head.innerHTML = '<div><h1>My Catalog</h1><p class="ph-sub">' + esc(distName(STATE.distributorId)) +
      ' \u00b7 ' + CATALOG.products.length + ' products. Add, edit, or remove items. Tie in a live-availability API from your distributor settings.</p></div>';
    main.appendChild(head);
    main.appendChild(buildCatalogToolbar(true));
    var grid = el("div", "prod-grid"); grid.id = "prodGrid";
    main.appendChild(grid);
    renderProductGrid(true);
  });
}

function openProductModal(p) {
  var isEdit = !!p;
  var wrap = el("div");
  wrap.appendChild(modalHead(isEdit ? "Edit product" : "Add product", ""));
  var body = el("div", "modal-body");
  var cats = "";
  for (var key in CATEGORY_LABELS) {
    if (CATEGORY_LABELS.hasOwnProperty(key)) {
      cats += '<option value="' + key + '"' + (p && p.category === key ? " selected" : "") + '>' + esc(CATEGORY_LABELS[key]) + '</option>';
    }
  }
  body.innerHTML =
    '<div class="field"><label>Product name *</label><input type="text" id="pr-name" value="' + esc(p ? p.name : "") + '"></div>' +
    '<div class="field-row">' +
      '<div class="field"><label>SKU / part #</label><input type="text" id="pr-sku" value="' + esc(p ? p.sku : "") + '"></div>' +
      '<div class="field"><label>Brand</label><input type="text" id="pr-brand" value="' + esc(p ? p.brand : "") + '"></div>' +
    '</div>' +
    '<div class="field-row">' +
      '<div class="field"><label>Category</label><select id="pr-cat">' + cats + '</select></div>' +
      '<div class="field"><label>Unit of measure</label><input type="text" id="pr-uom" value="' + esc(p ? (p.uom || "ea") : "ea") + '"></div>' +
    '</div>' +
    '<div class="field-row">' +
      '<div class="field"><label>Unit price ($)</label><input type="number" id="pr-price" min="0" step="0.01" value="' + esc(p ? p.unitPrice : "") + '"></div>' +
      '<div class="field"><label>Stock status</label><select id="pr-stock">' +
        '<option value="in"' + (p && p.stockStatus === "in" ? " selected" : "") + '>In stock</option>' +
        '<option value="order"' + (p && p.stockStatus === "order" ? " selected" : "") + '>Special order</option>' +
        '<option value="out"' + (p && p.stockStatus === "out" ? " selected" : "") + '>Out of stock</option>' +
        '<option value="unknown"' + (p && p.stockStatus === "unknown" ? " selected" : "") + '>Check availability</option>' +
      '</select></div>' +
    '</div>' +
    '<div class="field-row">' +
      '<div class="field"><label>Stock qty (optional)</label><input type="number" id="pr-qty" min="0" value="' + esc(p && p.stockQty != null ? p.stockQty : "") + '"></div>' +
      '<div class="field"><label>Lead time (days)</label><input type="number" id="pr-lead" min="0" value="' + esc(p && p.leadTimeDays != null ? p.leadTimeDays : "") + '"></div>' +
    '</div>' +
    '<div class="field"><label>Image URL (optional)</label><input type="url" id="pr-img" value="' + esc(p ? p.imageUrl : "") + '"></div>' +
    '<div class="field"><label>Description</label><textarea id="pr-desc">' + esc(p ? p.description : "") + '</textarea></div>';
  wrap.appendChild(body);

  var foot = el("div", "modal-foot");
  var cancel = el("button", "btn btn-ghost", "Cancel"); cancel.onclick = function () { renderDistributorCatalog(); };
  var save = el("button", "btn btn-primary", isEdit ? "Save changes" : "Add product"); save.id = "saveProdBtn";
  save.onclick = function () { doSaveProduct(p); };
  foot.appendChild(cancel); foot.appendChild(save);
  wrap.appendChild(foot);
  openModal(wrap, true);
}

function doSaveProduct(existing) {
  var name = $("pr-name").value.trim();
  if (!name) { toast("Product name is required.", true); return; }
  var btn = $("saveProdBtn"); btn.disabled = true; btn.textContent = "Saving\u2026";
  var data = {
    name: name,
    sku: $("pr-sku").value.trim(),
    brand: $("pr-brand").value.trim(),
    category: $("pr-cat").value,
    uom: $("pr-uom").value.trim() || "ea",
    unitPrice: $("pr-price").value === "" ? null : Number($("pr-price").value),
    stockStatus: $("pr-stock").value,
    stockQty: $("pr-qty").value === "" ? null : Number($("pr-qty").value),
    leadTimeDays: $("pr-lead").value === "" ? null : Number($("pr-lead").value),
    imageUrl: $("pr-img").value.trim(),
    description: $("pr-desc").value.trim(),
    active: true,
    updatedAt: FieldValue.serverTimestamp()
  };
  var col = db.collection(COL_DISTRIBUTORS).doc(STATE.distributorId).collection("catalog");
  var op;
  if (existing) { op = col.doc(existing._id).update(data); }
  else { data.createdAt = FieldValue.serverTimestamp(); op = col.add(data); }
  op.then(function () {
    toast(existing ? "Product updated." : "Product added.");
    renderDistributorCatalog();
  })["catch"](function (err) {
    btn.disabled = false; btn.textContent = existing ? "Save changes" : "Add product";
    toast(friendlyErr(err), true);
  });
}

function removeProduct(p) {
  if (!window.confirm("Remove \"" + (p.name || "this product") + "\" from your catalog?")) { return; }
  db.collection(COL_DISTRIBUTORS).doc(STATE.distributorId).collection("catalog").doc(p._id)["delete"]()
    .then(function () { toast("Product removed."); renderDistributorCatalog(); })
    ["catch"](function (err) { toast(friendlyErr(err), true); });
}

/* ============================================================
   CART (developer)
   ============================================================ */
function addToCart(distId, product) {
  /* cart is single-distributor; warn if switching */
  if (STATE.cart.length && STATE.cart[0].distId !== distId) {
    if (!window.confirm("Your cart has items from " + distName(STATE.cart[0].distId) +
      ". Start a new cart for " + distName(distId) + "?")) { return; }
    STATE.cart = [];
  }
  var found = false;
  for (var i = 0; i < STATE.cart.length; i++) {
    if (STATE.cart[i].product._id === product._id) { STATE.cart[i].qty += 1; found = true; break; }
  }
  if (!found) { STATE.cart.push({ distId: distId, product: product, qty: 1 }); }
  updateCartBadge();
  toast("Added to cart.");
}

function updateCartBadge() {
  var badge = $("cartBadge");
  if (!badge) { return; }
  var n = 0;
  for (var i = 0; i < STATE.cart.length; i++) { n += STATE.cart[i].qty; }
  badge.textContent = n;
  badge.style.display = n > 0 ? "flex" : "none";
}

function openCartModal() {
  var wrap = el("div");
  wrap.appendChild(modalHead("Your cart", STATE.cart.length ? distName(STATE.cart[0].distId) : ""));
  var body = el("div", "modal-body");

  if (!STATE.cart.length) {
    body.appendChild(emptyBox("Cart is empty", "Browse a distributor's catalog and add products to build a request."));
    wrap.appendChild(body);
    var f0 = el("div", "modal-foot");
    var c0 = el("button", "btn btn-ghost", "Close"); c0.onclick = closeModal;
    f0.appendChild(c0); wrap.appendChild(f0);
    openModal(wrap, false);
    return;
  }

  var total = 0;
  var t = el("table", "li-table");
  var rows = "";
  for (var i = 0; i < STATE.cart.length; i++) {
    var it = STATE.cart[i];
    var line = Number(it.product.unitPrice || 0) * it.qty;
    total += line;
    rows += '<tr><td><div class="li-name">' + esc(it.product.name) + '</div>' +
      (it.product.sku ? '<div class="li-sku">' + esc(it.product.sku) + '</div>' : "") + '</td>' +
      '<td><div class="qty-ctl"><button class="qty-btn" data-act="dec" data-idx="' + i + '">\u2212</button>' +
        '<span>' + it.qty + '</span>' +
        '<button class="qty-btn" data-act="inc" data-idx="' + i + '">+</button></div></td>' +
      '<td class="num">' + money(it.product.unitPrice) + '</td>' +
      '<td class="num">' + money(line) + '</td>' +
      '<td><button class="fc-x" data-act="rm" data-idx="' + i + '">&times;</button></td></tr>';
  }
  rows += '<tr class="li-total"><td colspan="3">Estimated total</td><td class="num">' + money(total) + '</td><td></td></tr>';
  t.innerHTML = '<thead><tr><th>Item</th><th>Qty</th><th class="num">Unit</th><th class="num">Line</th><th></th></tr></thead><tbody>' + rows + '</tbody>';
  body.appendChild(t);
  body.appendChild(el("div", "cart-hint", "Prices are the distributor's list estimate. Submit as a project to get a firm quote and invoice, or use these to shop directly."));
  wrap.appendChild(body);

  setTimeout(function () {
    var btns = body.querySelectorAll("[data-act]");
    for (var b = 0; b < btns.length; b++) {
      btns[b].onclick = function () {
        var act = this.getAttribute("data-act"); var idx = Number(this.getAttribute("data-idx"));
        if (act === "inc") { STATE.cart[idx].qty += 1; }
        else if (act === "dec") { STATE.cart[idx].qty = Math.max(1, STATE.cart[idx].qty - 1); }
        else if (act === "rm") { STATE.cart.splice(idx, 1); }
        updateCartBadge();
        openCartModal();
      };
    }
  }, 0);

  var foot = el("div", "modal-foot");
  var clear = el("button", "btn btn-ghost", "Clear cart");
  clear.onclick = function () { if (window.confirm("Clear the cart?")) { STATE.cart = []; updateCartBadge(); closeModal(); } };
  var submit = el("button", "btn btn-primary", "Submit as project");
  submit.onclick = function () { closeModal(); openIntakeModal(STATE.cart.slice()); };
  foot.appendChild(clear); foot.appendChild(submit);
  wrap.appendChild(foot);
  openModal(wrap, true);
}

function emptyBox(title, sub) {
  var e = el("div", "empty");
  e.innerHTML = '<div class="e-ic"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg></div>' +
    '<h3>' + esc(title) + '</h3><p>' + esc(sub) + '</p>';
  return e;
}

/* ============================================================
   ADMIN VIEW — onboard distributors, allowlist distributor users
   ============================================================ */
function renderAdminView() {
  var main = $("mainArea");
  main.innerHTML = '<div class="loading"><div class="spinner"></div></div>';

  db.collection(COL_DISTRIBUTORS).get().then(function (snap) {
    var dists = [];
    snap.forEach(function (d) { var x = d.data(); x._id = d.id; dists.push(x); });
    dists.sort(function (a, b) { return (a.name || "").localeCompare(b.name || ""); });

    main.innerHTML = "";
    var head = el("div", "page-head");
    head.innerHTML = '<div><h1>Admin</h1><p class="ph-sub">Onboard distribution partners and manage who can register as a distributor.</p></div>';
    var addBtn = el("button", "btn btn-primary", "+ Onboard distributor");
    addBtn.onclick = function () { openDistributorModal(null); };
    head.appendChild(addBtn);
    main.appendChild(head);

    var sec = el("div", "detail-sec");
    sec.innerHTML = '<h4>Distributors (' + dists.length + ')</h4>';
    if (!dists.length) {
      sec.appendChild(el("div", "doc-missing", "No distributors onboarded yet."));
    } else {
      var t = el("table", "admin-table");
      var rows = "";
      for (var i = 0; i < dists.length; i++) {
        var d = dists[i];
        rows += '<tr><td><b>' + esc(d.name) + '</b><div class="li-sku">' + esc(d._id) + '</div></td>' +
          '<td>' + esc(d.location || "\u2014") + '</td>' +
          '<td>' + (d.active ? '<span class="stock in">Active</span>' : '<span class="stock out">Inactive</span>') + '</td>' +
          '<td>' + (d.apiEnabled ? "API on" : "\u2014") + '</td>' +
          '<td class="num"><button class="btn btn-ghost btn-sm" data-edit="' + esc(d._id) + '">Edit</button></td></tr>';
      }
      t.innerHTML = '<thead><tr><th>Name</th><th>Location</th><th>Status</th><th>API</th><th></th></tr></thead><tbody>' + rows + '</tbody>';
      sec.appendChild(t);
      setTimeout(function () {
        var btns = sec.querySelectorAll("[data-edit]");
        for (var b = 0; b < btns.length; b++) {
          btns[b].onclick = function () {
            var id = this.getAttribute("data-edit");
            for (var k = 0; k < dists.length; k++) { if (dists[k]._id === id) { openDistributorModal(dists[k]); break; } }
          };
        }
      }, 0);
    }
    main.appendChild(sec);

    /* allowlist helper */
    var alSec = el("div", "detail-sec");
    alSec.innerHTML = '<h4>Distributor sign-up allowlist</h4>' +
      '<p class="doc-missing">Add a distributor user\'s email so they can self-register as a distributor and be bound to a distributor record.</p>';
    var alForm = el("div");
    alForm.innerHTML =
      '<div class="field-row">' +
        '<div class="field"><label>Email</label><input type="email" id="al-email" placeholder="rep@distributor.com"></div>' +
        '<div class="field"><label>Bind to distributor ID</label><input type="text" id="al-dist" placeholder="e.g. rexel-energy"></div>' +
      '</div>';
    alSec.appendChild(alForm);
    var alBtn = el("button", "btn btn-primary btn-sm", "Add to allowlist");
    alBtn.onclick = function () {
      var email = $("al-email").value.trim().toLowerCase();
      var distId = $("al-dist").value.trim();
      if (!email || !distId) { toast("Email and distributor ID required.", true); return; }
      alBtn.disabled = true;
      db.collection(COL_ALLOWLIST).doc(email).set({
        active: true, role: "distributor", distributorId: distId,
        addedBy: STATE.profile.email, addedAt: FieldValue.serverTimestamp()
      }, { merge: true }).then(function () {
        toast("Added " + email + " as a distributor.");
        $("al-email").value = ""; $("al-dist").value = ""; alBtn.disabled = false;
      })["catch"](function (err) { alBtn.disabled = false; toast(friendlyErr(err), true); });
    };
    alSec.appendChild(alBtn);
    main.appendChild(alSec);
  })["catch"](function (err) {
    main.innerHTML = '<div class="empty"><h3>Could not load admin data</h3><p>' + esc(friendlyErr(err)) + '</p></div>';
  });
}

function openDistributorModal(d) {
  var isEdit = !!d;
  var wrap = el("div");
  wrap.appendChild(modalHead(isEdit ? "Edit distributor" : "Onboard distributor", ""));
  var body = el("div", "modal-body");
  body.innerHTML =
    '<div class="field"><label>Distributor name *</label><input type="text" id="d-name" value="' + esc(d ? d.name : "") + '" placeholder="e.g. Rexel Energy Solutions"></div>' +
    (isEdit ? "" : '<div class="field"><label>Distributor ID (slug) *</label><input type="text" id="d-id" placeholder="rexel-energy"><p class="doc-missing" style="margin-top:4px">Lowercase, no spaces. Bind distributor users to this ID.</p></div>') +
    '<div class="field-row">' +
      '<div class="field"><label>Location</label><input type="text" id="d-loc" value="' + esc(d ? d.location : "") + '" placeholder="Charlotte, NC"></div>' +
      '<div class="field"><label>Contact email</label><input type="email" id="d-contact" value="' + esc(d ? d.contact : "") + '"></div>' +
    '</div>' +
    '<div class="field"><label>Logo URL (optional)</label><input type="url" id="d-logo" value="' + esc(d ? d.logo : "") + '"></div>' +
    '<div class="field-row">' +
      '<div class="field"><label>Active</label><select id="d-active"><option value="yes"' + (!d || d.active ? " selected" : "") + '>Yes</option><option value="no"' + (d && !d.active ? " selected" : "") + '>No</option></select></div>' +
      '<div class="field"><label>Live-availability API</label><select id="d-api"><option value="no"' + (!d || !d.apiEnabled ? " selected" : "") + '>Off</option><option value="yes"' + (d && d.apiEnabled ? " selected" : "") + '>On</option></select></div>' +
    '</div>' +
    '<div class="field"><label>API endpoint (optional, for availability sync)</label><input type="url" id="d-apiurl" value="' + esc(d && d.apiUrl ? d.apiUrl : "") + '" placeholder="https://\u2026 (wired via serverless proxy later)"></div>';
  wrap.appendChild(body);

  var foot = el("div", "modal-foot");
  var cancel = el("button", "btn btn-ghost", "Cancel"); cancel.onclick = function () { renderAdminView(); };
  var save = el("button", "btn btn-primary", isEdit ? "Save" : "Onboard"); save.id = "saveDistBtn";
  save.onclick = function () { doSaveDistributor(d); };
  foot.appendChild(cancel); foot.appendChild(save);
  wrap.appendChild(foot);
  openModal(wrap, true);
}

function doSaveDistributor(existing) {
  var name = $("d-name").value.trim();
  if (!name) { toast("Name is required.", true); return; }
  var data = {
    name: name,
    location: $("d-loc").value.trim(),
    contact: $("d-contact").value.trim(),
    logo: $("d-logo").value.trim(),
    active: $("d-active").value === "yes",
    apiEnabled: $("d-api").value === "yes",
    apiUrl: $("d-apiurl").value.trim(),
    updatedAt: FieldValue.serverTimestamp()
  };
  var btn = $("saveDistBtn"); btn.disabled = true; btn.textContent = "Saving\u2026";
  var op;
  if (existing) {
    op = db.collection(COL_DISTRIBUTORS).doc(existing._id).update(data);
  } else {
    var id = $("d-id").value.trim();
    if (!id) { toast("Distributor ID is required.", true); btn.disabled = false; btn.textContent = "Onboard"; return; }
    id = slugify(id);
    data.createdAt = FieldValue.serverTimestamp();
    data.ownerUids = [];
    op = db.collection(COL_DISTRIBUTORS).doc(id).set(data);
  }
  op.then(function () {
    toast(existing ? "Distributor saved." : "Distributor onboarded.");
    return loadDistributors();
  }).then(function () { renderAdminView(); })
  ["catch"](function (err) {
    btn.disabled = false; btn.textContent = existing ? "Save" : "Onboard";
    toast(friendlyErr(err), true);
  });
}

/* ============================================================
   BOOT
   ============================================================ */
function boot() {
  if (typeof firebase === "undefined" || !firebase.apps.length) {
    var av = document.getElementById("authView");
    if (av) {
      av.innerHTML = '<div style="max-width:440px;margin:80px auto;text-align:center;font-family:Inter,sans-serif;">' +
        '<h2 style="font-family:Syne,sans-serif;">Firebase not configured</h2>' +
        '<p style="color:#5A6B7B;line-height:1.6;">Add your project credentials to <code>firebase-config.js</code>, then reload.</p></div>';
    }
    return;
  }
  db = firebase.firestore();
  auth = firebase.auth();
  storage = firebase.storage();
  FieldValue = firebase.firestore.FieldValue;

  wireAuthUI();
  $("modalBackdrop").onclick = function (e) { if (e.target === $("modalBackdrop")) { closeModal(); } };
  auth.onAuthStateChanged(onAuth);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
