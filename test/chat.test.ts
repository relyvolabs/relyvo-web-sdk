import { describe, expect, it } from "vitest";

import { RelyvoChat, RelyvoError } from "../src/index.js";
import type { CentrifugeClient } from "../src/chat.js";

const CHANNEL = "project:8c1e4b62:channel:0f5b3a7e";
const CHANNEL_ID = "0f5b3a7e";

type RpcHandler = (method: string, data: any) => { data: unknown };

function fakeCentrifuge(rpc: RpcHandler) {
  const state = {
    connected: false,
    rpcCalls: [] as { method: string; data: any }[],
    subscriptions: [] as { channel: string; token: string; getToken?: () => Promise<string> }[],
    connection: { token: "", getToken: undefined as undefined | (() => Promise<string>) },
    publications: [] as ((ctx: unknown) => void)[],
    connectedHandlers: [] as (() => void)[],
    disconnectCount: 0,
  };

  const client: CentrifugeClient = {
    connect() {
      state.connected = true;
      for (const handler of state.connectedHandlers) handler();
    },
    disconnect() {
      state.disconnectCount += 1;
    },
    on(event, handler) {
      if (event === "connected") state.connectedHandlers.push(handler as () => void);
    },
    newSubscription(channel, options) {
      state.subscriptions.push({
        channel,
        token: options.token ?? "",
        getToken: options.getToken,
      });
      return {
        subscribe: async () => {},
        unsubscribe: () => {},
        on(event, handler) {
          if (event === "publication") state.publications.push(handler as (ctx: unknown) => void);
        },
      };
    },
    async rpc(method, data) {
      state.rpcCalls.push({ method, data });
      return rpc(method, data);
    },
  };

  return {
    state,
    factory: (_url: string, options: { token?: string; getToken?: () => Promise<string> }) => {
      state.connection = { token: options.token ?? "", getToken: options.getToken };
      return client;
    },
    publish(payload: unknown) {
      for (const handler of state.publications) handler({ data: payload });
    },
  };
}

function credentials(extra: Partial<{ typingChannel: string; typingSubscriptionToken: string }> = {}) {
  return {
    wsUrl: "wss://chat.example.com/connection/websocket",
    token: "connection-token",
    channel: CHANNEL,
    subscriptionToken: "subscription-token",
    ...extra,
  };
}

describe("RelyvoChat", () => {
  it("connects, subscribes to the conversation, and exposes the channel id", async () => {
    const fake = fakeCentrifuge(() => ({ data: { ok: true, data: {} } }));
    const chat = new RelyvoChat(credentials(), { createCentrifuge: fake.factory });

    await chat.connect();

    expect(fake.state.connected).toBe(true);
    expect(fake.state.subscriptions).toEqual([
      { channel: CHANNEL, token: "subscription-token", getToken: undefined },
    ]);
  });

  it("subscribes to the typing sibling when credentials include it", async () => {
    const fake = fakeCentrifuge(() => ({ data: { ok: true, data: {} } }));
    const chat = new RelyvoChat(
      credentials({ typingChannel: `${CHANNEL}:typing`, typingSubscriptionToken: "typing-token" }),
      { createCentrifuge: fake.factory },
    );

    await chat.connect();

    expect(fake.state.subscriptions.map(({ channel, token }) => ({ channel, token }))).toEqual([
      { channel: CHANNEL, token: "subscription-token" },
      { channel: `${CHANNEL}:typing`, token: "typing-token" },
    ]);
  });

  it("sends through the rpc transport with the channel id from the subscription", async () => {
    const fake = fakeCentrifuge(() => ({
      data: { ok: true, data: { message: { id: "m1" }, created: true } },
    }));
    const chat = new RelyvoChat(credentials(), { createCentrifuge: fake.factory });
    await chat.connect();

    const result = await chat.send({ content: "hello", clientMessageId: "c-1" });

    expect(result).toEqual({ message: { id: "m1" }, created: true });
    expect(fake.state.rpcCalls[0]).toEqual({
      method: "chat.send",
      data: {
        channel_id: CHANNEL_ID,
        client_message_id: "c-1",
        content: "hello",
        type: "text",
      },
    });
  });

  it("throws the service's code when the rpc envelope reports a failure", async () => {
    const fake = fakeCentrifuge(() => ({
      data: { ok: false, error: { code: "forbidden", message: "channel is read-only" } },
    }));
    const chat = new RelyvoChat(credentials(), { createCentrifuge: fake.factory });
    await chat.connect();

    await expect(chat.send({ content: "x", clientMessageId: "c-1" })).rejects.toMatchObject({
      name: "RelyvoError",
      code: "forbidden",
      message: "channel is read-only",
    });
  });

  it("reads history and marks messages read", async () => {
    const fake = fakeCentrifuge((method) => ({
      data: { ok: true, data: method === "chat.history" ? { items: [], has_more: false } : {} },
    }));
    const chat = new RelyvoChat(credentials(), { createCentrifuge: fake.factory });
    await chat.connect();

    await chat.history({ limit: 20 });
    await chat.markRead("m1");

    expect(fake.state.rpcCalls.map((call) => call.method)).toEqual(["chat.history", "chat.read"]);
    expect(fake.state.rpcCalls[0]?.data).toEqual({ channel_id: CHANNEL_ID, limit: 20 });
    expect(fake.state.rpcCalls[1]?.data).toEqual({ channel_id: CHANNEL_ID, message_id: "m1" });
  });

  it("emits a message event only for its own channel", async () => {
    const fake = fakeCentrifuge(() => ({ data: { ok: true, data: {} } }));
    const chat = new RelyvoChat(credentials(), { createCentrifuge: fake.factory });
    await chat.connect();

    const received: string[] = [];
    chat.on("message", (event) => received.push(event.message.content));

    fake.publish({
      type: "chat.message.created",
      data: {
        channel_id: "another-channel",
        message: { id: "m1", content: "not mine" },
        sender: { id: "u1" },
      },
    });
    fake.publish({
      type: "chat.message.created",
      data: {
        channel_id: CHANNEL_ID,
        message: { id: "m2", content: "hello" },
        sender: { id: "u2", display_name: "Ada" },
      },
    });

    expect(received).toEqual(["hello"]);
  });

  it("wraps a transport failure and does not leak a raw error", async () => {
    let onConnected: (() => void) | undefined;
    const client: CentrifugeClient = {
      connect() {
        onConnected?.();
      },
      disconnect() {},
      on(event, handler) {
        if (event === "connected") onConnected = handler as () => void;
      },
      newSubscription() {
        return { subscribe: async () => {}, unsubscribe() {}, on() {} };
      },
      async rpc() {
        throw new Error("socket closed");
      },
    };

    const chat = new RelyvoChat(credentials(), { createCentrifuge: () => client });
    await chat.connect();

    await expect(chat.history()).rejects.toMatchObject({
      name: "RelyvoError",
      code: "transport_error",
    });
  });

  it("hands refresh callbacks to the transport so expired tokens are replaced", async () => {
    const fake = fakeCentrifuge(() => ({ data: { ok: true, data: {} } }));
    const chat = new RelyvoChat(credentials(), {
      createCentrifuge: fake.factory,
      getConnectionToken: async () => "connection-token-2",
      getSubscriptionToken: async (channel) => `subscription-2:${channel}`,
    });
    await chat.connect();

    expect(fake.state.connection.token).toBe("connection-token");
    expect(fake.state.connection.getToken).toBeTypeOf("function");
    await expect(fake.state.connection.getToken?.()).resolves.toBe("connection-token-2");

    const conversation = fake.state.subscriptions[0];
    expect(conversation?.getToken).toBeTypeOf("function");
    await expect(conversation?.getToken?.()).resolves.toBe(`subscription-2:${CHANNEL}`);
  });

  it("disconnects the transport", async () => {
    const fake = fakeCentrifuge(() => ({ data: { ok: true, data: {} } }));
    const chat = new RelyvoChat(credentials(), { createCentrifuge: fake.factory });
    await chat.connect();

    chat.disconnect();
    expect(fake.state.disconnectCount).toBe(1);
  });
});
