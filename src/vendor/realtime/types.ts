export type RealtimeStatus = "idle" | "connecting" | "connected" | "disconnected" | "error";

export type ChannelType = "public" | "private" | "presence";

/** One channel entry in the answer of POST /v1/realtime/client-tokens. */
export type ChannelCredentials = {
  channel: string;
  /** Tenant-scoped gateway name, e.g. rt:<project>:orders. */
  internal_channel: string;
  type: ChannelType;
  subscription_token: string;
  expires_at: string;
};

export type ClientCredentials = {
  ws_url: string;
  connection_token: string;
  expires_at: string;
  channels: ChannelCredentials[];
};

/** The subset of centrifuge-js this SDK uses. Tests inject a fake. */
export interface TransportSubscription {
  subscribe(): void;
  unsubscribe(): void;
  on(event: string, handler: (ctx: any) => void): void;
}

export interface TransportClient {
  connect(): void;
  disconnect(): void;
  removeSubscription?(subscription: TransportSubscription): void;
  on(event: string, handler: (ctx: any) => void): void;
  newSubscription(channel: string, options: { token?: string; getToken?: () => Promise<string> }): TransportSubscription;
}

export type RelyvoRealtimeOptions = {
  /** Asks your backend for fresh client credentials. Never return an API key here. */
  getCredentials: () => Promise<ClientCredentials>;
  /** Overrides the URL returned by the backend (useful for tests). */
  wsUrl?: string;
  /** Injectable transport for tests; defaults to centrifuge-js. */
  createClient?: (url: string, options: { token: string; getToken: () => Promise<string> }) => TransportClient;
  logger?: (level: "debug" | "info" | "warn" | "error", message: string, meta?: Record<string, unknown>) => void;
};

export type RealtimeEvent = "connected" | "disconnected" | "error";
