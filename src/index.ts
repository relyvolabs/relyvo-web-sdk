/**
 * Relyvo browser client SDK.
 *
 * The browser holds only short-lived credentials minted by your backend: a
 * Centrifugo connection token for chat and a LiveKit participant token for
 * media. Chat operations travel as RPC frames on the WebSocket, so this SDK
 * never calls Relyvo REST and never needs a CORS allowance.
 *
 * @example
 * ```ts
 * const chat = new RelyvoChat(credentials);
 * await chat.connect();
 * chat.on("message", ({ message }) => console.log(message.content));
 * await chat.send({ content: "hello", clientMessageId: crypto.randomUUID() });
 * ```
 */

export { RelyvoChat } from "./chat.js";
export type {
  CentrifugeClient,
  CentrifugeFactory,
  CentrifugeSubscription,
  RelyvoChatOptions,
} from "./chat.js";
export { RelyvoError, isRelyvoError } from "./errors.js";
export { RelyvoCall } from "./video.js";
export type { RelyvoCallOptions, RoomFactory, RoomLike } from "./video.js";
export type {
  CallCredentials,
  CallEvent,
  ChatChannel,
  ChatCredentials,
  ChatEventHandler,
  ChatMessage,
  ChatMessagePage,
  ChatMessageType,
  ChatUnread,
  MessageEvent,
  TypingEvent,
} from "./types.js";

export const VERSION = "0.1.2";
