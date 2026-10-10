# Building SubTerm for iOS / iPadOS

> **Status: prepared, not yet built.** The code base is set up for an iOS build, but it was prepared on
> Windows, where Apple's toolchain does not exist, so nothing here has been compiled or run for iOS yet.
> Expect to fix a few compile errors on the first Mac build. The notes below say where to look first.

## What you need

- A Mac with **Xcode** (App Store) and the command line tools (`xcode-select --install`).
- An Apple Developer account for running on a real device (a free account works for your own device).
- Rust iOS targets: `rustup target add aarch64-apple-ios aarch64-apple-ios-sim`.
- **CocoaPods** is not needed; Tauri uses Swift Package Manager.
- Node 18+ and `npm install` as usual.

## First build

```sh
npm run ios:init      # generates src-tauri/gen/apple (commit it)
npm run ios:dev       # simulator; add `-- --device` for a connected iPhone/iPad
npm run ios:build     # release build for the App Store / TestFlight
```

Open `src-tauri/gen/apple/*.xcodeproj` in Xcode once to choose your **Team** for signing. To make
the app's Documents folder visible in the Files app, add `UIFileSharingEnabled` and
`LSSupportsOpeningDocumentsInPlace` (both `true`) to the generated `Info.plist`.

## What was prepared

- `src-tauri/Cargo.toml`: desktop-only crates (`rfd`, `portable-pty`, `open`, `tauri-plugin-window-state`)
  are excluded for Android **and** iOS. `cargo tree --target aarch64-apple-ios` confirms none of them
  are in the iOS graph.
- Rust platform checks use Tauri's `desktop` / `mobile` aliases instead of `target_os = "android"`, so
  every "not supported on mobile" fallback (local terminal, native pickers, profile import) applies to iOS too.
- `android_quick_dirs` (name kept for the front end) returns the app's Documents and app-data folders on
  iOS, which is where downloads land.
- `src/util/platform.ts` detects iOS and iPadOS (which reports itself as a Mac but has a touch screen);
  `IS_MOBILE_OS` replaces the Android-only checks for pickers and "open with default app".
- `tauri.conf.json`: minimum iOS version 14.0. The existing on-screen key bar and narrow layouts apply.

## Known gaps and risks (check these first)

| Area | Expectation on iOS |
|---|---|
| Local terminal | Not available (iOS apps cannot start shells). The command returns an error and the shell list is empty. |
| Embedded / system RDP | Not available. The RDP helper is a separate desktop executable and iOS cannot launch it. |
| SSH agent forwarding, `~/.ssh/config` import | No local agent or home folder; the options will do nothing. |
| `notify` (live file edit, mirrors) | File watching may not compile or work on iOS; if the build fails here, gate these behind `desktop`. |
| `if-watch` (network change detection) | Same: verify it builds; auto-reconnect on network change may need an iOS-specific path. |
| Background sessions | iOS suspends apps shortly after they leave the foreground, which drops SSH connections. Auto-reconnect on resume is the realistic goal; long-lived background tunnels are not. |
| App Store review | An SSH client is fine, but the Documents/Files access and the "export keys" flows need a clear usage description. |

## Suggested order for the first Mac session

1. `npm run ios:init`, then `npm run ios:dev` on the simulator and fix compile errors (likely `notify`, `if-watch`, `ring`/`aws-lc` C builds).
2. Connect to a test server, open a terminal, SFTP list/download to Documents.
3. Check the keyboard bar and the layout on an iPad in split view.
4. Test suspend/resume and reconnect.
