import { RelyvoCall, type CallCredentials } from '@relyvolabs/web-sdk/call';

// Credentials come from your authenticated application backend, not an API key.
export async function joinCall(credentials: CallCredentials) {
  const call = await RelyvoCall.connect(credentials);
  await call.enableMicrophone();
  return () => call.disconnect();
}
