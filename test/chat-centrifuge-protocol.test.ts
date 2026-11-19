import { afterEach, describe, expect, it, vi } from "vitest";
import { RelyvoChat } from "../src/chat.js";

// Only the WebSocket is replaced; the SDK constructs the installed Centrifuge.
class ControlledWebSocket {
  static instances: ControlledWebSocket[] = [];
  readonly sent: Array<Record<string, any>> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { ControlledWebSocket.instances.push(this); }
  open() { this.onopen?.(); }
  send(data: string) { for (const frame of data.trim().split("\n")) this.sent.push(JSON.parse(frame)); }
  reply(frame: object) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  drop() { this.onclose?.({ code: 1006, reason: "network lost" }); }
  close() { /* client-initiated close */ }
}
const channel = "project:p:channel:conversation-1";
const typing = `${channel}:typing`;
const creds = { wsUrl: "wss://chat.test/connection/websocket", token: "connection-token", channel,
  subscriptionToken: "conversation-token", typingChannel: typing, typingSubscriptionToken: "typing-token" };
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
function command(socket: ControlledWebSocket, kind: string, index = 0) {
  const found = socket.sent.filter((frame) => frame[kind])[index];
  expect(found, `missing ${kind} #${index}: ${JSON.stringify(socket.sent)}`).toBeDefined();
  return found!;
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); ControlledWebSocket.instances = []; });

describe("RelyvoChat with real centrifuge-js JSON protocol", () => {
  it("waits for both acknowledgements and reconnects with both subscriptions", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", ControlledWebSocket);
    const chat = new RelyvoChat(creds);
    try {
      const connected = vi.fn();
      const connecting = chat.connect().then(connected);
      void connecting.catch(() => {});
      await flush();
      const first = ControlledWebSocket.instances[0]!;
      expect(first.url).toBe(creds.wsUrl);
      first.open();
      await flush();
      const handshake = command(first, "connect");
      expect(handshake.connect.token).toBe(creds.token);
      first.reply({ id: handshake.id, connect: { client: "client-1" } });
      await flush();
      const conversation = command(first, "subscribe");
      expect(conversation.subscribe).toMatchObject({ channel, token: creds.subscriptionToken });
      expect(connected).not.toHaveBeenCalled();
      first.reply({ id: conversation.id, subscribe: {} });
      await flush();
      const typingSub = command(first, "subscribe", 1);
      expect(typingSub.subscribe).toMatchObject({ channel: typing, token: creds.typingSubscriptionToken });
      expect(connected).not.toHaveBeenCalled();
      first.reply({ id: typingSub.id, subscribe: {} });
      await connecting;
      expect(connected).toHaveBeenCalledOnce();
      const messages = vi.fn();
      chat.on("message", messages);
      first.reply({ push: { channel, pub: { data: { type: "chat.message.created", data: {
        channel_id: "conversation-1", message: { id: "m1", content: "before" }, sender: { id: "u1" },
      } } } } });
      await flush();
      expect(messages).toHaveBeenCalledOnce();
      first.drop();
      const reconnecting = chat.connect();
      void reconnecting.catch(() => {});
      const reconnected = vi.fn();
      void reconnecting.then(reconnected, () => {});
      await vi.advanceTimersByTimeAsync(2000);
      const second = ControlledWebSocket.instances[1]!;
      expect(second).toBeDefined();
      second.open();
      await flush();
      const newHandshake = command(second, "connect");
      expect(newHandshake.connect.token).toBe(creds.token);
      const retried = second.sent.filter((frame) => frame.subscribe);
      expect(retried.map((frame) => frame.subscribe)).toEqual(expect.arrayContaining([
        expect.objectContaining({ channel, token: creds.subscriptionToken }),
        expect.objectContaining({ channel: typing, token: creds.typingSubscriptionToken }),
      ]));
      expect(retried).toHaveLength(2);
      second.reply({ id: newHandshake.id, connect: { client: "client-2" } });
      await flush();
      expect(reconnected).not.toHaveBeenCalled();
      for (const frame of retried) second.reply({ id: frame.id, subscribe: {} });
      await reconnecting;
      expect(reconnected).toHaveBeenCalledOnce();
      second.reply({ push: { channel, pub: { data: { type: "chat.message.created", data: {
        channel_id: "conversation-1", message: { id: "m2", content: "after" }, sender: { id: "u1" },
      } } } } });
      await flush();
      expect(messages).toHaveBeenCalledTimes(2);
      expect(messages.mock.calls[1]![0].message.content).toBe("after");
    } finally { chat.disconnect(); }
  });

  it("surfaces terminal subscription denial from an actual protocol reply", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", ControlledWebSocket);
    const chat = new RelyvoChat(creds);
    const errors = vi.fn();
    chat.on("error", errors);
    try {
      const connecting = chat.connect();
      const rejected = expect(connecting).rejects.toMatchObject({ code: "transport_error" });
      await flush();
      const socket = ControlledWebSocket.instances[0]!;
      socket.open();
      await flush();
      socket.reply({ id: command(socket, "connect").id, connect: { client: "client-1" } });
      await flush();
      const subscription = command(socket, "subscribe");
      socket.reply({ id: subscription.id, error: { code: 103, message: "permission denied" } });
      await rejected;
      expect(errors).toHaveBeenCalledWith(expect.objectContaining({ code: "transport_error" }));
      expect(socket.sent.filter((frame) => frame.subscribe)).toHaveLength(1);
    } finally { chat.disconnect(); }
  });
});
