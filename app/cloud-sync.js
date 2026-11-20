/* Kitchen Ledger: online copy (Supabase).
 *
 * Built into the end of the app's main script (see scripts/build.js), so it
 * can use the app's own state, persist(), renderAll() and helpers.
 * It keeps items, suppliers, recipes and saved orders in step with an online
 * table, so iPads and iPhones (which can't reach the network-drive files) see
 * the same data. The desktop app's Excel files are not touched by this file.
 *
 * How it decides what to do, per record:
 *   changed only online          -> taken in
 *   changed only here            -> sent up
 *   changed in both              -> this device's version is kept and sent up
 *   deleted on either side       -> deleted everywhere (a deleted row stays online)
 * "Changed" means its fingerprint differs from the last one both sides agreed
 * on (state.meta.cloud.base). That base lives inside the app's own state, so a
 * "Restore everything" brings back a base that matches the restored data and
 * never turns the restore into deletions.
 *
 * Every record has a cloudId. The first time a device meets the online copy,
 * records without one take the id of the online record with the same name.
 */
(function () {
  "use strict";

  var cfg = (window.klBrand && window.klBrand.cloud) || (window.LEDGER_CLIENT && window.LEDGER_CLIENT.cloud) || null;
  if (!cfg || !cfg.url || !cfg.key || typeof state === "undefined" || typeof persist !== "function") return;

  var URL_BASE = String(cfg.url).replace(/\/+$/, "");
  var KEY = String(cfg.key);
  var TABLE = URL_BASE + "/rest/v1/ledger_records";
  var SESSION_KEY = "kl-cloud-session:" + URL_BASE;
  var EVERY_MS = 30000;
  var KINDS = ["item", "supplier", "recipe", "order"];

  // ---------- small helpers ----------
  function stable(v) { // JSON with sorted keys, so the same record always gives the same text
    if (v === undefined) return undefined;
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(function (x) { var s = stable(x); return s === undefined ? "null" : s; }).join(",") + "]";
    return "{" + Object.keys(v).sort().filter(function (k) { return v[k] !== undefined; })
      .map(function (k) { return JSON.stringify(k) + ":" + stable(v[k]); }).join(",") + "}";
  }
  function fpOf(data) { return sharedFingerprint(stable(data)); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function newId(kind) { return kind + "_" + (window.crypto && crypto.randomUUID ? crypto.randomUUID() : uid("c")); }
  function computer() { try { return String((state.meta && state.meta.computerName) || "") || "This device"; } catch (e) { return "This device"; } }
  function cloudMeta() {
    state.meta = state.meta || {};
    var m = state.meta.cloud = state.meta.cloud || {};
    m.base = m.base || {};      // "kind:id" -> { fp, nk }  (nk = name key, for first meetings)
    m.lastRev = m.lastRev || 0; // highest server rev taken in
    return m;
  }

  // ---------- records in this device's state ----------
  function itemData(it) { var d = clone(it); delete d.id; delete d.cloudId; delete d.ledgerPrevName; return d; }
  function supplierData(s) { var d = clone(s); delete d.id; delete d.cloudId; return d; }
  function recipeData(r) { var d = recipeToShared(r); delete d.sid; d.sharedId = r.sharedId || null; return JSON.parse(JSON.stringify(d)); }
  function orderData(o) { return orderToShared(o).order; }

  var LIST = {
    item: function () { return state.items; },
    supplier: function () { return state.suppliers; },
    recipe: function () { return state.recipes; },
    order: function () { return state.orders; }
  };
  var DATA = { item: itemData, supplier: supplierData, recipe: recipeData, order: orderData };
  var NAMEKEY = {
    item: function (d) { return keyOf(d.supplier, d.name); },
    supplier: function (d) { return String(d.name || "").trim().toLowerCase(); },
    recipe: function (d) { return (d.type === "menuitem" ? "b:" : "m:") + recipeKeyOf(d.name); },
    order: function () { return null; } // orders already share one id everywhere
  };
  function idOf(kind, obj) { return kind === "order" ? obj.id : obj.cloudId; }

  function snapshot() { // "kind:id" -> { obj, data, fp, nk }
    var out = {};
    KINDS.forEach(function (kind) {
      (LIST[kind]() || []).forEach(function (obj) {
        var id = idOf(kind, obj); if (!id) return;
        var data = DATA[kind](obj);
        out[kind + ":" + id] = { kind: kind, id: id, obj: obj, data: data, fp: fpOf(data), nk: NAMEKEY[kind](data) };
      });
    });
    return out;
  }

  // Records made before this device met the online copy get a cloudId: the
  // id of an online record with the same name that no record here uses yet,
  // or a new one.
  function giveIds(remoteByNk) {
    var m = cloudMeta(), used = {};
    ["item", "supplier", "recipe"].forEach(function (kind) {
      LIST[kind]().forEach(function (o) { if (o.cloudId) used[kind + ":" + o.cloudId] = true; });
    });
    var known = {}; // nk -> [ids] from the base and the rows just fetched
    Object.keys(m.base).forEach(function (k) { var b = m.base[k]; if (b.nk) (known[k.split(":")[0] + "|" + b.nk] = known[k.split(":")[0] + "|" + b.nk] || []).push(k.slice(k.indexOf(":") + 1)); });
    Object.keys(remoteByNk).forEach(function (k) { (known[k] = known[k] || []).push.apply(known[k], remoteByNk[k]); });
    var changed = false;
    ["item", "supplier", "recipe"].forEach(function (kind) {
      LIST[kind]().forEach(function (o) {
        if (o.cloudId) return;
        var nk = NAMEKEY[kind](DATA[kind](o));
        var free = (known[kind + "|" + nk] || []).filter(function (id) { return !used[kind + ":" + id]; });
        o.cloudId = free[0] || newId(kind);
        used[kind + ":" + o.cloudId] = true; changed = true;
      });
    });
    return changed;
  }

  // ---------- applying an online record here ----------
  function applyRemote(row, local) {
    var kind = row.kind, list = LIST[kind]();
    if (row.deleted) {
      if (!local) return;
      var o = local.obj, i = list.indexOf(o);
      if (i >= 0) list.splice(i, 1);
      if (kind === "item") tombstoneAdd("items", keyOf(o.supplier, o.name));
      if (kind === "supplier") tombstoneAdd("suppliers", supplierKeyOf(o.name));
      if (kind === "recipe") tombstoneAdd("recipes", recipeKeyOf(o.name));
      return;
    }
    var d = row.data;
    if (kind === "item" || kind === "supplier") {
      var obj = Object.assign({ id: local ? local.obj.id : uid(kind) }, clone(d), { cloudId: row.key });
      if (local) { if (local.obj.ledgerPrevName) obj.ledgerPrevName = local.obj.ledgerPrevName; list[list.indexOf(local.obj)] = obj; }
      else list.push(obj);
    } else if (kind === "recipe") {
      var rec = clone(d); rec.sid = d.sharedId || (local && local.obj.sharedId) || undefined; delete rec.sharedId;
      var r = applySharedRecipe(rec, local ? local.obj : null);
      r.cloudId = row.key;
    } else if (kind === "order") {
      var ord = clone(d);
      if (local) list[list.indexOf(local.obj)] = Object.assign(local.obj.mofWritten ? { mofWritten: local.obj.mofWritten } : {}, ord);
      else list.push(ord);
    }
  }

  // ---------- talking to Supabase ----------
  var session = null;
  try { session = JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch (e) { session = null; }
  function saveSession(s) { session = s; try { if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s)); else localStorage.removeItem(SESSION_KEY); } catch (e) {} }

  function authCall(grant, body) {
    return fetch(URL_BASE + "/auth/v1/token?grant_type=" + grant, {
      method: "POST", headers: { apikey: KEY, "Content-Type": "application/json" }, body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok || !j.access_token) { var e = new Error(j.error_description || j.msg || j.error || ("HTTP " + r.status)); e.status = r.status; throw e; }
        saveSession({ access: j.access_token, refresh: j.refresh_token, expires: Date.now() + (j.expires_in || 3600) * 1000, email: (j.user && j.user.email) || (session && session.email) || "" });
        return session;
      });
    });
  }
  function token() {
    if (!session) return Promise.reject(Object.assign(new Error("Not signed in"), { status: 401 }));
    if (Date.now() < session.expires - 60000) return Promise.resolve(session.access);
    return authCall("refresh_token", { refresh_token: session.refresh }).then(function (s) { return s.access; })
      .catch(function (e) { if (e.status === 400 || e.status === 401) saveSession(null); throw e; });
  }
  function api(path, opts) {
    return token().then(function (t) {
      var h = Object.assign({ apikey: KEY, Authorization: "Bearer " + t, "Content-Type": "application/json" }, (opts && opts.headers) || {});
      return fetch(TABLE + path, Object.assign({}, opts, { headers: h }));
    }).then(function (r) {
      if (r.status === 401) saveSession(null);
      if (!r.ok) return r.text().then(function (t) { var e = new Error("HTTP " + r.status + " " + t.slice(0, 200)); e.status = r.status; throw e; });
      return r.status === 204 ? null : r.json();
    });
  }
  function pullSince(rev) {
    var rows = [];
    function page(after) {
      return api("?select=kind,key,data,fp,deleted,rev,updated_by&rev=gt." + after + "&order=rev.asc&limit=1000").then(function (got) {
        rows = rows.concat(got);
        return got.length === 1000 ? page(got[got.length - 1].rev) : rows;
      });
    }
    return page(rev);
  }
  function push(rows) {
    if (!rows.length) return Promise.resolve();
    var chunks = []; for (var i = 0; i < rows.length; i += 500) chunks.push(rows.slice(i, i + 500));
    return chunks.reduce(function (p, c) {
      return p.then(function () {
        return api("?on_conflict=owner,kind,key", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(c) });
      });
    }, Promise.resolve());
  }

  // ---------- one sync ----------
  var running = null, again = false, status = { state: "idle", at: null, error: "" };

  function syncOnce() {
    if (running) { again = true; return running; }
    if (!session) { setStatus("signed-out"); return Promise.resolve(); }
    if (typeof navigator !== "undefined" && navigator.onLine === false) { setStatus("offline"); return Promise.resolve(); }
    setStatus("syncing");
    var m = cloudMeta();
    running = pullSince(m.lastRev).then(function (rows) {
      // first meetings: give local records the ids of same-named online ones
      var remoteByNk = {};
      rows.forEach(function (r) {
        if (r.deleted || !r.data || r.kind === "order" || !NAMEKEY[r.kind]) return;
        var k = r.kind + "|" + NAMEKEY[r.kind](r.data); (remoteByNk[k] = remoteByNk[k] || []).push(r.key);
      });
      var idsGiven = giveIds(remoteByNk);
      var local = snapshot(), base = m.base, applied = 0, conflicts = 0, maxRev = m.lastRev;
      var latest = {}; rows.forEach(function (r) { latest[r.kind + ":" + r.key] = r; if (r.rev > maxRev) maxRev = r.rev; });

      // 1. online changes
      Object.keys(latest).forEach(function (k) {
        var r = latest[k]; if (KINDS.indexOf(r.kind) < 0) return;
        var b = base[k], l = local[k];
        if (r.fp === (b && b.fp) && !(r.deleted && l)) return; // nothing new online
        var localChanged = l ? (!b || l.fp !== b.fp) : false;
        if (l && r.deleted === false && l.fp === r.fp) { base[k] = { fp: r.fp, nk: l.nk }; return; } // already the same
        if (localChanged && b) { conflicts++; return; }                // changed in both: keep this device's
        if (localChanged && !b && !r.deleted) { conflicts++; return; } // both made it: this device's copy wins
        applyRemote(r, l); applied++;
        if (r.deleted) base[k] = { fp: r.fp, nk: null, deleted: true };
      });

      // 2. this device's changes and deletions
      var now = snapshot(), out = [];
      Object.keys(now).forEach(function (k) {
        var n = now[k], b = base[k];
        if (b && !b.deleted && b.fp === n.fp) return;
        if (latest[k] && !latest[k].deleted && latest[k].fp === n.fp) { base[k] = { fp: n.fp, nk: n.nk }; return; }
        out.push({ kind: n.kind, key: n.id, data: n.data, fp: n.fp, deleted: false, updated_by: computer() });
        base[k] = { fp: n.fp, nk: n.nk };
      });
      Object.keys(base).forEach(function (k) {
        var b = base[k]; if (b.deleted || now[k]) return;
        var kind = k.slice(0, k.indexOf(":")), id = k.slice(k.indexOf(":") + 1);
        out.push({ kind: kind, key: id, data: null, fp: "deleted", deleted: true, updated_by: computer() });
        base[k] = { fp: "deleted", nk: null, deleted: true };
      });

      return push(out).then(function () {
        m.lastRev = maxRev;
        if (applied || idsGiven || out.length || rows.length) {
          quietPersist();
          if (applied) { try { renderAll(); } catch (e) {} }
        }
        setStatus("synced", "", { applied: applied, sent: out.length, conflicts: conflicts });
      });
    }).catch(function (e) {
      setStatus(session ? "error" : "signed-out", e && e.message ? e.message : String(e));
    }).then(function () {
      running = null;
      if (again) { again = false; setTimeout(syncOnce, 0); }
    });
    return running;
  }

  // persist() saves locally and starts the Excel sync as usual; this only
  // saves, without scheduling another online sync for our own change.
  var quiet = false;
  function quietPersist() { quiet = true; try { persist(); } finally { quiet = false; } }

  var origPersist = persist;
  var soon = null;
  persist = function () {
    var r = origPersist.apply(this, arguments);
    if (!quiet && session) { clearTimeout(soon); soon = setTimeout(syncOnce, 3000); }
    return r;
  };

  // ---------- status chip and sign-in ----------
  var chip = null;
  function setStatus(s, err, info) {
    status.state = s; status.error = err || "";
    if (s === "synced") status.at = new Date();
    if (info && info.applied && typeof toast === "function") toast("A140", "Online copy: took in " + info.applied + " change" + (info.applied === 1 ? "" : "s") + " from other devices");
    draw();
  }
  function draw() {
    if (!chip) return;
    var t, colour = "#666";
    if (!session) { t = "Online copy: sign in"; colour = "#b45309"; }
    else if (status.state === "syncing") t = "Online copy: syncing…";
    else if (status.state === "offline") t = "Online copy: offline, will sync";
    else if (status.state === "error") { t = "Online copy: couldn't sync, will retry"; colour = "#b91c1c"; }
    else if (status.at) { t = "Online copy: synced " + status.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); colour = "#166e30"; }
    else t = "Online copy";
    chip.textContent = "☁ " + t;
    chip.style.color = colour;
    chip.title = status.error ? status.error : (session ? "Signed in as " + session.email : "");
  }
  function addChip() {
    var pill = document.getElementById("status-pill");
    chip = document.createElement("button");
    chip.type = "button"; chip.id = "cloud-chip";
    chip.style.cssText = "border:1px solid #ddd;background:#fff;border-radius:999px;padding:4px 10px;font:inherit;font-size:12px;cursor:pointer;margin-left:8px;white-space:nowrap";
    chip.addEventListener("click", openPanel);
    if (pill && pill.parentNode) pill.parentNode.insertBefore(chip, pill.nextSibling);
    else { chip.style.position = "fixed"; chip.style.right = "12px"; chip.style.bottom = "12px"; chip.style.zIndex = 9999; document.body.appendChild(chip); }
    draw();
  }
  function openPanel() {
    var old = document.getElementById("cloud-panel"); if (old) old.remove();
    var wrap = document.createElement("div"); wrap.id = "cloud-panel";
    wrap.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px";
    var box = document.createElement("div");
    box.style.cssText = "background:#fff;color:#222;border-radius:12px;max-width:380px;width:100%;padding:20px;font:14px/1.45 -apple-system,'Segoe UI',sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.25)";
    function close() { wrap.remove(); }
    wrap.addEventListener("click", function (e) { if (e.target === wrap) close(); });
    document.addEventListener("keydown", function esc(e) { if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc); } });
    if (session) {
      box.innerHTML = '<h3 style="margin:0 0 8px;font-size:16px">Online copy</h3>' +
        '<p style="margin:0 0 6px">Signed in as <b></b>.</p>' +
        '<p style="margin:0 0 14px;color:#555">This device syncs every 30 seconds while it\'s online. Changes made offline go up when it\'s back.</p>' +
        '<p class="err" style="color:#b91c1c;margin:0 0 10px"></p>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end"><button data-a="out">Sign out</button><button data-a="now" style="background:#166e30;color:#fff;border:0">Sync now</button></div>';
      box.querySelector("b").textContent = session.email || "";
      box.querySelector(".err").textContent = status.error || "";
      box.querySelector('[data-a="now"]').onclick = function () { close(); syncOnce(); };
      box.querySelector('[data-a="out"]').onclick = function () { saveSession(null); close(); setStatus("signed-out"); };
    } else {
      box.innerHTML = '<h3 style="margin:0 0 8px;font-size:16px">Sign in to the online copy</h3>' +
        '<p style="margin:0 0 12px;color:#555">Use your business\'s ledger sign-in. Every device signed in with it shares the same items, suppliers, recipes and orders.</p>' +
        '<form><label style="display:block;margin-bottom:8px">Email<br><input name="e" type="email" autocomplete="username" required style="width:100%;box-sizing:border-box;padding:8px;border:1px solid #ccc;border-radius:8px"></label>' +
        '<label style="display:block;margin-bottom:12px">Password<br><input name="p" type="password" autocomplete="current-password" required style="width:100%;box-sizing:border-box;padding:8px;border:1px solid #ccc;border-radius:8px"></label>' +
        '<p class="err" style="color:#b91c1c;margin:0 0 10px"></p>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" data-a="cancel">Not now</button><button type="submit" style="background:#166e30;color:#fff;border:0">Sign in</button></div></form>';
      var form = box.querySelector("form");
      box.querySelector('[data-a="cancel"]').onclick = close;
      form.onsubmit = function (e) {
        e.preventDefault();
        var err = box.querySelector(".err"); err.textContent = "Signing in…"; err.style.color = "#555";
        authCall("password", { email: form.e.value.trim(), password: form.p.value }).then(function (sess) {
          // a different sign-in is a different business: start its sync afresh
          var m = cloudMeta();
          if (m.account !== sess.email) { m.base = {}; m.lastRev = 0; m.account = sess.email; quietPersist(); }
          close(); setStatus("idle"); syncOnce();
        }).catch(function (x) {
          err.style.color = "#b91c1c";
          err.textContent = x.status === 400 ? "That email and password didn't match. Check them and try again." : "Couldn't reach the online copy. Check the internet connection and try again.";
        });
      };
    }
    box.querySelectorAll("button").forEach(function (b) { b.style.padding = b.style.padding || "8px 14px"; b.style.borderRadius = "8px"; b.style.cursor = "pointer"; if (!b.style.border) b.style.border = "1px solid #ccc"; if (!b.style.background) b.style.background = "#fff"; });
    wrap.appendChild(box); document.body.appendChild(wrap);
    var first = box.querySelector("input"); if (first) first.focus();
  }

  // ---------- start ----------
  window.klCloud = { sync: syncOnce, status: function () { return Object.assign({ signedIn: !!session }, status); }, signOut: function () { saveSession(null); draw(); } };
  function start() {
    addChip();
    syncOnce();
    setInterval(syncOnce, EVERY_MS);
    window.addEventListener("online", function () { syncOnce(); });
    document.addEventListener("visibilitychange", function () { if (!document.hidden) syncOnce(); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
