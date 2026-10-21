# AutoJob extension on the Chrome Web Store

The app connects to the user's Chrome through the AutoJob extension
(`extension/`). Until the extension is published, users load it unpacked:

1. The app copies the bundled extension into `<app data>/chrome-extension` on
   every start (`app/jev/extension-folder.mjs`). That folder does not move with
   app updates or with a changed data folder, so the path loaded in Chrome stays
   valid. Chrome reloads an unpacked extension's files on its next start.
2. The setup screen and the sidebar's Chrome card show the steps, a button that
   copies `chrome://extensions` and a button that reveals the folder to drag
   onto that page.
3. While the extension is missing, the app looks for it in the profile's
   preference files every two seconds for 15 minutes (then with the usual
   backoff) and connects on its own once Chrome records it.

## Publishing

Publishing needs the owner's Chrome Web Store developer account (one-time
registration fee).

1. Add a 128×128 icon to `extension/` and an `icons` entry in the manifest; the
   store requires one.
2. Run `pnpm extension:pack`. It writes `release/autojob-extension-<version>.zip`
   without the development `key`, which the store does not accept.
3. In the developer dashboard, create the item, upload the zip and choose
   **Unlisted** visibility, so only people with the link can install it.
4. Listing text:
   - Summary: "Lets the AutoJob desktop app manage only the tabs it opens in
     this Chrome profile."
   - Single purpose: "Connects the AutoJob desktop app on this computer to the
     tabs it opens, so it can read and fill pages the user asked it to work on."
5. Permission justifications:
   - `debugger`: drives the tabs the app opened (reading pages, clicking,
     typing). It attaches only to those tabs; Chrome shows its "AutoJob" bar.
   - `tabs`: opens, focuses and closes the app's own tabs.
   - `webNavigation`: notices pop-ups opened by the app's tabs so they belong
     to the app and stay in the background.
   - `storage`: remembers which tabs belong to the app across service-worker
     restarts.
   - Host permissions: none.
6. Privacy: the extension sends page content only to the AutoJob app on the
   same computer (`127.0.0.1`), never to a remote server. It collects no
   personal data for itself.

## After the store accepts it

1. Copy the item's public key from the dashboard (Package → View public key)
   into `extension/manifest.json` as `key`, and set `EXTENSION_ID` in
   `app/jev/extension.mjs` to the store's ID. Unpacked copies then keep the
   same ID as the store version.
2. Set `WEB_STORE_URL` in `app/jev/extension.mjs` to the item's store page. The
   setup screen then offers "Add to Chrome" (opened in the selected profile),
   and on start the app registers the extension with Chrome
   (`registerExternalExtension`): on macOS a file in
   `~/Library/Application Support/Google/Chrome/External Extensions`, on Windows
   a key under `HKCU\Software\Google\Chrome\Extensions`. Chrome then asks the
   user to enable the extension on its next start. Chrome honours these entries
   only for extensions hosted on the Web Store.
