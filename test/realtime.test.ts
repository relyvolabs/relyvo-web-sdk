import { describe, expect, it, vi } from "vitest";
import { RelyvoRealtime as RootRealtime } from "../src/index.js";
import { RelyvoRealtime, type TransportClient, type TransportSubscription } from "../src/realtime.js";

describe("canonical Realtime integration", () => {
  it("exports the same implementation from root and subpath and routes events", async () => {
    expect(RootRealtime).toBe(RelyvoRealtime);
    const handlers = new Map<string, (ctx: any) => void>();
    const subHandlers = new Map<string, (ctx: any) => void>();
    const unsubscribe = vi.fn();
    const sub: TransportSubscription = {
      on: (event, handler) => { subHandlers.set(event, handler); },
      subscribe: () => { subHandlers.get("subscribed")?.({}); },
      unsubscribe,
    };
    const newSubscription = vi.fn(() => sub);
    const client: TransportClient = {
      on: (event, handler) => { handlers.set(event, handler); },
      connect: () => { handlers.get("connected")?.({}); },
      disconnect: vi.fn(),
      newSubscription,
    };
    const getCredentials = vi.fn(async () => ({ ws_url: "wss://example.test", connection_token: "conn", expires_at: "later", channels: [{ channel: "orders", internal_channel: "rt:tenant:orders", type: "private" as const, subscription_token: "sub", expires_at: "later" }] }));
    const realtime = new RelyvoRealtime({ getCredentials, createClient: () => client });
    await realtime.connect();
    const channel = await realtime.subscribe("orders");
    expect(newSubscription).toHaveBeenCalledWith("rt:tenant:orders", expect.objectContaining({ token: "sub" }));
    const listener = vi.fn();
    channel.on("changed", listener);
    subHandlers.get("publication")?.({ data: { event: "changed", data: { id: 1 }, event_id: "event-1" } });
    expect(listener).toHaveBeenCalledWith({ id: 1 }, { event: "changed", eventId: "event-1" });
    await realtime.disconnect();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(client.disconnect).toHaveBeenCalledOnce();
  });
});
