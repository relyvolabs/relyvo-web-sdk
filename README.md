# @relyvolabs/web-sdk

Browser client SDK for Relyvo: realtime chat and video calls. The browser holds
only short-lived credentials minted by your backend — never an API key.

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

## Chat runs without REST

Chat operations are RPC frames on the Centrifugo WebSocket the client already
holds:

```
browser ──WS──► Centrifugo ──proxy──► chat-api ──► PostgreSQL
```

`send`, `history`, `markRead` and `channels` all travel this path, so the browser
never calls Relyvo REST and no CORS allowance is required. Identity and project
scope come from the connection token; the SDK never sends a project or user id.

## API

### `new RelyvoChat(credentials, options?)`

| Credential | Meaning |
| --- | --- |
| `wsUrl` | Centrifugo WebSocket URL |
| `token` | Centrifugo connection token |
| `channel` | Conversation channel (`project:<id>:channel:<id>`) |
| `subscriptionToken` | Subscription token for that channel |
| `typingChannel` / `typingSubscriptionToken` | Optional typing sibling |

Methods: `connect()`, `on(event, handler)`, `send()`, `history()`, `markRead()`,
`channels()`, `disconnect()`.

Events: `connected`, `disconnected`, `message`, `typing`, `error`.

### `RelyvoCall.connect({ serverUrl, token }, options?)`

Methods: `enableCamera()`, `enableMicrophone()`, `shareScreen()`, `on(event, handler)`,
`disconnect()`. `call.room` exposes the underlying LiveKit room when you need
something this wrapper does not cover.

Events: `connected`, `disconnected`, `participantConnected`,
`participantDisconnected`, `trackSubscribed`, `trackUnsubscribed`,
`connectionQualityChanged`, `mediaDevicesError`.

## Errors

Every failure is a `RelyvoError` with a stable `code`: transport failures use
`transport_error` / `connect_failed`, and a rejected RPC carries the chat
service's own code (`forbidden`, `not_found`, `rate_limited`, …).

## Requirements

- `centrifuge` and `livekit-client` are peer dependencies; install the versions
  your app already uses so there is one copy of each.
- Video and screen sharing need a secure context (`https://` or `localhost`).

## Status

`0.1.0`: chat (send, history, read, channels, typing) and call connect with
camera/microphone/screen control. Attachments, edits and deletes are not exposed
yet.

## Licence

Proprietary. Not for redistribution.
