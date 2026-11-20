# Ledger-app

Ledger for kitchens: stock ordering, batch recipes, menu items and suppliers.

An installable app that works offline on iPhone, iPad, Mac and Windows, with each client's
name, icon and colours set in one file.

## Add a new client (about 5 minutes)
1. Copy `clients/chequers` to `clients/<new-client>` (lower case, no spaces).
2. Edit `clients/<new-client>/client.json`: app name, short name (shown under the home-screen icon), initials, colour and the in-app brand defaults.
3. Open `tools/icon-maker.html` in a browser, type the initials or add a logo, pick the colour and download the 4 icons into that folder, replacing the copies.
4. In Cloudflare Pages, create a project from this repository with:
   - Build command: `node scripts/build.js`
   - Build output directory: `dist`
   - Environment variable: `CLIENT` = `<new-client>`

Each client gets their own link and their own separate data.

## Build and preview locally
```
CLIENT=chequers node scripts/build.js
cd dist && python3 -m http.server 8000   # then open http://localhost:8000
```
There are no dependencies to install. Every build gets a new cache version, so installed apps update automatically.

## Files
- `index.html`: the app (`__APP_NAME__`-style placeholders are filled in by the build)
- `sw.js`: offline cache
- `clients/<name>/`: `client.json` plus 4 icons for each client
- `scripts/build.js`: builds one client into `dist/`
- `tools/icon-maker.html`: makes icon PNGs from initials or a logo

## Install on a device
- iPhone / iPad (Safari): Share, then Add to Home Screen
- Mac / Windows (Chrome or Edge): the install icon in the address bar
- Mac (Safari 17+): File, then Add to Dock

Data is stored on each device. To move it to another device, use the app's JSON backup export and import.
