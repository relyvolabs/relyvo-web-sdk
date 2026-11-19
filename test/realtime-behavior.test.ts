import { describe, expect, it, vi } from "vitest";

import { RelyvoRealtime, RelyvoRealtimeError } from "../src/realtime.js";
import type {
  ClientCredentials,
  RelyvoRealtimeOptions,
  TransportClient,
  TransportSubscription,
} from "../src/realtime.js";

type Handler = (ctx: any) => void;

class FakeSubscription implements TransportSubscription {
  readonly channel: string;
  readonly options: { token?: string; getToken?: () => Promise<string> };
  readonly handlers = new Map<string, Set<Handler>>();
  subscribed = false;
  unsubscribed = false;
  autoSubscribe = true;

  constructor(channel: string, options: { token?: string; getToken?: () => Promise<string> }) {
    this.channel = channel;
    this.options = options;
  }

  subscribe(): void {
    this.subscribed = true;
    if (this.autoSubscribe) queueMicrotask(() => this.emit("subscribed", {}));
  }

  unsubscribe(): void {
    this.unsubscribed = true;
    this.emit("unsubscribed", {});
  }

  on(event: string, handler: Handler): void {
    const set = this.handlers.get(event) ?? new Set<Handler>();
    set.add(handler);
    this.handlers.set(event, set);
  }

  emit(event: string, ctx: any): void {
    for (const handler of this.handlers.get(event) ?? []) handler(ctx);
  }

  publish(data: unknown): void {
    this.emit("publication", { data });
  }
}

class FakeClient implements TransportClient {
  readonly url: string;
  readonly options: { token: string; getToken: () => Promise<string> };
  readonly subscriptions: FakeSubscription[] = [];
  readonly handlers = new Map<string, Set<Handler>>();
  connected = false;
  disconnected = false;
  autoConnect = true;
  autoSubscribe = true;
  readonly removed: TransportSubscription[] = [];
  readonly registry = new Map<string, FakeSubscription>();

  constructor(url: string, options: { token: string; getToken: () => Promise<string> }) {
    this.url = url;
    this.options = options;
  }

  connect(): void {
    this.connected = true;
    if (this.autoConnect) queueMicrotask(() => this.emit("connected", {}));
  }

  disconnect(): void {
    this.disconnected = true;
  }

  on(event: string, handler: Handler): void {
    const set = this.handlers.get(event) ?? new Set<Handler>();
    set.add(handler);
    this.handlers.set(event, set);
  }

  emit(event: string, ctx: any): void {
    for (const handler of this.handlers.get(event) ?? []) handler(ctx);
  }

  removeSubscription(subscription: TransportSubscription): void {
    this.removed.push(subscription);
    const sub = subscription as FakeSubscription;
    if (this.registry.get(sub.channel) === sub) this.registry.delete(sub.channel);
  }

  newSubscription(channel: string, options: { token?: string; getToken?: () => Promise<string> }): TransportSubscription {
    if (this.registry.has(channel)) throw new Error("duplicate subscription");
    const subscription = new FakeSubscription(channel, options);
    this.registry.set(channel, subscription);
    subscription.autoSubscribe = this.autoSubscribe;
    this.subscriptions.push(subscription);
    return subscription;
  }
}

function credentials(overrides: Partial<ClientCredentials> = {}): ClientCredentials {
  return {
    ws_url: "wss://rt.test/connection/websocket",
    connection_token: "connection-1",
    expires_at: "2026-01-01T00:00:00Z",
    channels: [
      {
        channel: "private-orders.123",
        internal_channel: "rt:project-a:private-orders.123",
        type: "private",
        subscription_token: "sub-1",
        expires_at: "2026-01-01T00:00:00Z",
      },
    ],
    ...overrides,
  };
}

function setup(options: Partial<RelyvoRealtimeOptions> = {}) {
  const clients: FakeClient[] = [];
  const getCredentials = vi.fn(async () => credentials());
  const realtime = new RelyvoRealtime({
    getCredentials,
    createClient: (url, clientOptions) => {
      const client = new FakeClient(url, clientOptions);
      clients.push(client);
      return client;
    },
    ...options,
  });
  return { realtime, clients, getCredentials };
}

describe("RelyvoRealtime", () => {
  it("connects with the server-provided token and URL", async () => {
    const { realtime, clients } = setup();

    await realtime.connect();

    expect(realtime.status).toBe("connected");
    expect(clients).toHaveLength(1);
    expect(clients[0]?.url).toBe("wss://rt.test/connection/websocket");
    expect(clients[0]?.options.token).toBe("connection-1");
  });

  it("subscribes to the tenant-scoped internal channel", async () => {
    const { realtime, clients } = setup();
    await realtime.connect();

    const channel = await realtime.subscribe("private-orders.123");

    expect(channel.subscribed).toBe(true);
    expect(clients[0]?.subscriptions[0]?.channel).toBe("rt:project-a:private-orders.123");
    expect(clients[0]?.subscriptions[0]?.options.token).toBe("sub-1");
  });

  it("delivers named events with payload and metadata", async () => {
    const { realtime, clients } = setup();
    await realtime.connect();
    const channel = await realtime.subscribe("private-orders.123");
    const handler = vi.fn();
    channel.on("order.updated", handler);

    clients[0]?.subscriptions[0]?.publish({
      event: "order.updated",
      data: { id: "ord_1" },
      event_id: "evt_1",
    });

    expect(handler).toHaveBeenCalledWith(
      { id: "ord_1" },
      { event: "order.updated", eventId: "evt_1" },
    );
  });

  it("ignores a duplicated handler registration", async () => {
    const { realtime, clients } = setup();
    await realtime.connect();
    const channel = await realtime.subscribe("private-orders.123");
    const handler = vi.fn();
    channel.on("order.updated", handler);
    channel.on("order.updated", handler);

    clients[0]?.subscriptions[0]?.publish({ event: "order.updated", data: { id: "1" } });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("rejects a channel the backend did not authorize", async () => {
    const { realtime } = setup();
    await realtime.connect();

    await expect(realtime.subscribe("private-secret.1")).rejects.toBeInstanceOf(RelyvoRealtimeError);
  });

  it("refreshes credentials for the connection token", async () => {
    const { realtime, clients, getCredentials } = setup();
    await realtime.connect();

    await clients[0]?.options.getToken();

    expect(getCredentials).toHaveBeenCalledTimes(2);
  });

  it("times out and disposes a stalled connection, ignoring late events", async () => {
    vi.useFakeTimers();
    try {
      let client!: FakeClient;
      const { realtime } = setup({ createClient: (url, opts) => { client = new FakeClient(url, opts); client.autoConnect = false; return client; } });
      const connecting = realtime.connect();
      const rejection = expect(connecting).rejects.toMatchObject({ code: "connect_timeout" });
      await vi.advanceTimersByTimeAsync(10_000);
      await rejection;
      expect(client.disconnected).toBe(true);
      client.emit("connected", {});
      expect(realtime.status).toBe("error");
    } finally { vi.useRealTimers(); }
  });

  it("allows a transient transport error before connection succeeds", async () => {
    let client!: FakeClient;
    const { realtime } = setup({ createClient: (url, opts) => { client = new FakeClient(url, opts); client.autoConnect = false; return client; } });
    const errors = vi.fn();
    realtime.on("error", errors);
    const connecting = realtime.connect();
    await Promise.resolve();
    await Promise.resolve();
    client.emit("error", { type: "transport" });
    expect(errors).toHaveBeenCalledOnce();
    expect(client.disconnected).toBe(false);
    client.emit("connected", {});
    await connecting;
    expect(realtime.status).toBe("connected");
  });

  it("cancels pending credentials without letting an old connect overwrite a new one", async () => {
    let resolve!: (value: ClientCredentials) => void;
    const deferred = new Promise<ClientCredentials>((r) => { resolve = r; });
    const getCredentials = vi.fn().mockReturnValueOnce(deferred).mockResolvedValue(credentials());
    const { realtime, clients } = setup({ getCredentials });
    const old = realtime.connect();
    const rejected = expect(old).rejects.toMatchObject({ code: "disconnected" });
    await realtime.disconnect();
    await realtime.connect();
    resolve(credentials());
    await rejected;
    expect(clients).toHaveLength(1);
    expect(realtime.status).toBe("connected");
  });

  it("coalesces in-flight subscriptions and removes closed subscriptions from transport registry", async () => {
    const { realtime, clients } = setup();
    await realtime.connect();
    clients[0]!.autoSubscribe = false;
    const first = realtime.subscribe("private-orders.123");
    const second = realtime.subscribe("private-orders.123");
    await Promise.resolve();
    expect(clients[0]!.subscriptions).toHaveLength(1);
    clients[0]!.subscriptions[0]!.emit("subscribed", {});
    const channel = await first;
    expect(await second).toBe(channel);
    channel.close();
    expect(clients[0]!.removed).toEqual([clients[0]!.subscriptions[0]]);
    clients[0]!.autoSubscribe = true;
    expect(await realtime.subscribe("private-orders.123")).not.toBe(channel);
  });

  it("cancels in-flight subscription and ignores late acknowledgement", async () => {
    const { realtime, clients } = setup();
    await realtime.connect();
    clients[0]!.autoSubscribe = false;
    const subscribing = realtime.subscribe("private-orders.123");
    const rejection = expect(subscribing).rejects.toMatchObject({ code: "disconnected" });
    await Promise.resolve();
    await realtime.unsubscribe("private-orders.123");
    await rejection;
    const old = clients[0]!.subscriptions[0]!;
    expect(old.unsubscribed).toBe(true);
    expect(clients[0]!.removed).toContain(old);
    old.emit("subscribed", {});
    clients[0]!.autoSubscribe = true;
    await realtime.subscribe("private-orders.123");
    expect(clients[0]!.subscriptions).toHaveLength(2);
  });

  it("serializes immediate resubscribe behind pending transport cleanup", async () => {
    const { realtime, clients } = setup();
    await realtime.connect();
    clients[0]!.autoSubscribe = false;
    const first = realtime.subscribe("private-orders.123");
    const rejected = expect(first).rejects.toMatchObject({ code: "disconnected" });
    await Promise.resolve();
    const unsubscribing = realtime.unsubscribe("private-orders.123");
    const second = realtime.subscribe("private-orders.123");
    await unsubscribing;
    await rejected;
    await Promise.resolve();
    const next = clients[0]!.subscriptions[1]!;
    expect(next).toBeDefined();
    next.emit("subscribed", {});
    expect((await second).subscribed).toBe(true);
    expect(clients[0]!.registry.get(next.channel)).toBe(next);
  });

  it("keeps retrying a subscription after a transient token error", async () => {
    const { realtime, clients } = setup();
    await realtime.connect();
    clients[0]!.autoSubscribe = false;
    const subscribing = realtime.subscribe("private-orders.123");
    await Promise.resolve();
    const sub = clients[0]!.subscriptions[0]!;
    sub.emit("error", { code: 109 });
    expect(sub.unsubscribed).toBe(false);
    expect(await sub.options.getToken!()).toBe("sub-1");
    sub.emit("subscribed", {});
    expect((await subscribing).subscribed).toBe(true);
  });

  it("cleans failed and timed out subscriptions for retry", async () => {
    vi.useFakeTimers();
    try {
      const { realtime, clients } = setup();
      const connected = realtime.connect();
      await vi.runAllTicks();
      await connected;
      clients[0]!.autoSubscribe = false;
      const failed = realtime.subscribe("private-orders.123");
      const rejected = expect(failed).rejects.toMatchObject({ code: "subscription_failed" });
      await Promise.resolve();
      clients[0]!.subscriptions[0]!.emit("unsubscribed", { code: 103 });
      await rejected;
      const timed = realtime.subscribe("private-orders.123");
      const timeout = expect(timed).rejects.toMatchObject({ code: "subscription_timeout" });
      await vi.advanceTimersByTimeAsync(10_000);
      await timeout;
      expect(clients[0]!.removed).toHaveLength(2);
      expect(clients[0]!.subscriptions.every((sub) => sub.unsubscribed)).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("rejects stale subscription refresh after closing the channel", async () => {
    let resolve!: (value: ClientCredentials) => void;
    const deferred = new Promise<ClientCredentials>((r) => { resolve = r; });
    const getCredentials = vi.fn().mockResolvedValueOnce(credentials()).mockReturnValueOnce(deferred);
    const { realtime, clients } = setup({ getCredentials });
    await realtime.connect();
    const channel = await realtime.subscribe("private-orders.123");
    const refresh = clients[0]!.subscriptions[0]!.options.getToken!();
    const rejected = expect(refresh).rejects.toMatchObject({ code: "disconnected" });
    channel.close();
    resolve(credentials());
    await rejected;
  });

  it("disposes terminally disconnected channels before reconnecting", async () => {
    const { realtime, clients } = setup();
    await realtime.connect();
    const oldChannel = await realtime.subscribe("private-orders.123");
    const oldHandler = vi.fn();
    oldChannel.on("order.updated", oldHandler);
    const oldClient = clients[0]!;
    const oldSub = oldClient.subscriptions[0]!;

    oldClient.emit("disconnected", { code: 3500 });
    expect(realtime.status).toBe("disconnected");
    expect(oldChannel.subscribed).toBe(false);
    expect(oldSub.unsubscribed).toBe(true);
    expect(oldClient.removed).toContain(oldSub);
    const lateHandler = vi.fn();
    oldChannel.on("order.updated", lateHandler);

    await realtime.connect();
    const newChannel = await realtime.subscribe("private-orders.123");
    const newHandler = vi.fn();
    newChannel.on("order.updated", newHandler);
    expect(newChannel).not.toBe(oldChannel);
    expect(clients).toHaveLength(2);
    const newSub = clients[1]!.subscriptions[0]!;
    oldSub.publish({ event: "order.updated", data: "old" });
    newSub.publish({ event: "order.updated", data: "new" });
    oldClient.emit("connected", {});
    expect(oldHandler).not.toHaveBeenCalled();
    expect(lateHandler).not.toHaveBeenCalled();
    expect(newHandler).toHaveBeenCalledOnce();
    expect(newHandler).toHaveBeenCalledWith("new", { event: "order.updated" });
    expect(realtime.status).toBe("connected");
  });

  it("cancels an in-flight subscription on terminal disconnect", async () => {
    const { realtime, clients } = setup();
    await realtime.connect();
    clients[0]!.autoSubscribe = false;
    const subscribing = realtime.subscribe("private-orders.123");
    const rejected = expect(subscribing).rejects.toMatchObject({ code: "disconnected" });
    await Promise.resolve();
    const oldSub = clients[0]!.subscriptions[0]!;
    clients[0]!.emit("disconnected", {});
    await rejected;
    expect(oldSub.unsubscribed).toBe(true);
    oldSub.emit("subscribed", {});
    await realtime.connect();
    expect((await realtime.subscribe("private-orders.123")).subscribed).toBe(true);
    expect(clients[1]!.subscriptions).toHaveLength(1);
  });

  it("keeps channels and the client during automatic reconnect", async () => {
    const { realtime, clients } = setup();
    await realtime.connect();
    const channel = await realtime.subscribe("private-orders.123");
    clients[0]!.emit("connecting", {});
    expect(realtime.status).toBe("connecting");
    const connected = vi.fn();
    const first = realtime.connect().then(connected);
    const second = realtime.connect();
    await Promise.resolve();
    expect(connected).not.toHaveBeenCalled();
    expect(clients).toHaveLength(1);
    expect(await realtime.subscribe("private-orders.123")).toBe(channel);
    clients[0]!.emit("connected", {});
    await Promise.all([first, second]);
    expect(connected).toHaveBeenCalledOnce();
    expect(realtime.status).toBe("connected");
    expect(channel.subscribed).toBe(true);
  });

  it.each(["terminal", "explicit"])("rejects reconnect wait on %s disconnect", async (kind) => {
    const { realtime, clients } = setup();
    await realtime.connect();
    clients[0]!.emit("connecting", {});
    const waiting = realtime.connect();
    const rejected = expect(waiting).rejects.toMatchObject({ code: "disconnected" });
    if (kind === "terminal") clients[0]!.emit("disconnected", {});
    else await realtime.disconnect();
    await rejected;
  });

  it("times out reconnect wait without replacing the retrying client", async () => {
    vi.useFakeTimers();
    try {
      const { realtime, clients } = setup();
      const initial = realtime.connect();
      await vi.runAllTicks();
      await initial;
      clients[0]!.emit("connecting", {});
      const waiting = realtime.connect();
      const rejected = expect(waiting).rejects.toMatchObject({ code: "connect_timeout" });
      await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
      expect(clients).toHaveLength(1);
      expect(clients[0]!.disconnected).toBe(false);
      clients[0]!.emit("connected", {});
      expect(realtime.status).toBe("connected");
    } finally { vi.useRealTimers(); }
  });

  it("disposes an established channel on terminal unsubscribe", async () => {
    const { realtime, clients } = setup();
    await realtime.connect();
    const old = await realtime.subscribe("private-orders.123");
    const handler = vi.fn();
    old.on("order.updated", handler);
    const oldSub = clients[0]!.subscriptions[0]!;
    oldSub.emit("unsubscribed", { code: 103 });
    expect(old.subscribed).toBe(false);
    expect(clients[0]!.removed).toContain(oldSub);
    oldSub.publish({ event: "order.updated", data: "old" });
    expect(handler).not.toHaveBeenCalled();
    expect(await realtime.subscribe("private-orders.123")).not.toBe(old);
    expect(clients[0]!.subscriptions).toHaveLength(2);
  });

  it("unsubscribes and disconnects cleanly", async () => {
    const { realtime, clients } = setup();
    await realtime.connect();
    await realtime.subscribe("private-orders.123");

    await realtime.unsubscribe("private-orders.123");
    await realtime.disconnect();

    expect(clients[0]?.subscriptions[0]?.unsubscribed).toBe(true);
    expect(clients[0]?.disconnected).toBe(true);
    expect(realtime.status).toBe("disconnected");
  });
});
