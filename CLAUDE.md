# Knowledge Store Project Instructions

## What this project is

A Tauri (Rust backend + vanilla TypeScript frontend, no framework) desktop app for managing
knowledge libraries against **knowledge-api** — create libraries, upload documents, and browse
everything. It authenticates to knowledge-api as a registered OAuth2 Application (see
knowledge-api's CLAUDE.md for the auth model), the same way the MCP server does, just with a
broader scope since this is the admin/management UI, not a narrow search client. Embeddings
provider config and search-tuning settings used to live here too (an "Embeddings" sidebar page);
both moved to knowledge-api's own `/dashboard` — see session history item 9.

Key modules: `src/main.ts` (all page logic/DOM wiring), `src/shell.ts` (window chrome + sidebar
nav, deliberately decoupled from page logic — announces view switches via a `view-changed`
CustomEvent rather than knowing what any page does), `src-tauri/src/oauth_client.rs` (token
cache/refresh logic), `src-tauri/src/api_client.rs` (Tauri commands, one per knowledge-api
endpoint, all routed through a shared `send_with_retry` helper for auth-header + retry-on-401),
`src-tauri/src/config.rs` (`config.json` read/write via Tauri's `app_config_dir()`).

## Session history — what's been built (in build order)

1. **Base app** (first commit): library CRUD, document upload, embeddings settings, static
   `API_KEY` auth via a header field in the Connection card.
2. **OAuth2 client auth** (`oauth_client.rs`, new): replaced the static API key entirely.
   `authenticate` Tauri command runs a `client_credentials` exchange (requesting
   `KNOWLEDGE_STORE_SCOPE` — effectively the full scope set, since this is the admin UI) the
   moment the Connection form is saved, rather than waiting for the first incidental API call to
   trigger it. Access token cached in memory (`TokenState`, cleared on restart); refresh token
   persisted to `config.json` since `offline_access` is always requested. `send_with_retry`
   invalidates the cached token and retries once on an unexpected 401.
3. **Connection UI reworked around this**: Client ID/Secret fields replace the old API Key field;
   once a connection is verified working (not just saved — actually round-tripped through
   `list_libraries`), the Client Secret field disappears (it's write-only, never re-displayed —
   matches knowledge-api's own "shown once" convention) and a **Disconnect** button appears
   (clears credentials + cached token via a `disconnect` command, returns to "not configured").
4. **Windows titlebar fix**: the custom drag-region/collapse-toggle CSS was hardcoded against
   macOS's overlay-titlebar traffic-light geometry. A synchronous UA-sniff script in `index.html`
   (before first paint) tags `<html>` with `platform-windows`, and `styles.css` scopes
   Windows-only overrides under that class — macOS's layout is completely unaffected since the
   class is simply never added there.
5. **Create-library form simplified**: removed the per-library embedding-model/chunk-size/
   chunk-overlap fields (now just Name/Description), matching knowledge-api's move to
   global-only chunking/embedding config (its migration `0005`). Those settings now live in the
   Embeddings card instead.
6. **Rebranded rag-desktop → Knowledge Store**: `productName`/window title/`package.json`/
   `Cargo.toml` names, and the repo directory itself, all renamed. The Tauri **bundle identifier**
   (`com.sgummalla.tauri-app`) was deliberately left unchanged — see that section below, don't
   "finish the rename" by changing it.
7. **App icon**: book-stack image, iterated through several backgrounds (white tile → black tile
   → white rounded tile → fully transparent) before landing on genuinely transparent, near-full-
   bleed — see the icon section below for what was actually learned along the way (worth reading
   before touching the icon again, several attempts silently regressed earlier fixes).
8. **Connection refresh button**: a manual retry (spinning icon, next to the Knowledge API badge)
   plus auto-refresh whenever the Configuration tab is opened — solves "I started the desktop app
   before the API's Docker container, and there was no way to reconnect short of a full restart."
   Both reuse one `refreshConnection()` (replacing logic that used to only run once, in `init()`).
9. **Embeddings page removed**: the "Embeddings" sidebar page (provider/model/dimensions/
   chunk-size config, plus a "Search Settings" card for hybrid-retrieval tuning that had ridden
   along on the same page) was deleted entirely — both are moving to knowledge-api's own
   `/dashboard` instead. Removed: the sidebar nav item and `view-embeddings` section
   (`index.html`); all embeddings/search-settings state, gating, and form-handling code in
   `main.ts` (including `refreshConnection()`, folded into `checkStatusAndLoad()` since nothing
   else was left in it); the `get_embedding_options`/`list_embedding_models`/
   `get_embedding_settings`/`save_embedding_settings`/`clear_embedding_settings`/
   `get_search_settings`/`save_search_settings` Tauri commands (`api_client.rs`, `lib.rs`); and the
   corresponding `embedding_settings:*`/`search_settings:*` scopes from `KNOWLEDGE_STORE_SCOPE`
   (`oauth_client.rs`) — this app no longer requests or touches either resource.

## Not yet done / things to know for next session

- No Application is necessarily registered/connected as of end-of-session — if the Connection
  card shows "Not configured," register an application in knowledge-api's `/dashboard` (broad
  scope, e.g. everything except leave `offline_access` on) and paste its client_id/secret in.
- This app has **only ever been tested as a locally-built macOS `.app`**, launched via `npm run
  tauri build -- --bundles app` (not the default `npm run tauri build`, which also builds a DMG —
  see the LaunchServices note below for why that matters) or via `cargo tauri dev`. It has not
  been built or tested on Windows — the Windows titlebar fix (item 4 above) is implemented and
  type-checked but unverified on real Windows.
- If icon/Dock weirdness comes up again, check the troubleshooting order below **before**
  reaching for cache-clearing commands — the actual cause has twice now been a stale running
  process (`cargo tauri dev` or an old release build) rather than anything wrong with the built
  bundle itself.

## App icon: how it's generated

**Current approach: genuinely transparent background, no tile.** The icon source is the
book-stack artwork alone, composited onto a fully transparent 1024x1024 canvas with **no fill
color anywhere** — verify with `img.getpixel((5,5))` on the generated PNG; it must read
`(0, 0, 0, 0)`, not `(255, 255, 255, 255)`.

Two things learned the hard way while landing on this:

- **Centering must account for the source's drop shadow.** The clipart's shadow is soft/low-alpha
  and extends further right+down than left+up, so naively centering the full image's bounding box
  visually shifts the *books* off-center. Fix: threshold the alpha channel (`alpha > 120`) to find
  the bbox of the solid artwork only, compute its center, then paste the **full** original image
  (shadow included, for depth) offset so that computed center lands on the canvas center — not
  the naive full-image-bbox center.
- **The glyph must be sized close to full-bleed (~90-92% of the canvas) or macOS auto-inserts its
  own white backing plate.** A smaller glyph with generous transparent margin around it reads to
  macOS as "not a complete icon," and it silently composites a white rounded-square plate behind
  it — which looks identical to the icon just having a white background again, defeating the
  point. This is *not* controllable from the source file once triggered; the fix is making the
  source full-bleed enough that macOS has no margin to insert a plate into.

(An earlier iteration baked a **white** rounded-rect tile directly into the source, with the
squircle shape cut in via an alpha mask at ~18.1% corner radius, matching Apple's Big Sur
template — since macOS does *not* auto-round arbitrary square icons on its own. That approach is
still valid if a white/colored tile is ever wanted again; it's just not what's currently shipped.)

To regenerate from a new source image (current transparent approach):
1. Composite the artwork onto a fully transparent 1024x1024 canvas at ~90-92% fill, centered on
   the solid-artwork bbox (see above), not the naive image bbox.
2. Run `npx tauri icon <path-to-1024-source.png>` from the repo root.
3. **Delete the iOS/Android assets it generates** — this project is desktop-only:
   `rm -rf src-tauri/icons/android src-tauri/icons/ios src-tauri/gen`.
4. Verify before rebuilding: check a corner pixel and an edge-midpoint pixel of the generated
   `icon.png` are both `(0, 0, 0, 0)` — confirms no fill snuck back in.

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

## Versioning & release workflow

**This applies from any machine — it's not tied to local git config.** The app version is
tracked in four places that must always be kept in sync: the root `VERSION` file (single source
of truth) plus `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` (Tauri
requires the version duplicated into these; there's no single-file config it reads from). Current
release: **1.0.0**, tracked on branch `releases/v1`.

**Branch model:** each major version gets a long-lived `releases/vN` branch (currently just
`releases/v1`; a future breaking/major change gets `releases/v2` cut from `master` the same way).

**Never commit directly to `releases/v1` or `master` — no exceptions.** Both are GitHub
branch-protected (PR required, direct pushes rejected by GitHub itself, not just a convention) —
see "Branch protection" below. All work, fixes and features alike, happens on a short-lived branch
cut from `releases/v1`, opened as a PR back into `releases/v1`, and merged once verified. `master`
only moves via PR/cherry-pick from a release branch; nothing originates there.

**Workflow — follow this exactly, every change, no exceptions:**
1. Branch off `releases/v1` (or the relevant `releases/vN`) for the change.
2. Make the change on that branch.
3. Before committing, if it's a bug fix, bump the **patch** number (`X.Y.Z` → `X.Y.Z+1`) in all
   four version locations (`VERSION`, `package.json`, `Cargo.toml`, `tauri.conf.json`) and include
   that bump in the same commit as the fix. Minor (`Y`) is for new features, major (`X`) is for
   breaking changes — routine bug fixes touch neither.
4. Push the branch, open a PR into `releases/vN`, and test it.
5. Once verified, merge the PR into `releases/vN`.
6. Cherry-pick the fix commit (version bump included) from `releases/vN` onto a new branch cut
   from `master`, then open a PR from that branch into `master` (it's protected too — no direct
   push, see below). Merge once green, so `master` always carries every shipped fix even though
   it isn't itself a release branch.

## Branch protection

`master` and `releases/v1` (and any future `releases/vN`) are GitHub branch-protected:
direct pushes are rejected, changes must go through a PR. No required approvals are configured
(solo repo — self-merge is fine), but force-pushes and deletions of these branches are also
blocked. If a new `releases/vN` branch is ever cut, apply the same protection to it immediately —
it doesn't inherit automatically:
```bash
gh api -X PUT repos/sgummalla79/knowledge-store/branches/<branch>/protection \
  -H "Accept: application/vnd.github+json" \
  -f required_status_checks='null' \
  -f enforce_admins=true \
  -f required_pull_request_reviews.required_approving_review_count=0 \
  -f restrictions='null' \
  -f allow_force_pushes=false \
  -f allow_deletions=false
```

## Bundle identifier

`identifier` in `tauri.conf.json` (`com.sgummalla.tauri-app`) determines where `config.json`
(saved `client_id`/`client_secret`/`refresh_token`) is stored on disk. **Do not change it**
casually as part of a rename/rebrand — doing so makes the app look in a new location and any
already-configured connection will appear to just disappear (it's not deleted, just orphaned at
the old path). `productName`/window `title`/`package.json` name/`Cargo.toml` name are all safe to
rename freely; they don't affect where data is stored.
