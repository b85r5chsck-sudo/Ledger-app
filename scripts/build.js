#!/usr/bin/env node
// Builds one client's copy of the app into dist/.
//   CLIENT=chequers node scripts/build.js
// No dependencies, so it runs as-is on Cloudflare Pages, Netlify or a Mac.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const client = process.env.CLIENT || "chequers";
const clientDir = path.join(root, "clients", client);
const out = path.join(root, "dist");

if (!fs.existsSync(path.join(clientDir, "client.json"))) {
  console.error(`No clients/${client}/client.json. Available: ${fs.readdirSync(path.join(root, "clients")).join(", ")}`);
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(path.join(clientDir, "client.json"), "utf8"));
const required = ["appName", "shortName", "themeColor"];
for (const k of required) if (!cfg[k]) { console.error(`client.json is missing "${k}"`); process.exit(1); }

const icons = ["icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"];
for (const f of icons) {
  if (!fs.existsSync(path.join(clientDir, f))) {
    console.error(`clients/${client}/${f} is missing. Make the icons with tools/icon-maker.html.`);
    process.exit(1);
  }
}

const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "icons"), { recursive: true });

// app/index.html is the desktop app's page, copied unchanged from the desktop
// source (Updates/<version>/source/app/index.html). The web-only parts are
// added here, so updating the page is just copying the new file in.
const headExtra = `
<link rel="manifest" href="manifest.webmanifest">
<meta name="theme-color" content="${esc(cfg.themeColor)}">
<link rel="icon" type="image/png" sizes="192x192" href="icons/icon-192.png">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="${esc(cfg.shortName)}">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<script src="client-config.js"></script>`;
const bodyExtra = `
<script>
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  window.addEventListener("load", function () { navigator.serviceWorker.register("sw.js").catch(function () {}); });
}
</script>`;
let html = fs.readFileSync(path.join(root, "app", "index.html"), "utf8");
if (!/<head>/i.test(html) || !/<\/body>/i.test(html)) { console.error("app/index.html has no <head> or </body>"); process.exit(1); }
html = html
  .replace(/<head>/i, m => m + headExtra)
  .replace(/<title>[\s\S]*?<\/title>/i, () => `<title>${esc(cfg.appName)}</title>`)
  .replace(/<\/body>(?![\s\S]*<\/body>)/i, m => bodyExtra + "\n" + m);
fs.writeFileSync(path.join(out, "index.html"), html);

fs.writeFileSync(path.join(out, "client-config.js"),
  `window.LEDGER_CLIENT = ${JSON.stringify(cfg, null, 2)};\n` +
  // the desktop app gets these settings from brand/brand.json through its preload bridge
  `window.klBrand = window.LEDGER_CLIENT.brand || {};\n`);


fs.writeFileSync(path.join(out, "manifest.webmanifest"), JSON.stringify({
  name: cfg.appName,
  short_name: cfg.shortName,
  description: cfg.description || `${cfg.appName}: stock, suppliers, recipes and orders.`,
  start_url: "./",
  scope: "./",
  display: "standalone",
  orientation: "any",
  background_color: cfg.backgroundColor || "#ffffff",
  theme_color: cfg.themeColor,
  icons: [
    { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
    { src: "icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
  ]
}, null, 2));

for (const f of icons) fs.copyFileSync(path.join(clientDir, f), path.join(out, "icons", f));
fs.copyFileSync(path.join(root, "_headers"), path.join(out, "_headers")); // hosting rules (see _headers)

// Each cached file's SHA-256 goes into the worker, and the release id is a
// hash of all of them, so any change makes a new worker and devices update.
const crypto = require("crypto");
const sha = buf => crypto.createHash("sha256").update(buf).digest("hex");
const assets = {};
for (const [url, f] of [["./", "index.html"], ["./client-config.js", "client-config.js"],
  ["./manifest.webmanifest", "manifest.webmanifest"], ...icons.map(i => ["./icons/" + i, "icons/" + i])]) {
  assets[url] = sha(fs.readFileSync(path.join(out, f)));
}
const swSource = fs.readFileSync(path.join(root, "sw.js"), "utf8");
const buildId = `${client}-${sha(JSON.stringify(assets) + swSource).slice(0, 16)}`;
fs.writeFileSync(path.join(out, "sw.js"), swSource.replace(/__BUILD_ID__/g, () => buildId).replace(/__ASSETS__/g, () => JSON.stringify(assets, null, 2)));

console.log(`Built "${cfg.appName}" (${client}) into dist/  [${buildId}]`);
