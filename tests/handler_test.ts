import {
  assert,
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "jsr:@std/assert";
import * as path from "@std/path";
import { createHandler } from "../src/handler.ts";

async function run(cmd: string, args: string[], cwd?: string): Promise<void> {
  const r = await new Deno.Command(cmd, {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (r.code !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} failed: ${new TextDecoder().decode(r.stderr)}`,
    );
  }
}

async function tempDir(
  opts?: Deno.MakeTempOptions,
): Promise<{ path: string } & AsyncDisposable> {
  const path = await Deno.makeTempDir(opts);
  return {
    path,
    async [Symbol.asyncDispose]() {
      await Deno.remove(path, { recursive: true });
    },
  };
}

async function makeRepo(
  parent: string,
  name: string,
  tags: Record<string, Record<string, string>>,
): Promise<void> {
  const dir = path.join(parent, name);
  await Deno.mkdir(dir, { recursive: true });
  await run("git", ["init", "-q", "-b", "main"], dir);
  // pin identity / disable signing so tests don't depend on global git config
  for (
    const [k, v] of [
      ["user.email", "t@example.com"],
      ["user.name", "t"],
      ["commit.gpgsign", "false"],
      ["tag.gpgsign", "false"],
    ]
  ) {
    await run("git", ["config", k, v], dir);
  }
  for (const [tag, files] of Object.entries(tags)) {
    for (const [p, content] of Object.entries(files)) {
      const full = path.join(dir, p);
      await Deno.mkdir(path.dirname(full), { recursive: true });
      await Deno.writeTextFile(full, content);
    }
    await run("git", ["add", "."], dir);
    await run("git", ["commit", "-q", "-m", tag], dir);
    await run("git", ["tag", tag], dir);
  }
}

Deno.test("handler", async (t) => {
  await using tmp = await tempDir({ prefix: "serve-esm-test-" });
  await makeRepo(tmp.path, "lib", {
    "v1.0.0": { "mod.ts": "export const x = 1;\n" },
    "v2.0.0": {
      "mod.ts": "export const x = 2;\n",
      "src/util.ts": "export const y = 3;\n",
    },
  });
  await makeRepo(tmp.path, "empty", {});
  const handler = createHandler(tmp.path);

  await t.step("serves a tagged file with expected headers", async () => {
    const res = await handler(new Request("http://x/lib/v1.0.0/mod.ts"));
    assertEquals(res.status, 200);
    assertEquals(
      res.headers.get("content-type"),
      "text/typescript; charset=utf-8",
    );
    assertEquals(
      res.headers.get("cache-control"),
      "public, max-age=31536000, immutable",
    );
    assertEquals(res.headers.get("content-length"), "20");
    assertMatch(
      res.headers.get("etag") ?? "",
      /^"(?:[0-9a-f]{40}|[0-9a-f]{64})"$/,
    );
    assertEquals(await res.text(), "export const x = 1;\n");
  });

  await t.step("serves nested file at a different tag", async () => {
    const res = await handler(new Request("http://x/lib/v2.0.0/src/util.ts"));
    assertEquals(res.status, 200);
    assertEquals(await res.text(), "export const y = 3;\n");
  });

  await t.step("HEAD returns headers without a body", async () => {
    const res = await handler(
      new Request("http://x/lib/v1.0.0/mod.ts", { method: "HEAD" }),
    );
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("content-length"), "20");
    assertEquals((await res.arrayBuffer()).byteLength, 0);
  });

  await t.step(
    "If-None-Match returns 304 for strong and weak matches",
    async () => {
      const initial = await handler(
        new Request("http://x/lib/v1.0.0/mod.ts"),
      );
      const etag = initial.headers.get("etag");
      assert(etag);

      for (const value of [etag, `"unrelated", W/${etag}`]) {
        const res = await handler(
          new Request("http://x/lib/v1.0.0/mod.ts", {
            headers: { "if-none-match": value },
          }),
        );
        assertEquals(res.status, 304);
        assertEquals(res.headers.get("etag"), etag);
        assertEquals(
          res.headers.get("cache-control"),
          "public, max-age=31536000, immutable",
        );
        assertEquals(res.headers.get("content-length"), null);
        assertEquals((await res.arrayBuffer()).byteLength, 0);
      }
    },
  );

  await t.step("If-None-Match wildcard returns 304 for HEAD", async () => {
    const res = await handler(
      new Request("http://x/lib/v1.0.0/mod.ts", {
        method: "HEAD",
        headers: { "if-none-match": "*" },
      }),
    );
    assertEquals(res.status, 304);
  });

  await t.step("405 for non-GET/HEAD methods", async () => {
    const res = await handler(
      new Request("http://x/lib/v1.0.0/mod.ts", { method: "POST" }),
    );
    assertEquals(res.status, 405);
    assertEquals(res.headers.get("allow"), "GET, HEAD");
  });

  await t.step("404 for unknown repo", async () => {
    const res = await handler(new Request("http://x/nope/v1.0.0/mod.ts"));
    assertEquals(res.status, 404);
    assertEquals(await res.text(), "repository not found");
  });

  await t.step("404 for unknown version lists tags newest-first", async () => {
    const res = await handler(new Request("http://x/lib/v9.9.9/mod.ts"));
    assertEquals(res.status, 404);
    const body = await res.text();
    assertStringIncludes(body, "version not found");
    assertStringIncludes(body, "v1.0.0");
    assertStringIncludes(body, "v2.0.0");
    assert(
      body.indexOf("v2.0.0") < body.indexOf("v1.0.0"),
      "tags should be sorted newest-first",
    );
  });

  await t.step("404 for unknown version on a tagless repo", async () => {
    const res = await handler(new Request("http://x/empty/v1.0.0/mod.ts"));
    assertEquals(res.status, 404);
    assertStringIncludes(await res.text(), "(no tags)");
  });

  await t.step("404 for missing file inside a known tag", async () => {
    const res = await handler(new Request("http://x/lib/v1.0.0/nope.ts"));
    assertEquals(res.status, 404);
    assertEquals(await res.text(), "file not found");
  });

  await t.step("404 for a directory path (tree, not blob)", async () => {
    const res = await handler(new Request("http://x/lib/v2.0.0/src"));
    assertEquals(res.status, 404);
    assertEquals(await res.text(), "file not found");
  });

  await t.step("rejects path traversal in the repo segment", async () => {
    const res = await handler(new Request("http://x/..%2Fetc/v1.0.0/passwd"));
    assertEquals(res.status, 404);
    assertEquals(await res.text(), "repository not found");
  });

  await t.step("rejects path traversal in the file segment", async () => {
    const res = await handler(new Request("http://x/lib/v1.0.0/..%2Fmod.ts"));
    assertEquals(res.status, 404);
    assertEquals(await res.text(), "file not found");
  });

  await t.step("404 for non-matching url", async () => {
    const res = await handler(new Request("http://x/"));
    assertEquals(res.status, 404);
    assertEquals(await res.text(), "not found");
  });
});
