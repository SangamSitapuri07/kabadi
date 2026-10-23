import { createApp } from "./app";
import { env } from "./config/env";
import { closePrisma, getPrisma } from "./lib/prisma";
import { ensureSeeded } from "../prisma/seed";

async function startServer() {
  await getPrisma();
  await ensureSeeded();

  const app = createApp();
  const server = app.listen(env.API_PORT, "0.0.0.0", () => {
    console.log(
      `[kabadiwala-connect-api] Listening on http://0.0.0.0:${env.API_PORT}/api/v1`
    );
  });

  const shutdown = async () => {
    server.close();
    await closePrisma();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

startServer().catch((err) => {
  console.error("Failed to start API server:", err);
  process.exit(1);
});
