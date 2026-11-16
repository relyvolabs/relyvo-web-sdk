export type ChatMessageType = "text" | "system" | "attachment";

export interface ChatMessage {
  id: string;
  channel_id: string;
  channel_seq: number;
  sender_id: string;
  client_message_id?: string;
  type: ChatMessageType;
  content: string;
  metadata?: Record<string, unknown> | null;
  reply_to_message_id?: string | null;
  created_at: string;
  updated_at?: string;
  deleted_at?: string | null;
}

export interface ChatMessagePage {
  items: ChatMessage[];
  has_more: boolean;
  next_cursor?: string;
}

export interface ChatUnread {
  channel_id: string;
  last_seq: number;
  last_read_seq: number;
  unread_count: number;
  has_unread: boolean;
}

export interface ChatChannel {
  id: string;
  type: string;
  name: string;
  last_seq: number;
  external_id?: string;
}

/** Credentials your backend mints with the Relyvo server SDK. */
export interface ChatCredentials {
  /** Centrifugo WebSocket URL, e.g. wss://chat.example.com/connection/websocket */
  wsUrl: string;
  /** Centrifugo connection token for this user. */
  token: string;
  /** Conversation channel, e.g. project:<projectID>:channel:<channelID> */
  channel: string;
  /** Subscription token for the conversation channel. */
  subscriptionToken: string;
  /** Optional sibling channel that carries typing events. */
  typingChannel?: string;
  /** Subscription token for the typing channel. */
  typingSubscriptionToken?: string;
}

export interface CallCredentials {
  /** Browser-facing LiveKit URL, e.g. wss://rtc.example.com */
  serverUrl: string;
  /** Short-lived participant token minted by your backend. */
  token: string;
}

export interface TypingEvent {
  channel_id: string;
  user_id: string;
  display_name?: string;
}

export interface MessageEvent {
  message: ChatMessage;
  senderId: string;
  senderName?: string;
  channelId: string;
}

export type ChatEventHandler = {
  connected: () => void;
  disconnected: (reason?: string) => void;
  message: (event: MessageEvent) => void;
  typing: (event: TypingEvent) => void;
  error: (error: Error) => void;
};

export type CallEvent =
  | "connected"
  | "disconnected"
  | "participantConnected"
  | "participantDisconnected"
  | "trackSubscribed"
  | "trackUnsubscribed"
  | "connectionQualityChanged"
  | "mediaDevicesError";
