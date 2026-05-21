import { createRelayServer } from "./server.js";

const port = Number.parseInt(process.env.VI_RELAY_PORT ?? "8787", 10);
const host = process.env.VI_RELAY_HOST ?? "0.0.0.0";

const relay = createRelayServer();

relay.httpServer.listen(port, host, () => {
  console.log(`[VI Relay] listening on http://${host}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    relay
      .shutdown()
      .catch((error) => {
        console.error("[VI Relay] shutdown failed", error);
      })
      .finally(() => {
        process.exit(0);
      });
  });
}
