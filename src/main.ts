import { createHandler } from "./handler.ts";

const TARGET_DIR = Deno.env.get("TARGET_DIR");
if (!TARGET_DIR) {
  console.error("TARGET_DIR env var is required");
  Deno.exit(1);
}

export default {
  fetch: createHandler(TARGET_DIR),
} satisfies Deno.ServeDefaultExport;
