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

  private constructor(room: RoomLike) {
    this.room = room;
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
    } catch (cause) {
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
    this.room.on(name, handler);
    return () => {
      const target = this.room as unknown as {
        off?: (event: string, callback: (...args: any[]) => void) => void;
      };
      target.off?.(name, handler);
    };
  }

  /** Leaves the room and releases the local devices. */
  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    void this.room.disconnect();
  }

  private requireConnected(): void {
    if (!this.connected) {
      throw new RelyvoError("not_connected", "the call is not connected");
    }
  }
}
