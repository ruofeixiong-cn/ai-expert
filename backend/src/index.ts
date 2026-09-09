import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { env } from "./env.js";

serve({ fetch: createApp().fetch, port: env.BACKEND_PORT }, (info) => {
  console.log(`[backend] http://localhost:${info.port}`);
});
