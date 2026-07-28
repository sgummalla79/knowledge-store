# Knowledge Store Project Instructions

## App icon: how it's generated

The icon source is a book-stack image composited onto a full-bleed white tile with the
rounded-squircle shape baked directly into the PNG before generating the icon set. **macOS does
NOT auto-round arbitrary square app icons** — that's a common wrong assumption. The OS only
applies its own shadow/rounding treatment in narrow contexts; a plain square source will show
with hard corners in Finder/Dock. The rounding must be baked into the source image itself,
matching Apple's Big Sur icon template (corner radius ≈ 18.1% of the canvas, e.g. ~185px on a
1024px canvas).

To regenerate from a new source image:
1. Composite the artwork onto a 1024x1024 canvas: background fills edge-to-edge, artwork itself
   inset to roughly 60-65% of the canvas (safe zone) so it doesn't look oversized/zoomed-in next
   to other apps' icons.
2. Cut a rounded-rect alpha mask into the whole composited tile (radius ≈ 18% of canvas) so the
   corners are transparent, not just the background color.
3. Run `npx tauri icon <path-to-1024-source.png>` from the repo root.
4. **Delete the iOS/Android assets it generates** — this project is desktop-only:
   `rm -rf src-tauri/icons/android src-tauri/icons/ios src-tauri/gen`.

## Troubleshooting "the Dock icon isn't updating"

Check these **in this order** — the first two are by far the most common cause and are much
cheaper to check than clearing system caches:

1. **Is a stale process still running?** `ps aux | grep knowledge-store`. A Dock icon reflects
   whatever was true when that process *started* — rebuilding files on disk does nothing for an
   already-running instance. This is especially easy to hit after `cargo tauri dev` /
   `npm run tauri dev`, since it's easy to leave that running in a background terminal and forget
   about it while testing a separately-built release `.app`. Kill it (`kill <pid>`) and relaunch
   the actual `.app` you want to test — do not just rebuild.
2. **Are you actually launching the freshly-built `.app`?** Confirm the bundled icon really is
   fresh: `md5 "<app>/Contents/Resources/icon.icns"` vs `md5 src-tauri/icons/icon.icns` — if these
   match, the bundle itself is correct and the problem is purely a display/cache issue (skip to
   step 3); if they don't match, rebuild (`rm -rf src-tauri/target/release/bundle && npm run
   tauri build -- --bundles app` — use `--bundles app` specifically, see note below).
3. **Stale LaunchServices registrations from old DMG builds.** If `tauri.conf.json`'s
   `bundle.targets` includes `dmg`/`all` (the default), every `tauri build` mounts a temporary
   `/Volumes/dmg.XXXXXX/` volume to build the DMG, and macOS can register the app *from that
   ephemeral mount* as a separate LaunchServices entry sharing the same bundle identifier. These
   entries persist in LaunchServices' on-disk database even after the volume unmounts — **a
   machine restart does not clear this**, since it's disk-persisted, not a RAM cache. Check for
   phantom entries and remove them:
   ```bash
   LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister"
   "$LSREGISTER" -dump 2>/dev/null | grep -B15 "com.sgummalla.tauri-app" | grep "^path:"
   # unregister any /Volumes/dmg.* paths found:
   "$LSREGISTER" -u "/Volumes/dmg.XXXXXX/Knowledge Store.app"
   # then re-register the real one:
   "$LSREGISTER" -f "src-tauri/target/release/bundle/macos/Knowledge Store.app"
   ```
   To avoid reintroducing this during iteration, build with `npm run tauri build -- --bundles app`
   (skips the DMG step entirely) rather than the plain `npm run tauri build`.
4. **Only if 1-3 don't resolve it**, clear the icon cache and restart Dock/Finder:
   ```bash
   touch "src-tauri/target/release/bundle/macos/Knowledge Store.app"
   sudo rm -rf /Library/Caches/com.apple.iconservices.store
   killall Dock; killall Finder
   ```

## Bundle identifier

`identifier` in `tauri.conf.json` (`com.sgummalla.tauri-app`) determines where `config.json`
(saved `client_id`/`client_secret`/`refresh_token`) is stored on disk. **Do not change it**
casually as part of a rename/rebrand — doing so makes the app look in a new location and any
already-configured connection will appear to just disappear (it's not deleted, just orphaned at
the old path). `productName`/window `title`/`package.json` name/`Cargo.toml` name are all safe to
rename freely; they don't affect where data is stored.
