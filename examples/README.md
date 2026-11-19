# Web SDK examples

- `call.ts` — connect with a short-lived Call credential and clean up.
- `chat.ts` — connect, listen for messages and clean up.
- `realtime.ts` — fetch credentials from an application endpoint, subscribe and clean up.

These are browser-oriented TypeScript examples; the `/api/realtime/credentials` and backend token routes are application-owned placeholders. Run `pnpm exec tsc -p examples/tsconfig.json`. Never put a project API key in these examples or in browser code.
