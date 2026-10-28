# Android 0.4.0: raw voice and owner access

The Android app records mono AAC in an M4A container (16 kHz, 32 kbps), up to ten minutes / 3 MiB. It does not use Android speech recognition. The owner explicitly stops and sends the recording. Backgrounding the activity stops recording and retains the private local draft.

The compact widget occupies one launcher cell. A stretched widget shows a caption; both launch the same small capture sheet. Existing launcher shortcuts continue to work.

## Authentication

The app uses the existing Google owner allowlist and four-digit dashboard PIN. It opens the registered Google callback domain with a SHA-256 verifier challenge, consumes an opaque, single-use two-minute transfer code, then asks for the PIN. Tokens never enter deep links. The native verifier and session cookies are encrypted with Android Keystore; backups and cleartext networking are disabled. The app contains neither a Supabase key nor an AI provider key. PIN and sensitive screens are excluded from screenshots.

## Audio and confirmation

`POST /api/notes/mobile/voice` requires the same Google-owner session, PIN proof and origin checks as the notes API. Headers identify an immutable capture UUID, original UTC recording timestamp and duration. A service-only RPC persists the source before upload or inference, binding retries to the same SHA-256 audio hash. Storage is private. Android audio is transcribed only by Groq `whisper-large-v3`; meaning extraction uses the configured Telegram free OpenRouter model. Provider failures retain the original and never trigger a paid fallback.

Native confirmation uses the shared communication inbox API, including meeting creation, validated local dates, project/person resolution and atomic, revision-bound apply receipts. The original recording time supplies the reference for words such as “tomorrow”, including after an offline retry. An uncertain apply response can be retried with the identical request ID and body. The app never independently inserts task rows.

The app retains the local recording until successful confirmation or explicit removal. Server-side originals remain available in the inbox. Corrections and unresolved links open the existing inbox card; the browser uses its own protected session.

## Deployment order and validation

1. Apply `20261028195156_android_voice_and_login.sql`.
2. Deploy `cos-google-calendar` and `cos-notes` with their existing custom owner/PIN guards (`verify_jwt=false`).
3. Build and lint Android 0.4.0; sign the release APK with the privately retained release key.
4. Install and sign in on the owner's phone. Device login, microphone routing and launcher rendering need a real-device check; automated tests do not establish those outcomes.

Contract coverage includes owner/PIN/origin denial, bounded audio, immutable retry sequencing, Groq-only transcription, free-model routing, meeting confirmation and single-use verifier-bound login. Android CI builds debug and unsigned release APKs and runs lint. Release signing material must never be committed or included in public CI artifacts.
