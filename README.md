# Ledger-app

Ledger for kitchens: stock ordering, batch recipes, menu items and suppliers.

An installable app that works offline on iPhone, iPad, Mac and Windows, with each client's
name, icon and colours set in one file.

## Add a new client (about 5 minutes)
1. Copy `clients/chequers` to `clients/<new-client>` (lower case, no spaces).
2. Edit `clients/<new-client>/client.json`: app name, short name (shown under the home-screen icon), colour, and under `brand` the same settings as the desktop app's `brand/brand.json`.
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
- `app/index.html`: the desktop app's page, copied unchanged from `Updates/<version>/source/app/index.html`. To update the web app to a new desktop version, copy that file in and commit it. The build adds the web-only parts.
- `sw.js`: offline cache. Each release's files are checked against the SHA-256 the build gives them, so the host must serve them unchanged. `_headers` sets `no-transform` for Cloudflare Pages; on any other host, turn off minifying and script injection
- `clients/<name>/`: `client.json` plus 4 icons for each client
- `scripts/build.js`: builds one client into `dist/`
- `tools/icon-maker.html`: makes icon PNGs from initials or a logo

## Install on a device
- iPhone / iPad (Safari): Share, then Add to Home Screen
- Mac / Windows (Chrome or Edge): the install icon in the address bar
- Mac (Safari 17+): File, then Add to Dock

Data is stored on each device. With the online copy turned on (below), every device that signs in shares the same data.

## First-time setup on a new iPad, iPhone or browser
1. On a desktop computer with up-to-date data, press **Back up now**. The backup (.json) is saved in Documents > Backups > JSON.
2. Open the web app on the new device and add it to the home screen (see above).
3. If the business already uses the online copy, tap **☁ Online copy** and sign in. Everything comes in by itself; no files are needed.
4. If not: copy the backup to the device (AirDrop, Files or email), press **Import** and pick it. Items, prices, recipes, suppliers with all their details (address, email, phone, account number, ordering method, notes) and saved orders come in. Then tap **☁ Online copy** and sign in so it stays up to date.

## Online copy (optional, per client)

Lets iPads and iPhones share items, suppliers, recipes and saved orders with the
desktop app. It's turned on by a `cloud` entry in the client's `client.json`
(`brand.cloud`): `{ "url": "https://<project>.supabase.co", "key": "sb_publishable_…" }`.
Leave it out and the app works as before, on this device only.

Setting up a client's Supabase project:

1. Supabase > SQL Editor > New query: paste `supabase/schema.sql` and Run. It is safe to run again.
2. Authentication > Users > Add user: one email and password for the business. All its devices sign in with it.
3. Authentication > Sign In / Providers: turn off "Allow new users to sign up".
4. Use only the publishable key in `client.json`, never the secret key.

On each device, tap the "☁ Online copy" chip next to the status pill to sign in.
A device's ledger stays linked to the first account it syncs with.
`app/cloud-sync.js` is built into the end of the app's main script by `scripts/build.js`.

From desktop 1.0.6 the desktop app has the online copy too: sign in with the same
"☁ Online copy" chip, and the desktops and the iPads/web app share changes about every
30 seconds. The desktops still keep the ledger on the network drive up to date as before.
The desktop page (`app/index.html` from desktop 1.0.6 on) already contains the online copy
between `// ==== BEGIN online copy` and `// ==== END online copy ====`; the build swaps that
block for this repository's `app/cloud-sync.js`, so it is never added twice.

## Desktop app updates (from desktop 1.0.6)

The desktop app checks `https://<site>/desktop/update.json` (its `brand.json` "updates"
address) when it opens and every few hours. When a newer signed page is published it shows
an **Update available** box with **Update now** and **Later**; Update now saves to the linked
files and restarts on the new version. Help > Check for updates… checks straight away, and
Help > Go back to the built-in version… undoes an update on that computer. Until an update
is published, Check for updates says "You're on the latest version".

To publish one, make it with the desktop project's `tools/update-signing/make-release.js`
(its README has the steps) and put the two files it writes, `update.json` and
`index-<version>.html`, in this repository's `desktop/` folder. The build copies only those
into `dist/desktop/`. Every update is signed with a private key that is kept only on the
developer's Mac, never in this repository; the desktop app checks the signature and the
file's SHA-256 before using it, and ignores anything else.
