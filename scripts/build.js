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
const buildId = `${client}-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`;

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "icons"), { recursive: true });

let html = fs.readFileSync(path.join(root, "index.html"), "utf8")
  .replace(/__APP_NAME__/g, esc(cfg.appName))
  .replace(/__SHORT_NAME__/g, esc(cfg.shortName))
  .replace(/__THEME_COLOR__/g, esc(cfg.themeColor));
fs.writeFileSync(path.join(out, "index.html"), html);

fs.writeFileSync(path.join(out, "client-config.js"),
  `window.LEDGER_CLIENT = ${JSON.stringify(cfg, null, 2)};\n`);

fs.writeFileSync(path.join(out, "sw.js"),
  fs.readFileSync(path.join(root, "sw.js"), "utf8").replace(/__BUILD_ID__/g, buildId));

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

console.log(`Built "${cfg.appName}" (${client}) into dist/  [${buildId}]`);
