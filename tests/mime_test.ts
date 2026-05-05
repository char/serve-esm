import { assertEquals } from "jsr:@std/assert";
import { getMimeType } from "../src/mime.ts";

Deno.test("getMimeType: known extensions", () => {
  assertEquals(getMimeType("foo.js"), "text/javascript; charset=utf-8");
  assertEquals(getMimeType("foo.mjs"), "text/javascript; charset=utf-8");
  assertEquals(getMimeType("foo.ts"), "text/typescript; charset=utf-8");
  assertEquals(getMimeType("foo.tsx"), "text/tsx; charset=utf-8");
  assertEquals(getMimeType("foo.json"), "application/json; charset=utf-8");
  assertEquals(getMimeType("foo.wasm"), "application/wasm");
});

Deno.test("getMimeType: only the final extension counts", () => {
  assertEquals(getMimeType("foo.d.ts"), "text/typescript; charset=utf-8");
  assertEquals(getMimeType("foo.bundle.js"), "text/javascript; charset=utf-8");
});

Deno.test("getMimeType: case-insensitive", () => {
  assertEquals(getMimeType("FOO.JS"), "text/javascript; charset=utf-8");
});

Deno.test("getMimeType: unknown / missing extension", () => {
  assertEquals(getMimeType("foo.xyz"), undefined);
  assertEquals(getMimeType("README"), undefined);
  assertEquals(getMimeType(""), undefined);
});
