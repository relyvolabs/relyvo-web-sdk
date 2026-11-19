import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", call: "src/call.ts", chat: "src/chat-entry.ts", realtime: "src/realtime.ts" },
  format: ["esm", "cjs"],
  target: "es2020",
  dts: true,
  clean: true,
  sourcemap: true,
  external: ["centrifuge", "livekit-client"],
});
