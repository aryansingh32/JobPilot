# JobPilot Android app

The Android app is the **same web UI** (`chatflow-interface`), built as static files and wrapped with
[Capacitor 7](https://capacitorjs.com). Every screen, colour and component comes from the same code as the
website. There is no second UI to keep in sync.

## How it differs from the website

| | Website | Android app |
|---|---|---|
| UI | served by the TanStack Start server | bundled into the APK (`dist/client`, single-page shell) |
| Sign-in | httpOnly `jp_session` cookie | session token kept in device storage, sent as `Authorization: Bearer` with `x-jp-client: android` |
| Live updates | Socket.IO with the cookie | Socket.IO with `auth: { token }` |
| Session length | 30 days | 30 days, refreshed (`POST /auth/refresh`) once a week while the app is used |
| Notifications | in-app | in-app + push (FCM) when enabled |
| Back button | browser | closes the drawer → back to home → exits |

Code: `src/lib/native.ts` (token + headers) and `src/lib/native-app.ts` (status bar, back button, push). On the
web both are no-ops.

## Build

```bash
cd chatflow-interface
cp .env.android.example .env.android   # set VITE_API_BASE_URL (https) and VITE_API_KEY
npm run android:apk                    # → android/app/build/outputs/apk/debug/app-debug.apk
npm run android:open                   # open in Android Studio (release signing, run on a device)
```

Local testing against a backend on your machine, from the emulator:

```bash
# .env.android: VITE_API_BASE_URL=http://10.0.2.2:3000
npm run android:dev                    # allows plain http; never use for a release
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

The backend accepts the app's origin (`https://localhost`) by default. See `NATIVE_APP_ORIGINS` in
`backend/.env.example`.

## Push notifications (optional)

1. Create a Firebase project and add an Android app with package `com.jobpilot.app`.
2. Put its `google-services.json` in `chatflow-interface/android/app/`. The file is git-ignored.
3. Set `VITE_PUSH_ENABLED=true` in `.env.android` and rebuild. Registering for push without that file crashes
   the app, so the flag stays off until the file is there.
4. Backend: set `FCM_SERVICE_ACCOUNT` (the service-account JSON) or `FCM_SERVICE_ACCOUNT_FILE`.

You get a push when an application needs an answer, is ready for review, is submitted or fails, and when an
employer replies to your inbox. Tapping it opens that application. Admins can send announcements from
`POST /admin/notifications/broadcast` and see delivery numbers at `GET /admin/notifications/stats`.

## Release checklist

- `VITE_API_BASE_URL` is https. The release build must not use `android:dev`.
- Signing key: `android/app` → Android Studio → *Generate Signed Bundle* (keep the keystore out of git).
- Version: `versionCode` / `versionName` in `android/app/build.gradle`.
- Play Store requires deleting your account from inside the app. The endpoints exist (`DELETE /me`,
  `GET /me/export`), but the UI has no "Delete account" button yet. The app is kept identical to the website,
  so that button has to be added to the shared UI.
- Google sign-in: Google blocks its web button inside app WebViews. Email and mobile OTP work. Native Google
  sign-in needs a plugin plus an Android OAuth client (not done yet).
