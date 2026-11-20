# Kitchen Ledger app

Installable, offline-capable version of the kitchen ledger (from Drive "Project Ledger" V1.0.13).

## Files
- `index.html`: the app
- `manifest.webmanifest`: app name, colours and icons used when installed
- `sw.js`: offline cache. **Bump `CACHE_VERSION` on every release** so devices pick up changes
- `icons/`: home-screen icons

## Install on a device
- iPhone / iPad (Safari): Share, then Add to Home Screen
- Mac / Windows (Chrome or Edge): the install icon in the address bar
- Mac (Safari 17+): File, then Add to Dock

Data stays on each device (browser storage). To move data to a new device or the hosted
version, use the app's JSON backup export and import.
