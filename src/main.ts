import { env } from "avril:std";
import type { ServeModule } from "avril:std";
import { createHandler } from "./handler.ts";

const TARGET_DIR = env.get("TARGET_DIR");
if (!TARGET_DIR) {
  console.error("TARGET_DIR env var is required");
  throw new Error("TARGET_DIR env var is required");
}

export default {
  fetch: createHandler(TARGET_DIR),
} satisfies ServeModule;
