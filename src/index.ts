/**
 * Relyvo browser client SDK.
 *
 * The browser holds only short-lived credentials minted by your backend.
 * Call uses a LiveKit participant token, Chat uses Centrifugo RPC, and Realtime
 * uses a tenant-scoped event credential bundle. The project API key never
 * belongs in browser code.
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
  ChatChannelPage,
  ChatReadState,
  ChatReadEvent,
  ChatMemberEvent,
  ChatCredentials,
  ChatEventHandler,
  ChatExtendedEventHandler,
  ChatEventMetadata,
  ChatMessage,
  ChatMessagePage,
  ChatMessageType,
  ChatUnread,
  MessageEvent,
  TypingEvent,
} from "./types.js";

export * from "./realtime.js";

export const VERSION = "0.2.0";
