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
 *   deleted on either side       -> deleted everywhere, even if edited elsewhere
 *                                   (a deleted row stays online)
 * "Changed" means its fingerprint differs from the last one both sides agreed
 * on (state.meta.cloud.base). That base lives inside the app's own state, so a
 * "Restore everything" brings back a base that matches the restored data and
 * never turns the restore into deletions.
 *
 * Every record has a cloudId. Records without one take the id of an online
 * record with the same name. On a device's first sync, an unchanged old copy
 * of something deleted elsewhere takes the deleted record's id, so it is
 * deleted here too instead of coming back.
 *
 * A device's ledger belongs to the first account it syncs with; signing in
 * with another account never sends this ledger there.
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
  function giveIds(live, gone) {
    var m = cloudMeta(), used = {};
    ["item", "supplier", "recipe"].forEach(function (kind) {
      LIST[kind]().forEach(function (o) { if (o.cloudId) used[kind + ":" + o.cloudId] = true; });
    });
    var known = {}; // "kind|nk" -> [ids]: live ones from the base and the rows just fetched, then deleted ones
    function add(k, ids) { (known[k] = known[k] || []).push.apply(known[k], ids); }
    Object.keys(m.base).forEach(function (k) { var b = m.base[k]; if (b.nk && !b.deleted) add(k.split(":")[0] + "|" + b.nk, [k.slice(k.indexOf(":") + 1)]); });
    Object.keys(live).forEach(function (k) { add(k, live[k]); });
    var changed = false;
    ["item", "supplier", "recipe"].forEach(function (kind) {
      LIST[kind]().forEach(function (o) {
        if (o.cloudId) return;
        var data = DATA[kind](o), nk = NAMEKEY[kind](data), fp;
        var free = (known[kind + "|" + nk] || []).filter(function (id) { return !used[kind + ":" + id]; });
        // a deleted one only when this is exactly the copy that was deleted,
        // so a different record that happens to share the name is never lost
        if (!free.length) free = (gone[kind + "|" + nk] || []).filter(function (t) {
          return !used[kind + ":" + t.id] && t.fp === (fp = fp || fpOf(data));
        }).map(function (t) { return t.id; });
        o.cloudId = free[0] || newId(kind);
        used[kind + ":" + o.cloudId] = true; changed = true;
      });
    });
    return changed;
  }

  // The versions a deleted record is known to have had, as { nk, fp } pairs:
  // the server's last live version ("last"/"was", stamped by the database)
  // and the version each deleting device had ("seen").
  function deletedVersions(kind, d) {
    var out = [];
    if (!d || typeof d !== "object") return out;
    if (d.last && d.was) { try { out.push({ nk: NAMEKEY[kind](d.last), fp: d.was }); } catch (e) {} }
    (Array.isArray(d.seen) ? d.seen : []).forEach(function (v) {
      if (v && v.nk && v.fp) out.push({ nk: v.nk, fp: v.fp });
      else if (typeof v === "string" && d.nk) out.push({ nk: d.nk, fp: v }); // an earlier single value, kept in the list by the database
    });
    if (d.nk && typeof d.was === "string") out.push({ nk: d.nk, fp: d.was });   // earlier test rows
    if (d.nk && typeof d.seen === "string") out.push({ nk: d.nk, fp: d.seen });
    return out;
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
  // `gen` changes whenever the signed-in account changes (sign in, sign out,
  // or another tab doing either). Work started under an older gen is dropped
  // when it finishes, so a late reply can never undo a sign-out.
  var session = null, gen = 0;
  function readSession() { try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch (e) { return null; } }
  session = readSession();
  function storeSession(s) { session = s; try { if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s)); else localStorage.removeItem(SESSION_KEY); } catch (e) {} }
  function signOut() { gen++; rejectRetried = false; storeSession(null); }
  function stale(g) { if (g !== gen) throw Object.assign(new Error("Signed out"), { stale: true }); }
  window.addEventListener("storage", function (e) {
    if (e.key !== SESSION_KEY) return;
    var s = readSession();
    if (!s || !session || s.uid !== session.uid) { gen++; rejectRetried = false; }
    session = s; draw();
  });

  // 1.0.7 sign-in fix — what went wrong, for the sign-in box and the error log (never the password or a token)
  function signInDetail(x, password) {
    try {
      if (!x) return "unknown";
      var msg = String(x.message || "");
      var s = x.status ? "HTTP " + x.status + (msg && msg !== "HTTP " + x.status ? " \u2014 " + msg : "")
        : (x.name && x.name !== "Error" ? String(x.name) + ": " : "") + (msg || String(x));
      if (password) s = s.split(password).join("\u2022\u2022\u2022");          // never the password, even if a server repeats it
      s = s.replace(/eyJ[\w-]+\.[\w-]+(\.[\w-]+)?/g, "\u2022\u2022\u2022")      // nor anything shaped like a token
        .replace(/\b(sb_[a-z]+_|token[=:]\s*)[\w.-]+/gi, "$1\u2022\u2022\u2022");
      return s.slice(0, 300) + (typeof navigator !== "undefined" && navigator.onLine === false ? " (this device says it is offline)" : "");
    } catch (e) { return "unknown"; }
  }
  function authCall(grant, body, g) {
    return fetch(URL_BASE + "/auth/v1/token?grant_type=" + grant, {
      method: "POST", headers: { apikey: KEY, "Content-Type": "application/json" }, body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok || !j.access_token) { var e = new Error(j.error_description || j.msg || j.error || ("HTTP " + r.status)); e.status = r.status; throw e; }
        stale(g);
        var u = j.user || {};
        storeSession({ access: j.access_token, refresh: j.refresh_token, expires: Date.now() + (j.expires_in || 3600) * 1000,
          uid: u.id || (session && session.uid) || "", email: u.email || (session && session.email) || "" });
        return session;
      });
    });
  }
  function token(g) {
    stale(g);
    if (!session) return Promise.reject(Object.assign(new Error("Not signed in"), { status: 401 }));
    if (Date.now() < session.expires - 60000) return Promise.resolve(session.access);
    return authCall("refresh_token", { refresh_token: session.refresh }, g).then(function (s) { return s.access; })
      .catch(function (e) { if ((e.status === 400 || e.status === 401) && g === gen) signOut(); throw e; });
  }
  function api(path, opts, g) {
    return token(g).then(function (t) {
      var h = Object.assign({ apikey: KEY, Authorization: "Bearer " + t, "Content-Type": "application/json" }, (opts && opts.headers) || {});
      return fetch(TABLE + path, Object.assign({}, opts, { headers: h }));
    }).then(function (r) {
      if (r.status === 401 && g === gen) signOut();
      if (!r.ok) return r.text().then(function (t) { var e = new Error("HTTP " + r.status + " " + t.slice(0, 200)); e.status = r.status; throw e; });
      stale(g);
      return r.text().then(function (t) { return t ? JSON.parse(t) : null; }); // an upload answers with no body
    });
  }
  function pullSince(rev, g) {
    var rows = [];
    function page(after) {
      return api("?select=kind,key,data,fp,deleted,rev,updated_by&rev=gt." + after + "&order=rev.asc&limit=1000", null, g).then(function (got) {
        rows = rows.concat(got);
        return got.length === 1000 ? page(got[got.length - 1].rev) : rows;
      });
    }
    return page(rev);
  }
  // Sends the changes in batches. Each change's new agreed state is only
  // recorded once its batch has been accepted, so anything that didn't go up
  // is tried again next time.
  function push(out, base, g, info) {
    var chunks = []; for (var i = 0; i < out.length; i += 500) chunks.push(out.slice(i, i + 500));
    return chunks.reduce(function (p, c) {
      return p.then(function () {
        return api("?on_conflict=owner,kind,key&select=kind,key,fp,deleted", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" },
          body: JSON.stringify(c.map(function (x) { return x.row; })) }, g)
          .then(function (back) {
            // only what the server says it now holds counts as agreed
            var got = {}; (Array.isArray(back) ? back : []).forEach(function (r) { got[r.kind + ":" + r.key] = r; });
            var missing = 0, rejected = 0;
            c.forEach(function (x) {
              var r = got[x.k];
              if (!r) { missing++; return; }
              if (r.fp === x.row.fp && !!r.deleted === x.row.deleted) base[x.k] = x.nb;
              else rejected++; // the server kept something else (a deletion it won't undo); fetched straight after
            });
            info.rejected += rejected;
            if (missing) throw new Error("The online copy didn't confirm " + missing + " change" + (missing === 1 ? "" : "s") + "; will retry");
          });
      });
    }, Promise.resolve());
  }

  // Ingredients and finished items that came in before their item did are
  // linked once the item is here.
  function relink() {
    if (typeof resolveSharedItemRef !== "function") return;
    state.recipes.forEach(function (r) {
      (r.ingredients || []).forEach(function (g) { if (!g.itemId && g.sharedRef) { var id = resolveSharedItemRef(g.sharedRef); if (id) { g.itemId = id; delete g.customName; delete g.sharedRef; g.customCostPerGramOrEach = null; } } });
      if (!r.completedItemId && r.sharedCompleted) { var cid = resolveSharedItemRef(r.sharedCompleted); if (cid) { r.completedItemId = cid; delete r.sharedCompleted; } }
    });
  }

  // ---------- one sync ----------
  var running = null, queued = null, rejectRetried = false, status = { state: "idle", at: null, error: "" };
  var APPLY_ORDER = { item: 0, supplier: 1, recipe: 2, order: 3 };

  // This device's ledger belongs to one online account. Another account's
  // sign-in never syncs it, so one business's data can't go to another.
  function accountProblem(m) {
    if (!session) return "";
    if (m.accountId) return m.accountId === session.uid ? "" : (m.account || "another account");
    if (m.account && m.account !== session.email) return m.account; // linked before ids were kept
    return "";
  }

  function syncOnce() {
    // already syncing: one more sync follows it, and the caller waits for that
    if (running) { if (!queued) queued = running.then(function () { queued = null; return syncOnce(); }); return queued; }
    if (!session) { setStatus("signed-out"); return Promise.resolve(); }
    if (typeof navigator !== "undefined" && navigator.onLine === false) { setStatus("offline"); return Promise.resolve(); }
    var m = cloudMeta(), g = gen;
    var other = accountProblem(m);
    if (other) { setStatus("error", "This device's ledger is linked to " + other + ". Sign out and sign in with that account."); return Promise.resolve(); }
    if (!m.accountId && session.uid) { m.accountId = session.uid; m.account = session.email; }
    setStatus("syncing");
    var changed = false, applied = 0, conflicts = 0, sent = 0, info = { rejected: 0 };
    running = pullSince(m.lastRev, g).then(function (rows) {
      stale(g);
      var firstMeeting = !m.lastRev;
      // first meetings: give local records the ids of same-named online ones,
      // live ones first, then (on this device's very first sync) deleted ones
      var live = {}, gone = {};
      rows.forEach(function (r) {
        if (r.kind === "order" || !NAMEKEY[r.kind]) return;
        if (r.deleted) {
          if (firstMeeting) deletedVersions(r.kind, r.data).forEach(function (v) {
            var k = r.kind + "|" + v.nk; (gone[k] = gone[k] || []).push({ id: r.key, fp: v.fp });
          });
          return;
        }
        var nk = r.data ? NAMEKEY[r.kind](r.data) : null;
        if (nk) (live[r.kind + "|" + nk] = live[r.kind + "|" + nk] || []).push(r.key);
      });
      if (giveIds(live, gone)) changed = true;
      var local = snapshot(), base = m.base, maxRev = m.lastRev;
      var latest = {}; rows.forEach(function (r) { latest[r.kind + ":" + r.key] = r; if (r.rev > maxRev) maxRev = r.rev; });

      // 1. online changes (items before recipes, so ingredients can link)
      Object.keys(latest).filter(function (k) { return KINDS.indexOf(latest[k].kind) >= 0; })
        .sort(function (a, b) { return APPLY_ORDER[latest[a].kind] - APPLY_ORDER[latest[b].kind]; })
        .forEach(function (k) {
          var r = latest[k], b = base[k], l = local[k];
          var rfp = r.deleted ? "deleted" : r.fp, bfp = b ? (b.deleted ? "deleted" : b.fp) : null;
          // nothing new online (but a deletion still applies to a record brought back here, e.g. by Undo)
          if (rfp === bfp && !(r.deleted && l)) return;
          if (r.deleted) { // a deletion wins over an edit made here
            if (l) { applyRemote(r, l); applied++; }
            base[k] = { fp: "deleted", nk: (r.data && r.data.nk) || (b && b.nk) || (l && l.nk) || null, deleted: true };
            changed = true; return;
          }
          if (!l && b && !b.deleted) return; // deleted here: the deletion goes up below
          if (l && l.fp === r.fp) { base[k] = { fp: r.fp, nk: l.nk }; changed = true; return; } // already the same
          if (l && (!b || b.deleted || l.fp !== b.fp)) { conflicts++; return; } // changed here too: this device's version goes up below
          applyRemote(r, l); applied++; changed = true;
          base[k] = { fp: r.fp, nk: NAMEKEY[r.kind](r.data) };
        });
      if (applied) relink();
      if (maxRev !== m.lastRev) { m.lastRev = maxRev; changed = true; }

      // 2. this device's changes and deletions, compared with the agreed state
      var now = snapshot(), out = [];
      Object.keys(now).forEach(function (k) {
        var n = now[k], b = base[k];
        if (b && !b.deleted && b.fp === n.fp) return;
        out.push({ k: k, nb: { fp: n.fp, nk: n.nk },
          row: { kind: n.kind, key: n.id, data: n.data, fp: n.fp, deleted: false, updated_by: computer() } });
      });
      Object.keys(base).forEach(function (k) {
        var b = base[k]; if (b.deleted || now[k]) return;
        var kind = k.slice(0, k.indexOf(":")), id = k.slice(k.indexOf(":") + 1);
        out.push({ k: k, nb: { fp: "deleted", nk: b.nk || null, deleted: true },
          row: { kind: kind, key: id, data: b.nk ? { nk: b.nk, seen: [{ nk: b.nk, fp: b.fp }] } : null, fp: "deleted", deleted: true, updated_by: computer() } });
      });
      sent = out.length;
      if (out.length) changed = true;
      return push(out, base, g, info);
    }).then(function () {
      var retry = info.rejected && !rejectRetried;
      rejectRetried = !!info.rejected;
      if (info.rejected && !retry) { setStatus("error", "The online copy kept " + info.rejected + " deletion" + (info.rejected === 1 ? "" : "s") + " over changes made here"); return; }
      if (retry) {
        // edits to records deleted elsewhere: say so, and fetch the deletions now (once)
        if (typeof toast === "function") toast("Online copy: " + info.rejected + " change" + (info.rejected === 1 ? " was" : "s were") + " not kept because " + (info.rejected === 1 ? "that record was" : "those records were") + " deleted on another device");
        setTimeout(syncOnce, 0);
      }
      setStatus(info.rejected ? "syncing" : "synced", "", { applied: applied, sent: sent, conflicts: conflicts });
    }, function (e) {
      if (e && e.stale) return;
      setStatus(session ? "error" : "signed-out", e && e.message ? e.message : String(e));
    }).then(function () {
      try {
        if (changed) { // saved even after a sign-out, so the ledger and its agreed state stay together
          quietPersist();
          if (applied) { try { renderAll(); } catch (e) {} }
        }
      } catch (e) {
        setStatus("error", "Couldn't save on this device: " + (e && e.message ? e.message : String(e)));
      } finally {
        running = null;
      }
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
    if (info && info.applied && typeof toast === "function") toast("Online copy: took in " + info.applied + " change" + (info.applied === 1 ? "" : "s") + " from other devices");
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
      box.querySelector('[data-a="out"]').onclick = function () { signOut(); close(); setStatus("signed-out"); };
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
        var g = ++gen; rejectRetried = false;
        authCall("password", { email: form.e.value.trim(), password: form.p.value }, g).then(function () {
          var other = accountProblem(cloudMeta());
          if (other) { signOut(); throw Object.assign(new Error(""), { other: other }); }
          close(); setStatus("idle"); syncOnce();
        }).catch(function (x) {
          if (x && x.stale) return;
          err.style.color = "#b91c1c";
          err.textContent = x.other ? "This device's ledger is linked to " + x.other + ", so it can't sync with a different account. Sign in with that account."
            : x.status === 400 ? "That email and password didn't match. Check them and try again." : "Couldn't reach the online copy. Check the internet connection and try again.";
          // 1.0.7 sign-in fix — the technical reason, under the friendly text and in the error log, so a failed sign-in can be diagnosed
          if (!x.other) {
            var why = signInDetail(x, form.p.value), small = document.createElement("span");
            small.style.cssText = "display:block;margin-top:6px;color:#666;font-size:12px;word-break:break-word";
            small.textContent = "Details: " + why; err.appendChild(small);
            try { console.error("Online copy sign-in failed: " + why); } catch (e2) {}
          }
        });
      };
    }
    box.querySelectorAll("button").forEach(function (b) { b.style.padding = b.style.padding || "8px 14px"; b.style.borderRadius = "8px"; b.style.cursor = "pointer"; if (!b.style.border) b.style.border = "1px solid #ccc"; if (!b.style.background) b.style.background = "#fff"; });
    wrap.appendChild(box); document.body.appendChild(wrap);
    var first = box.querySelector("input"); if (first) first.focus();
  }

  // ---------- start ----------
  window.klCloud = { sync: syncOnce, status: function () { return Object.assign({ signedIn: !!session }, status); }, signOut: function () { signOut(); setStatus("signed-out"); } };
  function start() {
    addChip();
    syncOnce();
    setInterval(syncOnce, EVERY_MS);
    window.addEventListener("online", function () { syncOnce(); });
    document.addEventListener("visibilitychange", function () { if (!document.hidden) syncOnce(); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
