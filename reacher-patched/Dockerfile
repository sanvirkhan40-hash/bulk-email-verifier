# Patched Reacher backend image.
#
# Same build as upstream backend/Dockerfile, except the hardcoded Chrome flags
# --single-process and --no-zygote are removed from core/src/smtp/headless.rs.
# Those flags crash the renderer on common Docker hosts, which makes every
# Yahoo / Outlook (Hotmail B2C) check fail with HeadlessError "disconnected".
# Upstream issue: https://github.com/reacherhq/check-if-email-exists/issues/1598

ARG REACHER_VERSION=v0.11.11

# ---------------------------------------------------------------------------
# 1. Source + patch
# ---------------------------------------------------------------------------
FROM alpine/git:latest AS source

ARG REACHER_VERSION
WORKDIR /src

RUN git clone --depth 1 --branch "${REACHER_VERSION}" \
        https://github.com/reacherhq/check-if-email-exists.git reacher

# Drop the two flags. The build fails if upstream reformats those lines, rather
# than silently shipping an unpatched binary.
RUN cd reacher \
    && sed -i 's/"--single-process", "--no-zygote",//' core/src/smtp/headless.rs \
    && if grep -q '"--single-process"' core/src/smtp/headless.rs; then \
         echo "ERROR: patch did not apply - check core/src/smtp/headless.rs"; exit 1; \
       fi \
    && echo "Patched: --single-process / --no-zygote removed"

# ---------------------------------------------------------------------------
# 2. Compile (identical to upstream)
# ---------------------------------------------------------------------------
FROM messense/rust-musl-cross:x86_64-musl AS cargo-build

WORKDIR /usr/src/reacher

COPY --from=source /src/reacher .

ENV SQLX_OFFLINE=true

RUN rm -f target/x86_64-unknown-linux-musl/release/deps/reacher*

RUN cargo build --bin reacher_backend --release --target=x86_64-unknown-linux-musl

# ---------------------------------------------------------------------------
# 3. Runtime (Chrome + chromedriver, same entrypoint as upstream)
# ---------------------------------------------------------------------------
FROM zenika/alpine-chrome:123

WORKDIR /home/reacher/

USER root

RUN apk add --no-cache chromium-chromedriver

COPY --from=cargo-build /usr/src/reacher/target/x86_64-unknown-linux-musl/release/reacher_backend .
COPY --from=cargo-build /usr/src/reacher/backend/docker.sh .
COPY --from=cargo-build /usr/src/reacher/backend/backend_config.toml .

RUN chown chrome:chrome reacher_backend docker.sh

USER chrome

ENV RUST_LOG=reacher=info
ENV RCH__HTTP_HOST=0.0.0.0
ENV RCH__WORKER__ENABLE=false

EXPOSE 8080

ENTRYPOINT []
CMD ["./docker.sh"]
