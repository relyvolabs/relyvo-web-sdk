import { expect, it } from "vitest";
import type { ChatEventHandler, ChatExtendedEventHandler, ChatEventMetadata } from "../src/chat-entry.js";

// Existing consumers could construct this map before new event types were added.
const existingHandlers: ChatEventHandler = {
  connected: () => {},
  disconnected: () => {},
  message: () => {},
  typing: () => {},
  error: () => {},
};

it("preserves the original handler-map shape and exports additive types", () => {
  const event: ChatEventMetadata = { eventId: "event-1", occurredAt: "2026-01-01T00:00:00Z" };
  const handler: ChatExtendedEventHandler["channelUpdated"] = (_channel, metadata) => {
    expect(metadata?.eventId).toBe("event-1");
  };
  handler({ id: "channel-1", type: "group", name: "Support", last_seq: 0 }, event);
  expect(existingHandlers.connected).toBeTypeOf("function");
});
