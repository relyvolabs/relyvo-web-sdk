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
  edited_at?: string | null;
  deleted_at?: string | null;
  attachment_ids?: string[];
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
  organization_id?: string;
  project_id?: string;
  description?: string;
  created_by?: string;
  metadata?: Record<string, unknown> | null;
  last_message_id?: string | null;
  max_members?: number;
  external_id?: string;
  source_product?: string;
  sending_enabled?: boolean;
  created_at?: string;
  updated_at?: string;
  deleted_at?: string | null;
  membership_role?: string;
}

/** Durable delivery metadata, when supplied by the backend. */
export interface ChatEventMetadata {
  eventId?: string;
  occurredAt?: string;
}

export interface ChatChannelPage {
  items: ChatChannel[];
  has_more: boolean;
  next_cursor?: string;
}

export interface ChatReadState {
  organization_id: string;
  project_id: string;
  channel_id: string;
  user_id: string;
  last_read_message_id?: string | null;
  last_read_seq: number;
  last_read_at: string;
  updated_at: string;
}

export interface ChatReadEvent {
  channel_id: string;
  user_id: string;
  last_read_message_id?: string | null;
  last_read_seq: number;
  last_read_at: string;
}

export interface ChatMemberEvent {
  channel_id: string;
  member: { id: string; external_user_id: string; display_name: string };
  role: string;
  left_at?: string;
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
  /** Durable event metadata for deduplication when present. */
  eventId?: string;
  occurredAt?: string;
}

/** Original handler map retained for source compatibility. */
export type ChatEventHandler = {
  connected: () => void;
  disconnected: (reason?: string) => void;
  message: (event: MessageEvent) => void;
  typing: (event: TypingEvent) => void;
  error: (error: Error) => void;
};

/** All events accepted by RelyvoChat.on, including additive lifecycle events. */
export type ChatExtendedEventHandler = ChatEventHandler & {
  messageUpdated: (event: MessageEvent) => void;
  messageDeleted: (event: MessageEvent) => void;
  read: (event: ChatReadEvent, metadata?: ChatEventMetadata) => void;
  channelCreated: (channel: ChatChannel, metadata?: ChatEventMetadata) => void;
  channelUpdated: (channel: ChatChannel, metadata?: ChatEventMetadata) => void;
  channelDeleted: (channel: ChatChannel, metadata?: ChatEventMetadata) => void;
  memberAdded: (event: ChatMemberEvent, metadata?: ChatEventMetadata) => void;
  memberRemoved: (event: ChatMemberEvent, metadata?: ChatEventMetadata) => void;
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
