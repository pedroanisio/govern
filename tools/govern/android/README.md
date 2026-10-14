# govern FIELD for Android

Part of [govern](../README.md), in [super-tools](../../../README.md).

An Android app that shows every govern lane and today's telemetry, and lets the owner approve gates and acknowledge
alerts from the phone. It speaks `govern-remote/2`, the protocol in [REMOTE.md](../REMOTE.md), to `govern remote serve`.

## What it shows

- **Operation**: sessions across all hosts, online/cache counts, and evidence cards for current-stage gates awaiting the person. The plus button creates a session using a scoped lane and an engine from that host’s desk.
- **Hosts**: paired hosts with live, cached or offline state, identity, scope and certificate pin; select, pair or forget a host.
- **Decisions**: the same current-stage gate cards across hosts. Open a card to inspect the artifact version and SHA, check evidence and job logs, and approve or request changes with your own words.
- **Activity**: lane decisions, ledger entries and notes for the selected host, newest first. Opening this tab fetches lane details when live.
- **Session**: stage stepper, artifacts, jobs, last message and its verification label, run state, and queued or interrupting guidance. Logs, artifacts and additional lane actions remain accessible.
- **A lane**: stages, gates, alerts, human tasks, notes and ledger; Back returns to the previous tab.

An approval needs your own words and a confirmation with a strong biometric or the screen lock. The phone signs the
request with a Keystore key; govern records your words and signature. Policy gates remain at a terminal.
Actions and refresh are disabled unless the selected host stream is live. A confirmation captures its host identity
before authentication, so switching hosts cannot redirect the signed action.

## Hosts, offline cache and languages

Each host retains a random stable ID, endpoint, device ID, person, optional lane scope, pin and pairing timestamp.
Tokens are sealed individually with AES-GCM. New hosts use the signing alias `govern-remote-device-<hostId>`.
The existing single pairing migrates automatically and retains `govern-remote-device`; no new pairing is needed.
Because the legacy preferences contain no timestamp, its `pairedAt` records the migration time.
Pairing the same endpoint replaces its credentials while retaining its ID and key, and clears the old scope's cache.
Forgetting a host removes its local credential, signing key and snapshots; it does not revoke the server device.
Use `govern remote revoke` to revoke that credential on the server.

Each host gets its own foreground stream and reconnect backoff (2–60 seconds). The last desk and each fetched lane
are written as JSON under `noBackupFilesDir/cache/<hostId>/`, using a synced temporary file and atomic rename.
Snapshots load on startup or when opening a lane. A cached banner shows the snapshot timestamp when offline;
a lane never fetched on this phone cannot be opened offline. Corrupt snapshots report an error.

FIELD follows the system dark/light setting. Light mode uses cream, white cards, deep green and lime; dark mode retains the dark palette. Codes, pins and ledger text use monospace.
English is the default language; Brazilian Portuguese follows the device locale. Both resource sets have matching
keys and format arguments, enforced by `StringsTest`. Server-authored content and protocol error details remain
in the language sent by the host.

## Protocol reads

The protocol layer carries check summaries, session summaries, available engines, the server hostname and the requesting
viewer, plus lane checks, jobs, artifacts and decisions. `GovernClient.session(id, messages)` reads the last 20 messages
by default (1..100). `job(lane, id, lines)` reads the last 100 log lines by default (1..1000).
`artifact(lane, name, sink)` streams bytes to an OutputStream and returns `ArtifactDownload(bytes, sha256, mediaType)`.
It leaves the sink open and throws ProtocolException if the computed SHA-256 differs from Govern-Artifact-Sha256;
use the downloaded bytes only after the call succeeds. The session and decision screens consume these reads.

The strict parser covers desk, lane, session and job fixtures. EndToEndTest exercises the new reads against the real
server and tests refusal of an incorrect artifact digest.

## Signed action protocol

`Actions` encodes approve (optionally with `ArtifactRef(name, sha256)`), ack, changes, reviewed, instruct and session.
`changes(lane, gate, quote, artifact?)` requests adjustments; `reviewed(lane, artifact)` records a digest-bound review.
`instruct(session, text, mode)` accepts queue or interrupt; `session(lane, engine, title, text)` opens a conversation.
Choose engines from the desk, including configured conversation adapters and supported profiles.

Quotes need 2..2000 characters, text 1..8000 after trim and titles 1..120 after trim. Invalid bounds, modes, artifact
names or digests throw IllegalArgumentException before signing. Null artifacts are omitted from JSON.
Sign and send the same bytes after per-action device confirmation. Approve requires the person's own words;
changes, reviewed, instruct and session approve nothing and require the same confirmation.
`GovernClient.act` returns `ActionResult(ok, lane: LaneDetail?, session: SessionDetail?)`. Only instruct/session return
a session; a lane-less instruction returns a null lane. Shared fixtures cover all three combinations. ActionsTest checks
exact encodings and bounds. EndToEndTest uses the real server and fake echo adapter, polling conversation files until
background runs complete. The screens submit these actions only after device confirmation and display the returned session/run state.

## Build

The app needs a JDK 17 or newer and an Android SDK with platform 35 and build-tools 35. The Gradle wrapper fetches
Gradle and the dependencies.

```sh
export ANDROID_HOME=/path/to/android-sdk      # or: echo "sdk.dir=/path/to/android-sdk" > local.properties
./gradlew testDebugUnitTest assembleDebug     # from tools/govern/android; or `make android` at the repository root
```

The APK is `app/build/outputs/apk/debug/app-debug.apk`, signed with the SDK's debug key. Install it with
`adb install -r app/build/outputs/apk/debug/app-debug.apk`, or copy it to the phone and allow installs from that source.
A release build (`./gradlew assembleRelease`) needs your own signing key.

The unit tests cover the wire types against shared fixtures, the signed action bodies, the event-stream parser, pairing
links, comparison-code vectors, closed pairing wire types and certificate pinning. `HostListTest`, `DeskCacheTest`, `StringsTest` and
`DecisionsTest` cover host-list migration, atomic snapshots, locale parity and the cross-host decision filter. `EndToEndTest` starts the real
`govern remote serve` under Node (`GOVERN_NODE`, else `node` on `PATH`) and `openssl` for a throwaway certificate, then pairs, reads, approves, replays, streams and revokes. It also requests pairing, compares the phone code with
`govern remote requests`, confirms through the real CLI, polls the token once and reads the scoped desk.

## Pair the phone

1. On the machine that holds the workspace, publish the server. With Tailscale:

   ```sh
   govern remote serve &                  # loopback, port 5002
   tailscale serve --bg 5002              # https://<machine>.<tailnet>.ts.net
   ```

2. At your own terminal (not inside an agent session), create a pairing code:

   ```sh
   govern remote pair --url https://<machine>.<tailnet>.ts.net
   ```

3. Scan the QR code it draws with the phone's camera: the app opens with the form filled in. Check the server address,
   then tap **Pair**. Without a camera, paste the `govern-remote://pair?…` link it prints, or type the address and the code.
   The phone must have a screen lock.

`govern remote devices` lists paired phones; `govern remote revoke <id>` cuts one off at once. For a self-signed
certificate instead of Tailscale, see [REMOTE.md](../REMOTE.md#reachability-and-transport-security).

## Phone-initiated pairing protocol

`GovernClient.requestPairing(name, publicKey, lanes)` creates a five-minute request. The result includes `id`, `secret`,
`expires` and `host`. `ComparisonCode.of(id, publicKeyBase64, pin)` computes the six digits to compare with
`govern remote requests` at the host. The owner confirms with `govern remote confirm ID --code NNNNNN`, optionally
replacing the requested scope with repeated `--lane` flags or `--all`, and choosing `--person` (default `owner`).

`pollPairing(id, secret)` returns the state, expiry, identity, scope, host and a token delivered on the first confirmed
poll only. `cancelPairing(id, secret)` cancels a waiting request. Preserve the secret while waiting; a wrong secret is
refused. A wrong comparison code permanently refuses the request. A device scoped to lanes receives a filtered desk
and gets 403 for other lanes. `PairResponse` from the original flow also includes `host`.

`PairingLinks.parse` accepts `govern remote link` links without a `code`, with an optional `lane`; `requestPairing`
is true for these links. Its `code` is empty so existing form consumers remain compatible. Links with `code=` keep
the original flow; an explicitly empty code is invalid. Opening a link without a code starts the request screen. The phone displays the requested host and scope, a grouped comparison code, and a countdown. Polling stops at the injected-clock deadline or a terminal response; Cancel posts to the cancellation route. Confirmed credentials are sealed in HostStore, then Operation opens. Refusal, expiry and cancellation are displayed. The request secret stays in memory; process death requires a new request after the old one expires.

## Requirements

Android 11 (API 30) or newer, with a screen lock. The app connects only over HTTPS, except to `localhost`,
`127.0.0.1` and the emulator's `10.0.2.2` for development (`adb reverse tcp:5002 tcp:5002`).

## Evidence and session interaction

Artifact downloads go through the authenticated client, verify the response SHA and the digest displayed on screen,
and only then become readable files under `cacheDir/artifacts/<hostId>/<sha256>/<name>`.
A non-exported FileProvider grants temporary read access to an ACTION_VIEW handler; only the artifact cache is shared.
Image and video previews use bounded thumbnail decoding. Opening evidence from a decision confirms and signs a
`reviewed` action before launching the viewer. A review badge comes from the server’s reviews for that digest and person.
Approve and changes bind the displayed artifact name and SHA to the typed quote. A 409 reloads the lane and asks the
person to review again. Neither action publishes anything automatically. Gates without artifacts explicitly say so. Session and decision heroes select the most recently modified artifact,
independent of the server’s alphabetical listing; the artifact list still exposes every file.

Session details are retained in memory while the app runs; offline reopening after process death shows the desk’s last
message and cached lane evidence, not a fabricated full transcript. Job logs require a live host and show up to 1000
lines. Stream updates refresh an open session. All instructions, session creation and review actions require the same
per-use biometric or credential confirmation as approval. Queue is the default instruction mode.

`FieldViewModelsTest` uses the shared lane, session and desk fixtures for current-gate filtering, stage states, evidence,
review identity, session status precedence, cross-host counts, scope, initials, quote bounds, locale plurals and an
injected-clock expiry boundary. Decision eligibility also covers live state, busy state, scope, owner and gate
dependencies. `AppModelContractTest` checks the Application constructor required by Android’s default ViewModel factory
while retaining clock injection. Device rendering, authentication and external viewer dispatch require Android testing.
