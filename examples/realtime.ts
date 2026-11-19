import { RelyvoRealtime } from '@relyvolabs/web-sdk/realtime';

export async function watchOrders() {
  const realtime = new RelyvoRealtime({
    getCredentials: async () => {
      const response = await fetch('/api/realtime/credentials'); // application-owned endpoint
      if (!response.ok) throw new Error('Credentials unavailable');
      return response.json();
    },
  });
  await realtime.connect();
  const channel = await realtime.subscribe('private-orders.123');
  const off = channel.on('order.updated', (_payload, meta) => console.log(meta.eventId));
  return async () => { off(); await realtime.disconnect(); };
}
