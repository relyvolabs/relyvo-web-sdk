import { RelyvoChat, type ChatCredentials } from '@relyvolabs/web-sdk/chat';

export async function openChat(credentials: ChatCredentials) {
  const chat = new RelyvoChat(credentials);
  const unsubscribe = chat.on('message', ({ message }) => console.log(message.id));
  await chat.connect();
  return () => { unsubscribe(); chat.disconnect(); };
}
