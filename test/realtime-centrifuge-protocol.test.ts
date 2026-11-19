import { afterEach, describe, expect, it, vi } from "vitest";
import { RelyvoRealtime } from "../src/realtime.js";

// This replaces only the browser socket. Relyvo's default client remains the
// installed centrifuge-js implementation, including its protocol and retry logic.
class ControlledWebSocket {
  static instances: ControlledWebSocket[] = [];
  readonly sent: Array<Record<string, any>> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { ControlledWebSocket.instances.push(this); }
  open() { this.onopen?.(); }
  send(data: string) {
    for (const frame of data.trim().split("\n")) this.sent.push(JSON.parse(frame));
  }
  reply(frame: object) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  drop(code = 1006) { this.onclose?.({ code, reason: "network lost" }); }
  close() { /* client-initiated close; no asynchronous callback needed */ }
}

const channelName = "private-orders.123";
const internalChannel = "rt:project-a:private-orders.123";
function makeRealtime() {
  return new RelyvoRealtime({ getCredentials: async () => ({
    ws_url: "wss://rt.test/connection/websocket", connection_token: "connection-1",
    expires_at: "2030-01-01T00:00:00Z", channels: [{ channel: channelName,
      internal_channel: internalChannel, type: "private", subscription_token: "sub-1",
      expires_at: "2030-01-01T00:00:00Z" }],
  }) });
}
function command(socket: ControlledWebSocket, kind: string) {
  const found = socket.sent.find((frame) => frame[kind]);
  expect(found, `missing ${kind} command: ${JSON.stringify(socket.sent)}`).toBeDefined();
  return found!;
}
async function flush() { for (let i = 0; i < 10; i++) await Promise.resolve(); }

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); ControlledWebSocket.instances = []; });

describe("RelyvoRealtime with real centrifuge-js JSON protocol", () => {
  it("handshakes, subscribes, reconnects and resubscribes over a controlled socket", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", ControlledWebSocket);
    const realtime = makeRealtime();
    try {
      const connecting = realtime.connect();
      await flush();
      const first = ControlledWebSocket.instances[0]!;
      expect(first.url).toBe("wss://rt.test/connection/websocket");
      first.open();
      await flush();
      const connect = command(first, "connect");
      expect(connect.connect.token).toBe("connection-1");
      first.reply({ id: connect.id, connect: { client: "client-1", version: "5" } });
      await connecting;
      expect(realtime.status).toBe("connected");
      const subscribing = realtime.subscribe(channelName);
      await flush();
      const subscribe = command(first, "subscribe");
      expect(subscribe.subscribe).toMatchObject({ channel: internalChannel, token: "sub-1" });
      first.reply({ id: subscribe.id, subscribe: {} });
      const channel = await subscribing;
      const handler = vi.fn();
      channel.on("order.updated", handler);
      first.reply({ push: { channel: internalChannel, pub: { data: { event: "order.updated", data: { id: "before" }, event_id: "e1" } } } });
      await flush();
      expect(handler).toHaveBeenCalledWith({ id: "before" }, { event: "order.updated", eventId: "e1" });
      first.drop();
      expect(realtime.status).toBe("connecting");
      expect(channel.subscribed).toBe(true);
      await vi.advanceTimersByTimeAsync(2000);
      const second = ControlledWebSocket.instances[1]!;
      expect(second).toBeDefined();
      second.open();
      await flush();
      const reconnect = command(second, "connect");
      const resubscribe = command(second, "subscribe");
      expect(reconnect.connect.token).toBe("connection-1");
      expect(resubscribe.subscribe).toMatchObject({ channel: internalChannel, token: "sub-1" });
      second.reply({ id: reconnect.id, connect: { client: "client-2", version: "5" } });
      second.reply({ id: resubscribe.id, subscribe: {} });
      await flush();
      expect(realtime.status).toBe("connected");
      expect(await realtime.subscribe(channelName)).toBe(channel);
      second.reply({ push: { channel: internalChannel, pub: { data: { event: "order.updated", data: { id: "after" } } } } });
      await flush();
      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenLastCalledWith({ id: "after" }, { event: "order.updated" });
    } finally { await realtime.disconnect(); }
  });

  it("rejects a terminal server subscription denial and permits a fresh attempt", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", ControlledWebSocket);
    const realtime = makeRealtime();
    try {
      const connecting = realtime.connect();
      await flush();
      const socket = ControlledWebSocket.instances[0]!;
      socket.open();
      await flush();
      socket.reply({ id: command(socket, "connect").id, connect: { client: "client-1" } });
      await connecting;
      const denied = realtime.subscribe(channelName);
      const rejection = expect(denied).rejects.toMatchObject({ code: "subscription_failed" });
      await flush();
      const first = command(socket, "subscribe");
      socket.reply({ id: first.id, error: { code: 103, message: "permission denied" } });
      await rejection;
      const retry = realtime.subscribe(channelName);
      await flush();
      const commands = socket.sent.filter((frame) => frame.subscribe);
      expect(commands).toHaveLength(2);
      expect(commands[1]!.id).not.toBe(first.id);
      socket.reply({ id: commands[1]!.id, subscribe: {} });
      expect((await retry).subscribed).toBe(true);
    } finally { await realtime.disconnect(); }
  });
});
