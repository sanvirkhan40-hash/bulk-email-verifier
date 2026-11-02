# Patched Reacher backend

Upstream Reacher launches Chrome with hardcoded `--single-process --no-zygote`
flags (see `core/src/smtp/headless.rs`). On many Docker hosts that crashes the
renderer, so every Yahoo / Outlook check fails with:

```
HeadlessError: webdriver returned non-conforming response: String("disconnected")
```

This Dockerfile builds the same image as `backend/Dockerfile` upstream, with
those two flags removed by a source patch. Everything else is unchanged.

## What it contains

1. `alpine/git` — clones the Reacher source at `REACHER_VERSION` and applies two
   source patches. The build fails loudly if either patch stops applying.
2. `messense/rust-musl-cross:x86_64-musl` — builds `reacher_backend`, exactly as
   the upstream Dockerfile does.
3. `zenika/alpine-chrome` + `chromium-chromedriver` — runtime image with Chrome,
   entrypoint still `chromedriver & ./reacher_backend`.

## Patches applied

| File | Change | Fixes |
|---|---|---|
| `core/src/smtp/headless.rs` | removes `--single-process --no-zygote` | `HeadlessError: disconnected` on Yahoo/Outlook |
| `core/src/smtp/yahoo/api.rs` | `patch-yahoo.sed` rewrites the `sessionIndex` extraction | `YahooError: NoSessionIndex` |

Yahoo's signup page no longer renders `<input type="hidden" name="sessionIndex">`.
It now embeds the same value as JSON in a `<script>` block, e.g.
`sessionIndex\":\"QQ--\"`. The old regex could never match it, so every Yahoo
check failed before reaching Yahoo. `patch-yahoo.sed` matches the JSON form; the
regex was verified against the live page (extracts `QQ--`).

Set `RCH__OVERRIDES__YAHOO__TYPE=api` on the service to use the API method
(headless is the default and also works for Outlook).

## Deploying in Coolify

Either point the **existing** Reacher service at this Dockerfile, or - safer -
create a **second** service from it first and test before switching.

- Build pack: **Dockerfile**
- Repository / branch: this repo, `main`
- Dockerfile location: `/reacher-patched/Dockerfile`
- Port: `8080`
- Environment:
  - `RCH__HTTP_HOST=0.0.0.0`
  - `RCH__HEADER_SECRET=<same secret as before>`
  - `RCH__WORKER__ENABLE=false`
  - `RCH__OVERRIDES__HOTMAILB2C__TYPE=headless` (optional; headless is the default)
  - do **not** set `RCH__OVERRIDES__HOTMAILB2C__TYPE=smtp` — that forces the
    port-25 path, which is blocked for this host

First build takes ~15-25 minutes (Rust compile). Later builds are cached.

## Verifying it worked

In the container:

```sh
wget -qO- http://localhost:9515/status          # {"ready": true, ...}
ps aux | grep -E "chromedriver|reacher_backend"
```

Then verify one Outlook address in the app. A good result shows
`"verif_method": {"type": "Headless"}` and no `HeadlessError` in `reacher_raw`.

## Updating

Bump `REACHER_VERSION` to a newer release tag. The patch step fails the build if
upstream changes those lines, which is what you want: check
`core/src/smtp/headless.rs` and adjust the `sed` expression.
