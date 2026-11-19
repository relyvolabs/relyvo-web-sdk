import { Room, RoomEvent } from "livekit-client";

import { RelyvoError } from "./errors.js";
import type { CallCredentials, CallEvent } from "./types.js";

/** The subset of the LiveKit Room this SDK depends on. */
export interface RoomLike {
  connect(url: string, token: string): Promise<void>;
  disconnect(): Promise<void> | void;
  on(event: string, handler: (...args: any[]) => void): unknown;
  localParticipant: {
    setCameraEnabled(enabled: boolean): Promise<void>;
    setMicrophoneEnabled(enabled: boolean): Promise<void>;
    setScreenShareEnabled(enabled: boolean): Promise<void>;
  };
  /** LiveKit exposes the remote participant map on the room. */
  remoteParticipants?: Map<string, unknown>;
}

export type RoomFactory = () => RoomLike;

const defaultFactory: RoomFactory = () =>
  new Room({ adaptiveStream: true, dynacast: true }) as unknown as RoomLike;

/** LiveKit event names, mapped so callers do not import the media library. */
const EVENT_NAMES: Record<CallEvent, RoomEvent> = {
  connected: RoomEvent.Connected,
  disconnected: RoomEvent.Disconnected,
  participantConnected: RoomEvent.ParticipantConnected,
  participantDisconnected: RoomEvent.ParticipantDisconnected,
  trackSubscribed: RoomEvent.TrackSubscribed,
  trackUnsubscribed: RoomEvent.TrackUnsubscribed,
  connectionQualityChanged: RoomEvent.ConnectionQualityChanged,
  mediaDevicesError: RoomEvent.MediaDevicesError,
};

export interface RelyvoCallOptions {
  /** Injectable room, used by tests. */
  createRoom?: RoomFactory;
}

/**
 * One video or voice call.
 *
 * The participant token is minted by your backend with the Relyvo server SDK; the
 * grant is join-only and already scoped to the room, so this class cannot ask for
 * more than that token allows.
 */
export class RelyvoCall {
  readonly room: RoomLike;
  private connected = false;
  private disconnectVersion = 0;

  private constructor(room: RoomLike) {
    this.room = room;
    room.on(RoomEvent.Disconnected, () => {
      this.connected = false;
      this.disconnectVersion++;
    });
  }

  /** Whether this wrapper currently has a live room connection. */
  get isConnected(): boolean {
    return this.connected;
  }

  /** The local participant, for access to the underlying media tracks. */
  get localParticipant(): RoomLike["localParticipant"] {
    return this.room.localParticipant;
  }

  /** Remote participants in the current room. Do not use this to authorize users. */
  get remoteParticipants(): ReadonlyMap<string, unknown> {
    return this.room.remoteParticipants ?? new Map();
  }

  /** Connects to the room the token was minted for. */
  static async connect(
    credentials: CallCredentials,
    options: RelyvoCallOptions = {},
  ): Promise<RelyvoCall> {
    if (!credentials.serverUrl || !credentials.token) {
      throw new RelyvoError("invalid_credentials", "serverUrl and token are required");
    }

    const call = new RelyvoCall((options.createRoom ?? defaultFactory)());

    try {
      await call.room.connect(credentials.serverUrl, credentials.token);
      if (call.disconnectVersion !== 0) throw new Error("room disconnected during connection");
    } catch (cause) {
      try {
        await call.room.disconnect();
      } catch {
        // Preserve the connection failure even if best-effort cleanup fails.
      }
      throw new RelyvoError("connect_failed", "the media connection could not be established", cause);
    }

    call.connected = true;
    return call;
  }

  /** Publishes or stops the camera. */
  async enableCamera(enabled = true): Promise<void> {
    this.requireConnected();
    await this.room.localParticipant.setCameraEnabled(enabled);
  }

  /** Publishes or stops the microphone. */
  async enableMicrophone(enabled = true): Promise<void> {
    this.requireConnected();
    await this.room.localParticipant.setMicrophoneEnabled(enabled);
  }

  /** Starts or stops screen sharing where the browser supports it. */
  async shareScreen(enabled = true): Promise<void> {
    this.requireConnected();
    if (enabled && typeof navigator !== "undefined" && !navigator.mediaDevices?.getDisplayMedia) {
      throw new RelyvoError("unsupported", "this browser does not support screen sharing");
    }
    await this.room.localParticipant.setScreenShareEnabled(enabled);
  }

  /** Subscribes to a room event. Returns an unsubscribe function. */
  on(event: CallEvent, handler: (...args: any[]) => void): () => void {
    const name = EVENT_NAMES[event];
    let active = true;
    const wrapped = (...args: any[]) => { if (active) handler(...args); };
    this.room.on(name, wrapped);
    return () => {
      if (!active) return;
      active = false;
      const target = this.room as unknown as {
        off?: (event: string, callback: (...args: any[]) => void) => void;
      };
      target.off?.(name, wrapped);
    };
  }

  /** Leaves the room and releases the local devices. */
  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    // The public method is intentionally synchronous; consume asynchronous cleanup failures.
    try {
      void Promise.resolve(this.room.disconnect()).catch(() => {});
    } catch {
      // The room is already considered disconnected even if cleanup throws.
    }
  }

  /** Alias consistent with the other SDK resources. */
  dispose(): void {
    this.disconnect();
  }

  private requireConnected(): void {
    if (!this.connected) {
      throw new RelyvoError("not_connected", "the call is not connected");
    }
  }
}
