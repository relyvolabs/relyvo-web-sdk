/**
 * Relyvo Realtime browser client.
 *
 * The browser never holds a project API key: `getCredentials` asks your backend,
 * which calls POST /v1/realtime/client-tokens with its server-side key and
 * returns short-lived connection/subscription tokens.
 */
import { Centrifuge } from "centrifuge";

import type {
  ChannelCredentials,
  ChannelType,
  ClientCredentials,
  RealtimeEvent,
  RealtimeStatus,
  RelyvoRealtimeOptions,
  TransportClient,
  TransportSubscription,
} from "./types.js";

export type * from "./types.js";

export class RelyvoRealtimeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RelyvoRealtimeError";
    this.code = code;
  }
}

type Publication = {
  event?: string;
  data?: unknown;
  event_id?: string;
  published_at?: string;
};

type Handler = (payload: unknown, meta: { event: string; eventId?: string; publishedAt?: string }) => void;
type StateHandler = (payload?: unknown) => void;

function defaultCreateClient(
  url: string,
  options: { token: string; getToken: () => Promise<string> },
): TransportClient {
  return new Centrifuge(url, options) as unknown as TransportClient;
}

/** One subscribed channel. Listeners are de-duplicated per function. */
export class RealtimeChannel {
  readonly name: string;
  readonly type: ChannelType;

  private readonly transport: TransportSubscription;
  private readonly listeners = new Map<string, Set<Handler>>();
  private publishing = false;
  private active = true;

  constructor(name: string, type: ChannelType, transport: TransportSubscription, private readonly onClose?: () => void) {
    this.name = name;
    this.type = type;
    this.transport = transport;
  }

  get subscribed(): boolean {
    return this.active;
  }

  /** Registers a named-event handler. Returns an unsubscribe function. */
  on(event: string, handler: Handler): () => void {
    const handlers = this.listeners.get(event) ?? new Set<Handler>();
    handlers.add(handler);
    this.listeners.set(event, handlers);
    this.attach();

    return () => this.off(event, handler);
  }

  off(event: string, handler?: Handler): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    if (handler) handlers.delete(handler);
    else handlers.clear();
    if (handlers.size === 0) this.listeners.delete(event);
  }

  private attach(): void {
    if (this.publishing) return;
    this.publishing = true;
    this.transport.on("publication", (ctx: { data?: Publication }) => {
      const publication = ctx.data;
      if (!this.active || !publication?.event) return;
      const handlers = this.listeners.get(publication.event);
      if (!handlers) return;
      for (const handler of [...handlers]) {
        handler(publication.data, {
          event: publication.event,
          ...(publication.event_id === undefined ? {} : { eventId: publication.event_id }),
          ...(publication.published_at === undefined ? {} : { publishedAt: publication.published_at }),
        });
      }
    });
  }

  /** Detaches the transport subscription; the channel cannot be reused. */
  close(): void {
    if (!this.active) return;
    this.active = false;
    this.listeners.clear();
    try {
      this.transport.unsubscribe();
    } finally {
      this.onClose?.();
    }
  }
}

/**
 * Owns one WebSocket connection and its subscriptions.
 *
 * centrifuge-js performs reconnect with backoff and jitter; this class supplies
 * fresh tokens through `getCredentials` so a reconnect after the token lifetime
 * still succeeds.
 */
export class RelyvoRealtime {
  private readonly options: RelyvoRealtimeOptions;
  private readonly channels = new Map<string, RealtimeChannel>();
  private readonly pending = new Map<string, { promise: Promise<RealtimeChannel>; cancel: () => void; cancelled: boolean }>();
  private readonly stateHandlers = new Map<RealtimeEvent, Set<StateHandler>>();
  private client: TransportClient | null = null;
  private credentials: ClientCredentials | null = null;
  private currentStatus: RealtimeStatus = "idle";
  private connectPromise: Promise<void> | null = null;
  private cancelConnect: (() => void) | null = null;
  private reconnectWait: { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } | null = null;
  private generation = 0;

  constructor(options: RelyvoRealtimeOptions) { this.options = options; }
  get status(): RealtimeStatus { return this.currentStatus; }

  on(event: RealtimeEvent, handler: StateHandler): () => void {
    const handlers = this.stateHandlers.get(event) ?? new Set<StateHandler>();
    handlers.add(handler);
    this.stateHandlers.set(event, handlers);
    return () => { handlers.delete(handler); };
  }

  private cancelled(): RelyvoRealtimeError {
    return new RelyvoRealtimeError("disconnected", "The realtime operation was cancelled.");
  }

  async connect(): Promise<void> {
    if (this.currentStatus === "connected") return;
    if (this.connectPromise) return this.connectPromise;
    // A live client in connecting state is already reconnecting automatically.
    if (this.client && this.currentStatus === "connecting") return this.waitForReconnect();
    const generation = ++this.generation;
    this.setStatus("connecting");
    let rejectCancel!: (error: Error) => void;
    const cancellation = new Promise<never>((_, reject) => { rejectCancel = reject; });
    const cancel = () => rejectCancel(this.cancelled());
    this.cancelConnect = cancel;
    const work = (async () => {
      let client: TransportClient | null = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const credentials = await Promise.race([this.options.getCredentials(), cancellation]);
        if (generation !== this.generation) throw this.cancelled();
        this.credentials = credentials;
        const url = this.options.wsUrl ?? credentials.ws_url;
        client = (this.options.createClient ?? defaultCreateClient)(url, {
          token: credentials.connection_token,
          getToken: () => this.refresh(generation).then((fresh) => fresh.connection_token),
        });
        this.client = client;
        const current = () => this.generation === generation && this.client === client;
        await Promise.race([new Promise<void>((resolve, reject) => {
          timer = setTimeout(() => reject(new RelyvoRealtimeError("connect_timeout", "The realtime connection did not open in time.")), 10_000);
          client!.on("connected", () => {
            if (!current()) return;
            this.setStatus("connected");
            this.reconnectWait?.resolve();
            this.emitState("connected"); resolve();
          });
          client!.on("connecting", () => {
            if (current()) this.setStatus("connecting");
          });
          client!.on("disconnected", (ctx) => {
            if (!current()) return;
            ++this.generation;
            this.reconnectWait?.reject(this.cancelled());
            this.cancelConnect?.();
            this.cancelConnect = null;
            this.connectPromise = null;
            for (const pending of this.pending.values()) pending.cancel();
            this.pending.clear();
            for (const channel of this.channels.values()) channel.close();
            this.channels.clear();
            this.client = null;
            this.credentials = null;
            this.setStatus("disconnected"); this.emitState("disconnected", ctx);
          });
          client!.on("error", (ctx) => {
            if (!current()) return;
            // Transport errors may be transient; Centrifuge retries until our deadline.
            this.emitState("error", ctx);
          });
          client!.connect();
        }), cancellation]);
        this.log("info", "connected", { url });
      } catch (error) {
        if (generation === this.generation) {
          ++this.generation;
          for (const pending of this.pending.values()) pending.cancel();
          this.pending.clear();
          for (const channel of this.channels.values()) channel.close();
          this.channels.clear();
          this.client = null;
          this.credentials = null;
          this.setStatus("error");
          client?.disconnect();
        }
        throw error;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (this.cancelConnect === cancel) this.cancelConnect = null;
      }
    })();
    this.connectPromise = work;
    try { await work; } finally { if (this.connectPromise === work) this.connectPromise = null; }
  }

  private waitForReconnect(): Promise<void> {
    if (this.reconnectWait) return this.reconnectWait.promise;
    let resolvePromise!: () => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
    const finish = (error?: Error) => {
      if (this.reconnectWait !== wait) return;
      this.reconnectWait = null;
      clearTimeout(timer);
      if (error) rejectPromise(error); else resolvePromise();
    };
    const wait = { promise, resolve: () => finish(), reject: (error: Error) => finish(error) };
    const timer = setTimeout(() => finish(new RelyvoRealtimeError("connect_timeout", "The realtime connection did not open in time.")), 10_000);
    this.reconnectWait = wait;
    return promise;
  }

  async subscribe(name: string): Promise<RealtimeChannel> {
    const existing = this.channels.get(name);
    if (existing?.subscribed) return existing;
    const pending = this.pending.get(name);
    if (pending) {
      if (pending.cancelled) {
        const generation = this.generation;
        await pending.promise.catch(() => {});
        if (this.generation !== generation) throw this.cancelled();
        return this.subscribe(name);
      }
      return pending.promise;
    }
    const client = this.client;
    if (!client) throw new RelyvoRealtimeError("not_connected", "Call connect() before subscribe().");
    const generation = this.generation;
    let rejectCancel!: (error: Error) => void;
    const cancellation = new Promise<never>((_, reject) => { rejectCancel = reject; });
    // Cancellation may precede the deferred operation body.
    void cancellation.catch(() => {});
    const operation = {
      promise: null as unknown as Promise<RealtimeChannel>,
      cancelled: false,
      cancel: () => { operation.cancelled = true; rejectCancel(this.cancelled()); },
    };
    // Deferring the body lets us register the operation before synchronous failures.
    operation.promise = Promise.resolve().then(async () => {
      let subscription: TransportSubscription | null = null;
      let alive = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const current = () => !operation.cancelled && this.generation === generation && this.client === client && this.pending.get(name) === operation;
      try {
        let entry = this.findChannel(name);
        if (!entry) {
          await Promise.race([this.refresh(generation, current), cancellation]);
          entry = this.findChannel(name);
        }
        if (!current()) throw this.cancelled();
        if (!entry) throw new RelyvoRealtimeError("channel_not_authorized", `Your backend did not authorize a subscription to "${name}".`);
        subscription = client.newSubscription(entry.internal_channel, {
          token: entry.subscription_token,
          getToken: async () => {
            if (!alive) throw this.cancelled();
            const fresh = await this.refresh(generation, () => alive);
            const match = fresh.channels.find((channel) => channel.channel === name);
            if (!match) throw new RelyvoRealtimeError("channel_not_authorized", "The refreshed credentials do not include this channel.");
            return match.subscription_token;
          },
        });
        await Promise.race([new Promise<void>((resolve, reject) => {
          timer = setTimeout(() => reject(new RelyvoRealtimeError("subscription_timeout", `The subscription to "${name}" did not complete in time.`)), 10_000);
          subscription!.on("subscribed", () => { if (current()) resolve(); });
          // Errors can be retryable (including token expiry); terminal rejections
          // transition the Centrifuge subscription to unsubscribed instead.
          subscription!.on("error", () => {});
          subscription!.on("unsubscribed", () => { if (current()) reject(new RelyvoRealtimeError("subscription_failed", `The subscription to "${name}" was rejected.`)); });
          subscription!.subscribe();
        }), cancellation]);
        if (!current()) throw this.cancelled();
        const transport = subscription;
        const channel = new RealtimeChannel(name, entry.type, transport, () => {
          alive = false;
          if (this.channels.get(name) === channel) this.channels.delete(name);
          client.removeSubscription?.(transport);
        });
        this.channels.set(name, channel);
        // Centrifuge's unsubscribed state is terminal, unlike subscribing while retrying.
        transport.on("unsubscribed", () => channel.close());
        this.log("info", "subscribed", { channel: name });
        return channel;
      } catch (error) {
        alive = false;
        if (subscription) {
          try { subscription.unsubscribe(); } finally { client.removeSubscription?.(subscription); }
        }
        throw error;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (this.pending.get(name) === operation) this.pending.delete(name);
      }
    });
    this.pending.set(name, operation);
    return operation.promise;
  }

  async unsubscribe(name: string): Promise<void> {
    const channel = this.channels.get(name);
    const pending = this.pending.get(name);
    if (pending) {
      pending.cancel();
      // Keep the entry reserved until the transport has been removed.
      await pending.promise.catch(() => {});
    }
    if (channel) { channel.close(); this.log("info", "unsubscribed", { channel: name }); }
  }

  async disconnect(): Promise<void> {
    ++this.generation;
    this.reconnectWait?.reject(this.cancelled());
    this.cancelConnect?.();
    this.cancelConnect = null;
    this.connectPromise = null;
    for (const pending of this.pending.values()) pending.cancel();
    this.pending.clear();
    for (const channel of this.channels.values()) channel.close();
    this.channels.clear();
    const client = this.client;
    this.client = null;
    this.credentials = null;
    this.setStatus("disconnected");
    client?.disconnect();
    this.log("info", "disconnected");
  }

  private findChannel(name: string): ChannelCredentials | undefined {
    return this.credentials?.channels.find((channel) => channel.channel === name);
  }

  private async refresh(generation: number, valid: () => boolean = () => true): Promise<ClientCredentials> {
    const fresh = await this.options.getCredentials();
    if (generation !== this.generation || !valid()) throw this.cancelled();
    this.credentials = fresh;
    return fresh;
  }

  private setStatus(status: RealtimeStatus): void { this.currentStatus = status; }
  private emitState(event: RealtimeEvent, payload?: unknown): void {
    for (const handler of this.stateHandlers.get(event) ?? []) handler(payload);
  }
  private log(level: "debug" | "info" | "warn" | "error", message: string, meta?: Record<string, unknown>): void {
    this.options.logger?.(level, message, meta);
  }
}
