import { Centrifuge } from "centrifuge";

import { RelyvoError } from "./errors.js";
import type {
  ChatChannel,
  ChatChannelPage,
  ChatReadState,
  ChatCredentials,
  ChatExtendedEventHandler,
  ChatMessage,
  ChatMessagePage,
  ChatUnread,
  MessageEvent,
  TypingEvent,
} from "./types.js";

/** The subset of the Centrifuge client this SDK depends on. */
export interface CentrifugeSubscription {
  subscribe(): Promise<unknown> | void;
  /** Resolves when the server confirms the subscription, when supported. */
  ready?(timeout?: number): Promise<void>;
  unsubscribe(): void;
  on(event: "publication" | "subscribed" | "subscribing" | "unsubscribed" | "error", handler: (ctx: any) => void): void;
}

/** Centrifuge fetches a replacement token through getToken when one expires. */
export interface ConnectionTokenOptions {
  token?: string;
  getToken?: () => Promise<string>;
}

export interface SubscriptionTokenOptions {
  token?: string;
  getToken?: () => Promise<string>;
}

export interface CentrifugeClient {
  connect(): void;
  disconnect(): void;
  on(event: "connecting" | "connected" | "disconnected" | "error", handler: (ctx: any) => void): void;
  newSubscription(channel: string, options: SubscriptionTokenOptions): CentrifugeSubscription;
  rpc(method: string, data: unknown): Promise<{ data: unknown }>;
}

export type CentrifugeFactory = (wsUrl: string, options: ConnectionTokenOptions) => CentrifugeClient;

const defaultFactory: CentrifugeFactory = (wsUrl, options) =>
  new Centrifuge(wsUrl, {
    token: options.token,
    ...(options.getToken === undefined ? {} : { getToken: options.getToken }),
  }) as unknown as CentrifugeClient;

export interface RelyvoChatOptions {
  /** Injectable transport, used by tests. */
  createCentrifuge?: CentrifugeFactory;
  connectTimeoutMs?: number;
  /**
   * Called when the connection token expires. Return a fresh Centrifugo
   * connection token from your backend; the transport reconnects by itself.
   */
  getConnectionToken?: () => Promise<string>;
  /**
   * Called when a subscription token expires. Receive the channel name and
   * return a fresh subscription token for it.
   */
  getSubscriptionToken?: (channel: string) => Promise<string>;
}

type RpcEnvelope<T> = {
  ok?: boolean;
  data?: T;
  error?: { code?: string; message?: string };
};

/**
 * Realtime chat over the Centrifugo connection.
 *
 * Every operation is an RPC frame on the WebSocket the client already holds, so
 * the browser never calls Relyvo REST and needs no CORS allowance. Identity comes
 * from the connection token; this class never sends a project or user id.
 */
export class RelyvoChat {
  readonly credentials: ChatCredentials;

  private readonly client: CentrifugeClient;
  private readonly connectTimeoutMs: number;
  private readonly getSubscriptionToken?: (channel: string) => Promise<string>;
  private readonly handlers: { [K in keyof ChatExtendedEventHandler]: Set<ChatExtendedEventHandler[K]> } = {
    connected: new Set(),
    disconnected: new Set(),
    message: new Set(),
    messageUpdated: new Set(),
    messageDeleted: new Set(),
    read: new Set(),
    channelCreated: new Set(),
    channelUpdated: new Set(),
    channelDeleted: new Set(),
    memberAdded: new Set(),
    memberRemoved: new Set(),
    typing: new Set(),
    error: new Set(),
  };
  private typingSubscription?: CentrifugeSubscription;
  private conversationSubscription?: CentrifugeSubscription;
  private connecting?: Promise<void>;
  private ready = false;
  private generation = 0;
  private cancelConnect?: (error: RelyvoError) => void;
  private connectionSucceeded?: () => void;
  private transportStarted = false;
  private socketConnected = false;
  private readinessEpoch = 0;
  private subscriptionTerminalEpoch = 0;
  private established = false;

  constructor(credentials: ChatCredentials, options: RelyvoChatOptions = {}) {
    this.credentials = credentials;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.getSubscriptionToken = options.getSubscriptionToken;
    this.client = (options.createCentrifuge ?? defaultFactory)(credentials.wsUrl, {
      token: credentials.token,
      ...(options.getConnectionToken === undefined
        ? {}
        : { getToken: options.getConnectionToken }),
    });

    this.client.on("connecting", () => {
      if (!this.transportStarted) return;
      this.socketConnected = false;
      this.ready = false;
      ++this.readinessEpoch;
    });
    this.client.on("connected", () => {
      if (!this.transportStarted) return;
      this.socketConnected = true;
      this.connectionSucceeded?.();
      this.emit("connected");
    });
    this.client.on("disconnected", (ctx) => {
      this.stop(false);
      this.emit("disconnected", ctx?.reason);
    });
    this.client.on("error", (ctx) => {
      const error = new RelyvoError("transport_error", String(ctx?.error ?? "connection error"));
      this.emit("error", error);
    });
  }

  /** Opens the socket and subscribes to the conversation and typing channels. */
  async connect(): Promise<void> {
    if (this.ready) return;
    if (this.connecting) return this.connecting;
    const generation = ++this.generation;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      this.cancelConnect = reject;
      timer = setTimeout(() => reject(new RelyvoError("connect_timeout", "the realtime connection timed out")), this.connectTimeoutMs);
    });
    // Defer transport callbacks until the shared operation has been installed.
    const operation = Promise.resolve().then(() =>
      this.generation === generation ? this.open(generation, cancelled) : cancelled,
    );
    this.connecting = operation;
    try {
      await operation;
    } finally {
      clearTimeout(timer);
      if (this.generation === generation) {
        this.connecting = undefined;
        this.cancelConnect = undefined;
      }
    }
  }

  private async open(generation: number, cancelled: Promise<never>): Promise<void> {
    try {
      // Observe cancellation even when connect() throws synchronously.
      void cancelled.catch(() => {});
      if (!this.transportStarted) {
        this.transportStarted = true;
        this.client.connect();
      }
      while (true) {
        if (!this.socketConnected) {
          let resolveConnection: () => void = () => {};
          const connected = new Promise<void>((resolve) => { resolveConnection = resolve; this.connectionSucceeded = resolve; });
          await Promise.race([connected, cancelled]);
          if (this.connectionSucceeded === resolveConnection) this.connectionSucceeded = undefined;
        }
        this.assertCurrent(generation);
        if (!this.socketConnected) continue;
        const epoch = this.readinessEpoch;
        const terminalEpoch = this.subscriptionTerminalEpoch;
        if (!this.conversationSubscription) {
          this.conversationSubscription = this.client.newSubscription(
            this.credentials.channel,
            this.subscriptionTokenOptions(this.credentials.channel, this.credentials.subscriptionToken),
          );
          this.watchSubscription(this.conversationSubscription);
          this.conversationSubscription.on("publication", (ctx) => {
            if (this.transportStarted && this.socketConnected) this.handlePublication(ctx?.data);
          });
        }
        try {
          await this.subscribe(this.conversationSubscription, cancelled, generation);
          this.assertCurrent(generation);
          if (this.credentials.typingChannel && this.credentials.typingSubscriptionToken) {
            if (!this.typingSubscription) {
              this.typingSubscription = this.client.newSubscription(
                this.credentials.typingChannel,
                this.subscriptionTokenOptions(this.credentials.typingChannel, this.credentials.typingSubscriptionToken),
              );
              this.watchSubscription(this.typingSubscription);
              this.typingSubscription.on("publication", (ctx) => {
                if (this.transportStarted && this.socketConnected) this.handleTyping(ctx?.data);
              });
            }
            await this.subscribe(this.typingSubscription, cancelled, generation);
            this.assertCurrent(generation);
          }
        } catch (error) {
          this.assertCurrent(generation);
          if (terminalEpoch === this.subscriptionTerminalEpoch && epoch !== this.readinessEpoch) continue;
          throw error;
        }
        if (terminalEpoch !== this.subscriptionTerminalEpoch) {
          throw new RelyvoError("transport_error", "the realtime subscription was refused");
        }
        if (!this.socketConnected || epoch !== this.readinessEpoch) continue;
        this.ready = true;
        this.established = true;
        return;
      }
    } catch (error) {
      if (this.generation === generation && !(this.established && error instanceof RelyvoError && error.code === "connect_timeout")) {
        try { this.disconnect(); } catch { /* Preserve the original connection failure. */ }
      }
      if (error instanceof RelyvoError) throw error;
      throw new RelyvoError("transport_error", "the realtime connection could not be established", error);
    } finally {
      if (this.generation === generation) this.connectionSucceeded = undefined;
    }
  }

  private watchSubscription(subscription: CentrifugeSubscription): void {
    const invalidate = () => {
      this.ready = false;
      ++this.readinessEpoch;
    };
    subscription.on("subscribing", invalidate);
    subscription.on("unsubscribed", (ctx) => {
      invalidate();
      ++this.subscriptionTerminalEpoch;
      if (this.transportStarted) {
        const error = new RelyvoError("transport_error", "the realtime subscription was refused", ctx);
        this.cancelConnect?.(error);
        this.emit("error", error);
      }
    });
  }

  private async subscribe(subscription: CentrifugeSubscription, cancelled: Promise<never>, generation: number): Promise<void> {
    await Promise.race([Promise.resolve(subscription.subscribe()), cancelled]);
    this.assertCurrent(generation);
    if (subscription.ready) {
      await Promise.race([subscription.ready(this.connectTimeoutMs), cancelled]);
    }
  }

  private assertCurrent(generation: number): void {
    if (generation !== this.generation) {
      throw new RelyvoError("disconnected", "the realtime connection was closed");
    }
  }

  on<K extends keyof ChatExtendedEventHandler>(event: K, handler: ChatExtendedEventHandler[K]): () => void {
    this.handlers[event].add(handler);
    return () => this.handlers[event].delete(handler);
  }

  /** Sends a message. The same clientMessageId returns the original message. */
  async send(input: {
    content: string;
    clientMessageId: string;
    type?: string;
    metadata?: Record<string, unknown>;
    replyToMessageId?: string;
    attachmentIds?: string[];
  }): Promise<{ message: ChatMessage; created: boolean }> {
    return this.rpc("chat.send", {
      channel_id: this.channelId,
      client_message_id: input.clientMessageId,
      content: input.content,
      type: input.type ?? "text",
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      ...(input.replyToMessageId === undefined ? {} : { reply_to_message_id: input.replyToMessageId }),
      ...(input.attachmentIds === undefined ? {} : { attachment_ids: input.attachmentIds }),
    });
  }

  /** Reads history with an opaque cursor. `before` remains an alias for compatibility. */
  history(input: { cursor?: string; before?: string; limit?: number; direction?: "before" | "after" } = {}): Promise<ChatMessagePage> {
    const cursor = input.cursor ?? input.before;
    return this.rpc("chat.history", {
      channel_id: this.channelId,
      ...(cursor === undefined ? {} : { cursor }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.direction === undefined ? {} : { direction: input.direction }),
    });
  }

  /** Unread state for this channel, used by channel lists and badges. */
  unread(): Promise<ChatUnread> {
    return this.rpc("chat.unread", { channel_id: this.channelId });
  }

  /** Marks the channel read up to a message. */
  async markRead(messageId: string): Promise<void> {
    await this.markReadWithState(messageId);
  }

  /** Marks the channel read and returns the server's resulting read state. */
  markReadWithState(messageId: string): Promise<ChatReadState> {
    return this.rpc("chat.read", { channel_id: this.channelId, message_id: messageId });
  }

  /** Lists the channels this user belongs to. */
  channels(input: { cursor?: string; limit?: number } = {}): Promise<ChatChannel[]> {
    return this.channelsPage(input).then((page) => page.items ?? []);
  }

  /** Lists channels with their opaque pagination cursor. */
  channelsPage(input: { cursor?: string; limit?: number } = {}): Promise<ChatChannelPage> {
    return this.rpc("chat.channels", input);
  }

  disconnect(): void {
    this.stop(true);
  }

  /** Alias consistent with the other SDK resources. */
  dispose(): void {
    this.disconnect();
  }

  private stop(disconnectClient: boolean): void {
    if (!this.transportStarted && !this.connecting && !this.cancelConnect) return;
    ++this.generation;
    ++this.readinessEpoch;
    this.transportStarted = false;
    this.established = false;
    this.socketConnected = false;
    this.ready = false;
    this.connecting = undefined;
    const cancel = this.cancelConnect;
    this.cancelConnect = undefined;
    this.connectionSucceeded = undefined;
    cancel?.(new RelyvoError("disconnected", "the realtime connection was closed"));
    try {
      this.conversationSubscription?.unsubscribe();
    } finally {
      try {
        this.typingSubscription?.unsubscribe();
      } finally {
        if (disconnectClient) this.client.disconnect();
      }
    }
  }

  /** Channel id extracted from the subscription channel name. */
  private get channelId(): string {
    const parts = this.credentials.channel.split(":");
    const id = parts[parts.length - 1];
    if (!id) {
      throw new RelyvoError("invalid_credentials", "the channel name does not contain an id");
    }
    return id;
  }

  private subscriptionTokenOptions(
    channel: string,
    token: string,
  ): SubscriptionTokenOptions {
    return {
      token,
      ...(this.getSubscriptionToken === undefined
        ? {}
        : { getToken: () => this.getSubscriptionToken!(channel) }),
    };
  }

  private async rpc<T>(method: string, data: unknown): Promise<T> {
    let response: { data: unknown };
    try {
      response = await this.client.rpc(method, data);
    } catch (cause) {
      throw new RelyvoError("transport_error", `rpc ${method} failed`, cause);
    }

    const envelope = response?.data as RpcEnvelope<T> | undefined;
    if (!envelope || envelope.ok !== true) {
      throw new RelyvoError(
        envelope?.error?.code ?? "rpc_failed",
        envelope?.error?.message ?? `rpc ${method} failed`,
      );
    }

    return envelope.data as T;
  }

  private handlePublication(payload: any): void {
    if (!payload || !payload.data || typeof payload.data !== "object") return;
    const data = payload.data;
    const metadata = {
      ...(typeof payload.event_id === "string" ? { eventId: payload.event_id } : {}),
      ...(typeof payload.occurred_at === "string" ? { occurredAt: payload.occurred_at } : {}),
    };
    const eventMetadata = Object.keys(metadata).length ? metadata : undefined;
    if (payload.type === "chat.channel.created" || payload.type === "chat.channel.updated" || payload.type === "chat.channel.deleted") {
      if (data.channel?.id !== this.channelId) return;
      if (payload.type === "chat.channel.created") this.emit("channelCreated", data.channel, eventMetadata);
      else this.emit(payload.type === "chat.channel.updated" ? "channelUpdated" : "channelDeleted", data.channel, eventMetadata);
      return;
    }
    if (data.channel_id !== this.channelId) return;
    if (payload.type === "chat.message.read") {
      if (typeof data.user_id === "string" && typeof data.last_read_seq === "number" && typeof data.last_read_at === "string") this.emit("read", data, eventMetadata);
      return;
    }
    if (payload.type === "chat.channel.member_added" || payload.type === "chat.channel.member_removed") {
      if (!data.member || typeof data.member.id !== "string" || typeof data.role !== "string") return;
      this.emit(payload.type === "chat.channel.member_added" ? "memberAdded" : "memberRemoved", data, eventMetadata);
      return;
    }
    if (payload.type !== "chat.message.created" && payload.type !== "chat.message.updated" && payload.type !== "chat.message.deleted") return;
    if (!data.message || typeof data.message.id !== "string") return;
    const event: MessageEvent = {
      message: data.message,
      channelId: data.channel_id,
      senderId: data.sender?.id ?? data.message.sender_id,
      senderName: data.sender?.display_name,
      ...metadata,
    };
    if (payload.type === "chat.message.created") this.emit("message", event);
    else if (payload.type === "chat.message.updated") this.emit("messageUpdated", event);
    else this.emit("messageDeleted", event);
  }

  private handleTyping(payload: any): void {
    if (!payload || payload.type !== "chat.typing") return;

    const data = payload.data ?? {};
    if (data.channel_id !== this.channelId || !data.user_id) return;

    const event: TypingEvent = {
      channel_id: data.channel_id,
      user_id: data.user_id,
      display_name: data.display_name,
    };
    this.emit("typing", event);
  }

  private emit<K extends keyof ChatExtendedEventHandler>(event: K, ...args: Parameters<ChatExtendedEventHandler[K]>): void {
    for (const handler of this.handlers[event]) {
      (handler as (...values: unknown[]) => void)(...args);
    }
  }
}
