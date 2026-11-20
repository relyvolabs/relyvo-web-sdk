# Changelog

## 0.2.0 — 2026-11-20

- Add the canonical Realtime browser client, including named-event subscriptions,
  lifecycle and credential refresh, via a generated, provenance-checked snapshot.
- Add isolated `call`, `chat`, and `realtime` subpath exports for ESM, CommonJS,
  and their corresponding TypeScript declarations.
- Improve Chat and Call lifecycle cleanup and add regression coverage.
- Expose read-only Call participant/connection accessors, device listing/switching and a `dispose()` alias.
- Add paginated Chat channel results, read-state returns, reply and completed-attachment references, and channel/member/message/read event callbacks with delivery metadata.
- Preserve subscriptions through transient Chat and Realtime reconnects; clean up on terminal disconnect or subscription denial.
- Forward the explicit media-device permission preference to LiveKit.
- Document server SDK credential mapping and snapshot maintenance.
