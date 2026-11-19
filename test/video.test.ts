import { describe, expect, it } from "vitest";

import { RelyvoCall, RelyvoError } from "../src/index.js";
import type { RoomLike } from "../src/video.js";

function fakeRoom(options: { failConnect?: boolean } = {}) {
  const calls = {
    connect: [] as { url: string; token: string }[],
    camera: [] as boolean[],
    microphone: [] as boolean[],
    screen: [] as boolean[],
    listeners: [] as { event: string; handler: (...args: any[]) => void }[],
    disconnected: 0,
  };

  const room: RoomLike = {
    async connect(url, token) {
      if (options.failConnect) throw new Error("ice failed");
      calls.connect.push({ url, token });
    },
    async disconnect() {
      calls.disconnected += 1;
    },
    on(event, handler) {
      calls.listeners.push({ event, handler });
      return room;
    },
    remoteParticipants: new Map([["remote-1", { identity: "remote-1" }]]),
    localParticipant: {
      async setCameraEnabled(enabled) {
        calls.camera.push(enabled);
      },
      async setMicrophoneEnabled(enabled) {
        calls.microphone.push(enabled);
      },
      async setScreenShareEnabled(enabled) {
        calls.screen.push(enabled);
      },
    },
  };

  return { room, calls };
}

const credentials = { serverUrl: "wss://rtc.example.com", token: "participant-token" };

describe("RelyvoCall", () => {
  it("connects with the server URL and token", async () => {
    const fake = fakeRoom();
    await RelyvoCall.connect(credentials, { createRoom: () => fake.room });

    expect(fake.calls.connect).toEqual([{ url: credentials.serverUrl, token: credentials.token }]);
  });

  it("wraps a failed connection instead of leaking the media error", async () => {
    const fake = fakeRoom({ failConnect: true });

    await expect(
      RelyvoCall.connect(credentials, { createRoom: () => fake.room }),
    ).rejects.toMatchObject({ name: "RelyvoError", code: "connect_failed" });
  });

  it("requires credentials", async () => {
    await expect(RelyvoCall.connect({ serverUrl: "", token: "" })).rejects.toBeInstanceOf(RelyvoError);
  });

  it("toggles camera and microphone", async () => {
    const fake = fakeRoom();
    const call = await RelyvoCall.connect(credentials, { createRoom: () => fake.room });

    await call.enableCamera(true);
    await call.enableMicrophone(false);

    expect(fake.calls.camera).toEqual([true]);
    expect(fake.calls.microphone).toEqual([false]);
  });

  it("refuses to control devices before connecting", async () => {
    const fake = fakeRoom();
    const call = await RelyvoCall.connect(credentials, { createRoom: () => fake.room });
    call.disconnect();

    await expect(call.enableCamera(true)).rejects.toMatchObject({ code: "not_connected" });
  });

  it("forwards room events and can stop listening", async () => {
    const fake = fakeRoom();
    const call = await RelyvoCall.connect(credentials, { createRoom: () => fake.room });

    const seen: string[] = [];
    call.on("participantConnected", (participant: { identity: string }) => {
      seen.push(participant.identity);
    });

    const listener = fake.calls.listeners.find((item) => item.event === "participantConnected");
    expect(listener).toBeDefined();
    listener?.handler({ identity: "user_7" });
    expect(seen).toEqual(["user_7"]);
  });

  it("cleans up after a failed connection", async () => {
    const fake = fakeRoom({ failConnect: true });
    await expect(RelyvoCall.connect(credentials, { createRoom: () => fake.room })).rejects.toMatchObject({ code: "connect_failed" });
    expect(fake.calls.disconnected).toBe(1);
  });

  it("blocks media after a remote disconnect and unsubscribes without off", async () => {
    const fake = fakeRoom();
    const call = await RelyvoCall.connect(credentials, { createRoom: () => fake.room });
    let count = 0;
    const unsubscribe = call.on("participantConnected", () => count++);
    const listener = fake.calls.listeners.find((item) => item.event === "participantConnected")!;
    unsubscribe();
    listener.handler({});
    expect(count).toBe(0);
    fake.calls.listeners.find((item) => item.event === "disconnected")!.handler();
    await expect(call.enableMicrophone()).rejects.toMatchObject({ code: "not_connected" });
  });

  it("exposes participants and a consistent dispose alias", async () => {
    const fake = fakeRoom();
    const call = await RelyvoCall.connect(credentials, { createRoom: () => fake.room });
    expect(call.isConnected).toBe(true);
    expect(call.localParticipant).toBe(fake.room.localParticipant);
    expect(call.remoteParticipants.get("remote-1")).toEqual({ identity: "remote-1" });
    call.dispose();
    expect(call.isConnected).toBe(false);
    expect(fake.calls.disconnected).toBe(1);
  });

  it("disconnects once", async () => {
    const fake = fakeRoom();
    const call = await RelyvoCall.connect(credentials, { createRoom: () => fake.room });

    call.disconnect();
    call.disconnect();

    expect(fake.calls.disconnected).toBe(1);
  });
});
