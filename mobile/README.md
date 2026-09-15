# Fox Focus mobile

Android app for Fox Focus, built with Expo SDK 57 and expo-router. It is a second client for the same server as the web app: it imports the row model, API clients and Inbox grouping from `../src`, so both apps validate, group and label work the same way.

Settings takes the server URL and the owner login (`fox` and the workspace password), kept in the Android keystore.

Screens: Today (needs you, morning brief, next up), Tasks (open or done, grouped by when), Inbox (email items and Hermes jobs in one list), plus task, Inbox item and job detail.

## Develop

```bash
npm install
npm start          # scan the QR code with Expo Go on the phone
npm run typecheck
```

`npm run web` gives a quick browser preview, but the server rejects cross-origin browser requests, so the preview can't sign in. Over-the-air updates only run in a real build.

## Over-the-air updates

One-time setup with an Expo account:

```bash
npm install -g eas-cli
eas login
eas init                 # links the app and writes the project id into app.json
eas update:configure     # adds the update URL
eas build -p android --profile production
```

Install the APK from the link EAS prints. After that, ship JavaScript and UI changes without a rebuild:

```bash
npm run update -- --message "what changed"
```

The app checks on launch and whenever it comes back to the front, downloads in the background, and shows "Update ready" with a Restart button.

The runtime version follows `version` in `app.json`. Bump it and run a new `eas build` after adding a native module; updates only reach builds with the same version. A change to `../src` that the app uses also ships through `npm run update`.
