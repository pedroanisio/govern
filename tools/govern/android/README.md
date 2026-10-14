# govern remote for Android

Part of [govern](../README.md), in [super-tools](../../../README.md).

An Android app that shows every govern lane and today's telemetry, and lets the owner approve gates and acknowledge
alerts from the phone. It speaks `govern-remote/1`, the protocol in [REMOTE.md](../REMOTE.md), to `govern remote serve`.

## What it shows

- **Lanes**: each lane's stage and progress, its state (open, ready, blocked, finished), the next gate it needs, open
  alerts, the agent working on it, its last job and last note. The list updates live while the app is open.
- **A lane**: stages, gates with who decides each, alerts, human tasks, the last decisions and the ledger.
- **Telemetry**: tokens per lane today, queue depth per runner, the dispatcher, your inbox, machine time and allowances.

An approval needs your own words and a confirmation with a strong biometric or the screen lock. The phone signs the
request with a key that lives in its secure hardware and never leaves it; govern records your words with that signature
as the approval's source. Gates decided by an approval policy (a quorum of named people) are decided at a terminal.

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
links and certificate pinning. `EndToEndTest` starts the real `govern remote serve` under Node (`GOVERN_NODE`, else
`node` on `PATH`) and `openssl` for a throwaway certificate, then pairs, reads, approves, replays, streams and revokes.

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

3. In the app, paste the `govern-remote://pair?…` link it prints (or type the address and the code) and tap **Pair**.
   The phone must have a screen lock.

`govern remote devices` lists paired phones; `govern remote revoke <id>` cuts one off at once. For a self-signed
certificate instead of Tailscale, see [REMOTE.md](../REMOTE.md#reachability-and-transport-security).

## Requirements

Android 11 (API 30) or newer, with a screen lock. The app connects only over HTTPS, except to `localhost`,
`127.0.0.1` and the emulator's `10.0.2.2` for development (`adb reverse tcp:5002 tcp:5002`).
