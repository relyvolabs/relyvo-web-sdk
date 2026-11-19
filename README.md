# @relyvolabs/web-sdk

Browser client SDK for Relyvo: Call, Chat and Realtime. The browser holds only
short-lived credentials minted by your backend — never an API key.

Use the independent subpaths to keep unrelated product dependencies out of a
bundle:

```ts
import { RelyvoCall } from "@relyvolabs/web-sdk/call";
import { RelyvoChat } from "@relyvolabs/web-sdk/chat";
import { RelyvoRealtime } from "@relyvolabs/web-sdk/realtime";
```

The root export remains available for compatibility:

```ts
import { RelyvoChat, RelyvoCall } from "@relyvolabs/web-sdk";

const chat = new RelyvoChat(credentials);
await chat.connect();
chat.on("message", ({ message, senderName }) => render(message, senderName));
await chat.send({ content: "hello", clientMessageId: crypto.randomUUID() });

const call = await RelyvoCall.connect({ serverUrl, token });
await call.enableCamera();
await call.enableMicrophone();
```

Your backend creates both credential sets with
[`relyvo-server-sdk`](https://github.com/relyvolabs/relyvo-server-sdk):

| Feature | Server-side call | What the browser receives |
| --- | --- | --- |
| Video | `video.createToken(...)` | `serverUrl` + participant `token` |
| Chat | `chat.upsertUser`, `chat.createUserToken`, realtime tokens | `wsUrl`, connection `token`, `channel`, `subscriptionToken` (+ typing channel) |
| Realtime | `realtime.createClientToken` | `ws_url`, `connection_token`, per-channel subscription tokens |

## Realtime named events

Import from the root or `@relyvolabs/web-sdk/realtime`. `getCredentials` must
call your backend, which mints short-lived credentials via
`POST /v1/realtime/client-tokens`; never put a project API key in the browser.

```ts
import { RelyvoRealtime } from "@relyvolabs/web-sdk/realtime";
const realtime = new RelyvoRealtime({
  getCredentials: async () => {
    const response = await fetch("/api/realtime/credentials");
    if (!response.ok) throw new Error("credentials unavailable");
    return response.json();
  },
});
await realtime.connect();
const channel = await realtime.subscribe("private-orders.123");
channel.on("order.updated", (payload, meta) => console.log(payload, meta));
await realtime.unsubscribe("private-orders.123");
await realtime.disconnect();
```

Credentials contain `ws_url`, `connection_token`, `expires_at`, and `channels`
entries with `channel`, tenant-scoped `internal_channel`, `type`,
`subscription_token`, and `expires_at`. Refresh uses the same callback. Events
are ephemeral and delivery or processing is not guaranteed. The `call`, `chat`,
and `realtime` subpaths avoid loading unrelated feature dependencies.

If your backend uses the TypeScript server SDK, its `createClientToken()` result
uses camelCase properties and `Date` values, unlike the Realtime wire format.
Map it on the server before returning JSON (authenticate the request and authorize
the requested user and channels there):

```ts
const token = await sdk.realtime.createClientToken({ userId, channels });
const credentials = {
  ws_url: token.wsUrl,
  connection_token: token.connectionToken,
  expires_at: token.expiresAt.toISOString(),
  channels: token.channels.map((channel) => ({
    channel: channel.channel,
    internal_channel: channel.internalChannel,
    type: channel.type,
    subscription_token: channel.subscriptionToken,
    expires_at: channel.expiresAt.toISOString(),
  })),
};
// Return credentials as JSON from your authenticated backend endpoint.
```

### Snapshot maintenance

Realtime code under `src/vendor/realtime` is generated, never independently
edited. `pnpm realtime:check` verifies the checked-in files against their SHA-256
manifest without a sibling checkout. `pnpm realtime:update` reads the sibling
`../relyvo-realtime/sdk/javascript/src`, records the upstream Git base commit,
working-tree dirty state and exact file hashes, and updates the snapshot;
`pnpm realtime:check-upstream` also compares the sibling. A dirty source records
its base commit rather than claiming the changes are in that commit. Review and
run tests after updating; normal builds and npm consumers need no sibling repo.

## Chat runs without REST

Chat operations are RPC frames on the Centrifugo WebSocket the client already
holds:

```
browser ──WS──► Centrifugo ──proxy──► chat-api ──► PostgreSQL
```

`send`, `history`, `markRead` and `channels` all travel this path, so the browser
never calls Relyvo REST and no REST CORS allowance is required. WebSocket origin
restrictions still apply. Identity and project scope come from the connection
token; the SDK never sends a project or user id.

## API

### `new RelyvoChat(credentials, options?)`

| Credential | Meaning |
| --- | --- |
| `wsUrl` | Centrifugo WebSocket URL |
| `token` | Centrifugo connection token |
| `channel` | Conversation channel (`project:<id>:channel:<id>`) |
| `subscriptionToken` | Subscription token for that channel |
| `typingChannel` / `typingSubscriptionToken` | Optional typing sibling |

Methods: `connect()`, `on(event, handler)`, `send()`, `history()`, `unread()`,
`markRead()`, `markReadWithState()`, `channels()`, `channelsPage()`,
`disconnect()`, `dispose()` (alias). `channels()` retains its array result;
`channelsPage({ cursor, limit })` returns `items`, `has_more`, and `next_cursor`.
`send()` accepts optional `replyToMessageId` and `attachmentIds`; attachment IDs
must already have been uploaded and completed via an authorized backend flow.
The WebSocket RPC does not upload files, send typing, or edit/delete messages.

### Token refresh

Connection and subscription tokens are short-lived. Give the SDK callbacks that
ask your backend for replacement tokens; the transport reconnects on its own.

```ts
const chat = new RelyvoChat(credentials, {
  getConnectionToken: async () => {
    const response = await fetch("/api/chat/token");
    return (await response.json()).token;
  },
  getSubscriptionToken: async (channel) => {
    const response = await fetch(`/api/chat/subscription?channel=${encodeURIComponent(channel)}`);
    return (await response.json()).token;
  },
});
```

The callbacks run when a token expires, never before, and they must reach a
server: a browser cannot mint these tokens.

Events: `connected`, `disconnected`, `message`, `messageUpdated`,
`messageDeleted`, `read`, `channelCreated`, `channelUpdated`, `channelDeleted`, `memberAdded`,
`memberRemoved`, `typing`, `error`. These are scoped to the subscribed
conversation; channel creation can occur before subscription. Deletion events
carry the pre-deletion object; use the event name as the deletion signal. For a
message deletion, `senderId`/`senderName` can identify the moderator who deleted
it rather than the original author; use `message.sender_id` for the author. A
read event's message ID can be the requested ID even when the cursor did not
advance. Durable deliveries may be repeated and can arrive out of order. Message
callbacks receive optional `eventId` and `occurredAt` fields; read, channel and
member callbacks receive optional metadata as their second argument. Use the event
ID to deduplicate and reconcile authoritative history/state after reconnect; do
not assume timestamps guarantee ordering.

Chat coalesces concurrent `connect()` calls; `disconnect()` cancels an in-flight
connection and cleans up its subscriptions. `dispose()` is an alias.

### `RelyvoCall.connect({ serverUrl, token }, options?)`

Methods: `enableCamera()`, `enableMicrophone()`, `shareScreen()`, `listDevices()`,
`switchDevice()`, `on(event, handler)`, `disconnect()`, `dispose()` (alias). `call.room` exposes the underlying LiveKit
room when you need something this wrapper does not cover. `isConnected`,
`localParticipant`, and `remoteParticipants` expose read-only connection and
participant state; remote identities are not an authorization source.

Events: `connected`, `disconnected`, `participantConnected`,
`participantDisconnected`, `trackSubscribed`, `trackUnsubscribed`,
`connectionQualityChanged`, `mediaDevicesError`.

## Errors

Every failure is a `RelyvoError` with a stable `code`: transport failures use
`transport_error` / `connect_failed`, and a rejected RPC carries the chat
service's own code (`forbidden`, `not_found`, `rate_limited`, …).

## Requirements

- `centrifuge` and `livekit-client` are runtime dependencies. Feature subpaths
  avoid loading the unrelated transport.
- Video and screen sharing need a secure context (`https://` or `localhost`).

## Status

`0.2.0`: Realtime named-event subscriptions, chat (send, history, read,
channels, typing), and call connect with camera/microphone/screen control.
Attachments, edits and deletes are not exposed yet.

## Licence

Proprietary. Not for redistribution.
