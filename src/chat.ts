import { Centrifuge } from "centrifuge";

import { RelyvoError } from "./errors.js";
import type {
  ChatChannel,
  ChatCredentials,
  ChatEventHandler,
  ChatMessage,
  ChatMessagePage,
  MessageEvent,
  TypingEvent,
} from "./types.js";

/** The subset of the Centrifuge client this SDK depends on. */
export interface CentrifugeSubscription {
  subscribe(): Promise<unknown>;
  unsubscribe(): void;
  on(event: "publication" | "subscribed" | "error", handler: (ctx: any) => void): void;
}

export interface CentrifugeClient {
  connect(): void;
  disconnect(): void;
  on(event: "connected" | "disconnected" | "error", handler: (ctx: any) => void): void;
  newSubscription(channel: string, options: { token: string }): CentrifugeSubscription;
  rpc(method: string, data: unknown): Promise<{ data: unknown }>;
}

export type CentrifugeFactory = (wsUrl: string, options: { token: string }) => CentrifugeClient;

const defaultFactory: CentrifugeFactory = (wsUrl, options) =>
  new Centrifuge(wsUrl, { token: options.token }) as unknown as CentrifugeClient;

export interface RelyvoChatOptions {
  /** Injectable transport, used by tests. */
  createCentrifuge?: CentrifugeFactory;
  connectTimeoutMs?: number;
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
  private readonly handlers: { [K in keyof ChatEventHandler]: Set<ChatEventHandler[K]> } = {
    connected: new Set(),
    disconnected: new Set(),
    message: new Set(),
    typing: new Set(),
    error: new Set(),
  };
  private typingSubscription?: CentrifugeSubscription;
  private conversationSubscription?: CentrifugeSubscription;

  constructor(credentials: ChatCredentials, options: RelyvoChatOptions = {}) {
    this.credentials = credentials;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.client = (options.createCentrifuge ?? defaultFactory)(credentials.wsUrl, {
      token: credentials.token,
    });

    this.client.on("connected", () => this.emit("connected"));
    this.client.on("disconnected", (ctx) => this.emit("disconnected", ctx?.reason));
    this.client.on("error", (ctx) =>
      this.emit("error", new RelyvoError("transport_error", String(ctx?.error ?? "connection error"))),
    );
  }

  /** Opens the socket and subscribes to the conversation and typing channels. */
  async connect(): Promise<void> {
    const connected = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new RelyvoError("connect_timeout", "the realtime connection timed out")),
        this.connectTimeoutMs,
      );

      this.handlers.connected.add(() => {
        clearTimeout(timer);
        resolve();
      });
      this.handlers.error.add((error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    this.client.connect();
    await connected;

    this.conversationSubscription = this.client.newSubscription(this.credentials.channel, {
      token: this.credentials.subscriptionToken,
    });
    this.conversationSubscription.on("publication", (ctx) => this.handlePublication(ctx?.data));
    await this.conversationSubscription.subscribe();

    if (this.credentials.typingChannel && this.credentials.typingSubscriptionToken) {
      this.typingSubscription = this.client.newSubscription(this.credentials.typingChannel, {
        token: this.credentials.typingSubscriptionToken,
      });
      this.typingSubscription.on("publication", (ctx) => this.handleTyping(ctx?.data));
      await this.typingSubscription.subscribe();
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

  /** Marks the channel read up to a message. */
  async markRead(messageId: string): Promise<void> {
    await this.rpc("chat.read", { channel_id: this.channelId, message_id: messageId });
  }

  /** Lists the channels this user belongs to. */
  channels(input: { cursor?: string; limit?: number } = {}): Promise<ChatChannel[]> {
    return this.rpc<{ items: ChatChannel[] }>("chat.channels", input).then((page) => page.items ?? []);
  }

  disconnect(): void {
    this.conversationSubscription?.unsubscribe();
    this.typingSubscription?.unsubscribe();
    this.client.disconnect();
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
