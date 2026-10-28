# Android 0.4.2: raw voice and owner access

The Android app records mono AAC in an M4A container (16 kHz, 32 kbps), up to ten minutes / 3 MiB. It does not use Android speech recognition. The owner explicitly stops and sends the recording. Backgrounding the activity stops recording and retains the private local draft.

The compact widget occupies one launcher cell. A stretched widget shows a caption; both launch the same bottom capture sheet in a separate task affinity, so opening the widget does not bring the dashboard activity in front of the launcher. The translucent sheet slides up over the current screen and slides down on close. Its microphone gently pulses only while recording and respects disabled system animations. Closing with the cross, outside tap or Back stops recording and retains the private draft. Existing launcher shortcuts continue to work.

If the owner session or PIN has expired, the sheet shows a **Разблокировать** action; it does not automatically navigate to the full login screen. The same owner and PIN checks still gate recording and upload.

The Google callback returns to the app task that initiated login, whether the dashboard or widget capture. That task ID is retained with the encrypted, expiring PKCE verifier and is never accepted from a deep link. If the original task is gone, the standard login screen still validates the one-use code and verifier.

## Authentication

The app uses the existing Google owner allowlist and four-digit dashboard PIN. It opens the registered Google callback domain with a SHA-256 verifier challenge, consumes an opaque, single-use two-minute transfer code, then asks for the PIN. Tokens never enter deep links. The native verifier and session cookies are encrypted with Android Keystore; backups and cleartext networking are disabled. The app contains neither a Supabase key nor an AI provider key. Screenshots are allowed on all app screens at the owner's request.

## Audio and confirmation

`POST /api/notes/mobile/voice` requires the same Google-owner session, PIN proof and origin checks as the notes API. Headers identify an immutable capture UUID, original UTC recording timestamp and duration. A service-only RPC persists the source before upload or inference, binding retries to the same SHA-256 audio hash. Storage is private. Android audio is transcribed only by Groq `whisper-large-v3`; meaning extraction uses the configured Telegram free OpenRouter model. Provider failures retain the original and never trigger a paid fallback.

Native confirmation uses the shared communication inbox API, including meeting creation, validated local dates, project/person resolution and atomic, revision-bound apply receipts. The original recording time supplies the reference for words such as “tomorrow”, including after an offline retry. An uncertain apply response can be retried with the identical request ID and body. The app never independently inserts task rows.

The server accepts UTC recording timestamps with zero to nine fractional digits, including Android `Instant.toString()` nanoseconds. The original string is forwarded unchanged to the capture RPC, preserving retry identity for drafts already saved by version 0.4.0. Format, future-time, audio-size, duration and UUID checks still apply. This server fix requires deploying `cos-notes`; a Vercel deployment alone does not update the function.

For a direct instruction such as “В пятницу надо уточнить готовность образцов”, the server recovers the work date from the literal action quote even if the model omits or rewrites the date field. It resolves the day relative to the original recording time in the configured timezone, keeps an unstated clock time empty, and still rejects ambiguous or cross-clause date inference. Requested result deadlines remain separate from work dates.

The app retains the local recording until successful confirmation or explicit removal. Server-side originals remain available in the inbox. Corrections and unresolved links open the existing inbox card; the browser uses its own protected session.

## Deployment order and validation

1. Apply `20261028195156_android_voice_and_login.sql`.
2. Deploy `cos-google-calendar` and `cos-notes` with their existing custom owner/PIN guards (`verify_jwt=false`).
3. Build and lint Android 0.4.2 (versionCode 6); sign the release APK with the same privately retained release key as 0.4.0 so it installs as an update.
4. Install and sign in on the owner's phone. Device login, microphone routing and launcher rendering need a real-device check; automated tests do not establish those outcomes.

Contract coverage includes owner/PIN/origin denial, bounded audio, immutable retry sequencing, Groq-only transcription, free-model routing, meeting confirmation and single-use verifier-bound login. Android CI builds debug and unsigned release APKs and runs lint. Release signing material must never be committed or included in public CI artifacts.
