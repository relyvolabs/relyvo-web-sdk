import { Centrifuge } from "centrifuge";

import { RelyvoError } from "./errors.js";
import type {
  ChatChannel,
  ChatCredentials,
  ChatEventHandler,
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
  on(event: "publication" | "subscribed" | "error", handler: (ctx: any) => void): void;
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
  on(event: "connected" | "disconnected" | "error", handler: (ctx: any) => void): void;
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
  private readonly handlers: { [K in keyof ChatEventHandler]: Set<ChatEventHandler[K]> } = {
    connected: new Set(),
    disconnected: new Set(),
    message: new Set(),
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
  private connectionFailed?: (error: RelyvoError) => void;

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

    this.client.on("connected", () => {
      this.connectionSucceeded?.();
      this.emit("connected");
    });
    this.client.on("disconnected", (ctx) => {
      this.stop(false);
      this.emit("disconnected", ctx?.reason);
    });
    this.client.on("error", (ctx) => {
      const error = new RelyvoError("transport_error", String(ctx?.error ?? "connection error"));
      this.connectionFailed?.(error);
      this.emit("error", error);
    });
  }

  /** Opens the socket and subscribes to the conversation and typing channels. */
  async connect(): Promise<void> {
    if (this.ready) return;
    if (this.connecting) return this.connecting;
    const generation = ++this.generation;
    const cancelled = new Promise<never>((_, reject) => { this.cancelConnect = reject; });
    // Defer transport callbacks until the shared operation has been installed.
    const operation = Promise.resolve().then(() =>
      this.generation === generation ? this.open(generation, cancelled) : cancelled,
    );
    this.connecting = operation;
    try {
      await operation;
    } finally {
      if (this.generation === generation) {
        this.connecting = undefined;
        this.cancelConnect = undefined;
      }
    }
  }

  private async open(generation: number, cancelled: Promise<never>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connected = new Promise<void>((resolve, reject) => {
      this.connectionSucceeded = resolve;
      this.connectionFailed = reject;
      timer = setTimeout(() => reject(new RelyvoError("connect_timeout", "the realtime connection timed out")), this.connectTimeoutMs);
    });
    try {
      const connection = Promise.race([connected, cancelled]);
      try {
        this.client.connect();
      } catch (error) {
        // The race is already observing cancellation; consume it if connect throws.
        void connection.catch(() => {});
        throw error;
      }
      await connection;
      this.assertCurrent(generation);
      clearTimeout(timer);
      this.connectionSucceeded = undefined;
      this.connectionFailed = undefined;
      if (!this.conversationSubscription) {
        this.conversationSubscription = this.client.newSubscription(
          this.credentials.channel,
          this.subscriptionTokenOptions(this.credentials.channel, this.credentials.subscriptionToken),
        );
        this.conversationSubscription.on("publication", (ctx) => {
          if (this.ready || this.connecting) this.handlePublication(ctx?.data);
        });
      }
      await this.subscribe(this.conversationSubscription, cancelled, generation);
      this.assertCurrent(generation);
      if (this.credentials.typingChannel && this.credentials.typingSubscriptionToken) {
        if (!this.typingSubscription) {
          this.typingSubscription = this.client.newSubscription(
            this.credentials.typingChannel,
            this.subscriptionTokenOptions(this.credentials.typingChannel, this.credentials.typingSubscriptionToken),
          );
          this.typingSubscription.on("publication", (ctx) => {
            if (this.ready || this.connecting) this.handleTyping(ctx?.data);
          });
        }
        await this.subscribe(this.typingSubscription, cancelled, generation);
        this.assertCurrent(generation);
      }
      this.ready = true;
    } catch (error) {
      if (this.generation === generation) {
        try { this.disconnect(); } catch { /* Preserve the original connection failure. */ }
      }
      if (error instanceof RelyvoError) throw error;
      throw new RelyvoError("transport_error", "the realtime connection could not be established", error);
    } finally {
      clearTimeout(timer);
      if (this.generation === generation) {
        this.connectionSucceeded = undefined;
        this.connectionFailed = undefined;
      }
    }
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

  on<K extends keyof ChatEventHandler>(event: K, handler: ChatEventHandler[K]): () => void {
    this.handlers[event].add(handler);
    return () => this.handlers[event].delete(handler);
  }

  /** Sends a message. The same clientMessageId returns the original message. */
  async send(input: {
    content: string;
    clientMessageId: string;
    type?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ message: ChatMessage; created: boolean }> {
    return this.rpc("chat.send", {
      channel_id: this.channelId,
      client_message_id: input.clientMessageId,
      content: input.content,
      type: input.type ?? "text",
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    });
  }

  /** Reads history backwards from a cursor, or forwards with `direction: "after"`. */
  history(input: { before?: string; limit?: number; direction?: "before" | "after" } = {}): Promise<ChatMessagePage> {
    return this.rpc("chat.history", {
      channel_id: this.channelId,
      ...(input.before === undefined ? {} : { cursor: input.before }),
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
    await this.rpc("chat.read", { channel_id: this.channelId, message_id: messageId });
  }

  /** Lists the channels this user belongs to. */
  channels(input: { cursor?: string; limit?: number } = {}): Promise<ChatChannel[]> {
    return this.rpc<{ items: ChatChannel[] }>("chat.channels", input).then((page) => page.items ?? []);
  }

  disconnect(): void {
    this.stop(true);
  }

  private stop(disconnectClient: boolean): void {
    if (!this.ready && !this.connecting && !this.cancelConnect) return;
    ++this.generation;
    this.ready = false;
    this.connecting = undefined;
    const cancel = this.cancelConnect;
    this.cancelConnect = undefined;
    this.connectionSucceeded = undefined;
    this.connectionFailed = undefined;
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
    if (!payload || payload.type !== "chat.message.created") return;

    const data = payload.data ?? {};
    if (data.channel_id !== this.channelId || !data.message) return;

    const event: MessageEvent = {
      message: data.message,
      channelId: data.channel_id,
      senderId: data.sender?.id ?? data.message.sender_id,
      senderName: data.sender?.display_name,
    };
    this.emit("message", event);
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

  private emit<K extends keyof ChatEventHandler>(event: K, ...args: Parameters<ChatEventHandler[K]>): void {
    for (const handler of this.handlers[event]) {
      (handler as (...values: unknown[]) => void)(...args);
    }
  }
}
