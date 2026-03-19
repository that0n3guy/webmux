# webmux-macos

macOS-only SwiftUI proof of concept for `webmux` with an embedded Ghostty terminal.

This target is intentionally small:

- one window
- worktree sidebar
- create/open/close worktree actions
- native terminal surface attached to the selected tmux target
- Bun backend reused as a local sidecar

It is a development POC, not a signed or notarized desktop app.

## Architecture

The current runtime flow is:

1. `WebmuxMacOSApp` boots a single SwiftUI window.
2. `WorktreeStore` starts or connects to the local Bun sidecar through `SidecarController`.
3. `BackendClient` loads `GET /api/project` and populates the sidebar.
4. Selecting an open worktree fetches `GET /api/worktrees/:name/terminal-target`.
5. `TerminalCommandFactory` turns that target into a grouped tmux attach command.
6. `GhosttyTerminalView` embeds a native Ghostty surface and runs that command in the worktree directory.

Main files:

- `Sources/WebmuxMacOS/WebmuxMacOSApp.swift`
  - app entry point
- `Sources/WebmuxMacOS/ContentView.swift`
  - sidebar, detail pane, toolbar, create sheet, terminal panel
- `Sources/WebmuxMacOS/WorktreeStore.swift`
  - app state, worktree actions, terminal attach resolution
- `Sources/WebmuxMacOS/BackendClient.swift`
  - minimal HTTP client for the Bun API
- `Sources/WebmuxMacOS/BackendModels.swift`
  - request and response models
- `Sources/WebmuxMacOS/SidecarController.swift`
  - starts the backend locally and waits for health
- `Sources/WebmuxMacOS/AppEnvironment.swift`
  - repo detection, ports, tmux mode, Ghostty resource discovery
- `Sources/WebmuxMacOS/TerminalCommandFactory.swift`
  - tmux grouped-session attach command builder
- `Sources/WebmuxMacOS/GhosttyRuntime.swift`
  - `GhosttyKit` runtime bootstrap and clipboard/action callbacks
- `Sources/WebmuxMacOS/GhosttyTerminalView.swift`
  - AppKit wrapper around the embedded Ghostty surface
- `scripts/build-ghosttykit.sh`
  - builds `GhosttyKit.xcframework` and copies Ghostty resources

## Runtime model

The app currently depends on three local pieces:

- this repo checkout
- the Bun backend in `backend/src/server.ts`
- Ghostty assets under `apps/webmux-macos/ThirdParty/`

By default the app runs the backend in isolated tmux mode via `scripts/run-with-isolated-tmux.sh`. That keeps native POC sessions away from the user’s normal tmux server unless explicitly overridden.

## Prerequisites

You need:

- macOS 15 or newer
- Xcode with Swift 6.1 support
- `bun`
- `tmux`
- `git`
- `zig`

If Ghostty build complains about missing Apple toolchain pieces, install the Xcode Metal toolchain component first.

## Bootstrap dependencies

The Swift package expects a locally built Ghostty binary target and resource payload:

```bash
./scripts/build-ghosttykit.sh
```

That script:

- clones Ghostty
- builds `GhosttyKit.xcframework`
- copies Ghostty runtime resources into `apps/webmux-macos/ThirdParty/GhosttyResources`

Those assets are intentionally ignored by git.

## Run in development

Build:

```bash
swift build --package-path apps/webmux-macos
```

Run:

```bash
swift run --package-path apps/webmux-macos
```

The app will:

- detect the repo root
- start the Bun backend sidecar if it is not already running
- fetch the worktree list from `GET /api/project`
- attach the terminal using `GET /api/worktrees/:name/terminal-target`

## Useful environment variables

These are optional, but useful while developing:

- `WEBMUX_NATIVE_REPO_ROOT`
  - override repo root discovery
- `WEBMUX_NATIVE_PROJECT_DIR`
  - override the project directory passed to the backend
- `WEBMUX_NATIVE_PORT`
  - change the backend port from the default `6121`
- `WEBMUX_NATIVE_TMUX_MODE`
  - `isolated` by default, set to `live` to use the normal tmux server
- `WEBMUX_ISOLATED_TMUX_SOCKET_NAME`
  - override the isolated tmux socket name
- `WEBMUX_NATIVE_GHOSTTY_RESOURCES_DIR`
  - override the Ghostty resource directory
- `GHOSTTY_RESOURCES_DIR`
  - fallback resource override if the app-local one is not set

Example:

```bash
WEBMUX_NATIVE_PORT=6122 \
WEBMUX_NATIVE_TMUX_MODE=isolated \
swift run --package-path apps/webmux-macos
```

## Development test checklist

Start the app and validate the current POC end to end:

1. Confirm the sidebar loads worktrees from the backend.
2. Select a worktree and verify its detail pane updates.
3. Click `Open Worktree` for a closed worktree.
4. Wait for the terminal panel to attach.
5. In the terminal, verify:
   - `pwd`
   - `echo $TERM`
   - `nvim`
   - `lazygit`
   - long-running CLI output
   - resize behavior
   - copy/paste
6. Switch to another worktree and confirm the terminal reattaches to the correct tmux target.
7. Close the worktree and confirm the terminal panel returns to the placeholder state.

Useful external checks while the app is running:

```bash
curl -sS http://127.0.0.1:6121/api/project | jq .
curl -sS http://127.0.0.1:6121/api/worktrees/<branch>/terminal-target | jq .
tmux -L webmux-native-webmux-6121 list-sessions
tmux -L webmux-native-webmux-6121 list-windows -a
```

If you changed `WEBMUX_NATIVE_PORT` or the socket name, update those commands accordingly.

## Bundle it

There is no automated packaging target yet. The current bundle story is a manual development bundle around the SwiftPM executable.

Important limitation:

- this is not a self-contained production app
- it still expects a local `webmux` repo checkout so it can launch the Bun backend and related scripts
- if you move the bundle away from the machine or checkout it was built from, you should pass explicit environment overrides

### Build a release executable

```bash
swift build --package-path apps/webmux-macos --configuration release
```

### Create a dev `.app`

```bash
APP_DIR="$PWD/dist/WebmuxMacOS.app"

mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"
cp apps/webmux-macos/.build/arm64-apple-macosx/release/WebmuxMacOS \
  "$APP_DIR/Contents/MacOS/WebmuxMacOS"
cp -R apps/webmux-macos/ThirdParty/GhosttyResources \
  "$APP_DIR/Contents/Resources/GhosttyResources"

cat > "$APP_DIR/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>WebmuxMacOS</string>
  <key>CFBundleIdentifier</key>
  <string>dev.webmux.macos</string>
  <key>CFBundleName</key>
  <string>WebmuxMacOS</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>15.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
EOF
```

### Launch the bundle in development

The most reliable way is to run the app executable directly with explicit environment values:

```bash
APP_DIR="$PWD/dist/WebmuxMacOS.app"

WEBMUX_NATIVE_REPO_ROOT="$PWD" \
WEBMUX_NATIVE_PROJECT_DIR="$PWD" \
WEBMUX_NATIVE_GHOSTTY_RESOURCES_DIR="$APP_DIR/Contents/Resources/GhosttyResources/share/ghostty" \
"$APP_DIR/Contents/MacOS/WebmuxMacOS"
```

This works because:

- `GhosttyKit` is statically linked into the executable
- Ghostty runtime resources are copied into the bundle
- the repo path is still provided explicitly so the backend sidecar can be launched from the checkout

What this does not do:

- code signing
- notarization
- updater support
- standalone distribution without the repo checkout

If we want a real distributable macOS app later, the next step is to add an actual Xcode app target or dedicated packaging script that embeds config, launcher logic, and signing behavior explicitly.
