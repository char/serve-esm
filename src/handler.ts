import * as path from "@std/path";
import { getMimeType } from "./mime.ts";

const GET_VERSIONED_FILE = new URLPattern({
  pathname: "/:repo/:version/:file(.+)",
});

const decoder = new TextDecoder();
const CACHE_CONTROL = "public, max-age=31536000, immutable";

interface GitResult {
  code: number;
  stdout: Uint8Array;
  stderr: string;
}

async function git(repoDir: string, args: string[]): Promise<GitResult> {
  const cmd = new Deno.Command("git", {
    args: ["-C", repoDir, ...args],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  return { code, stdout, stderr: decoder.decode(stderr) };
}

function logGitFailure(where: string, args: string[], r: GitResult): void {
  console.warn(
    `git ${where} failed (code ${r.code}): ${
      args.join(" ")
    }\n${r.stderr.trimEnd()}`,
  );
}

function textPlain(
  status: number,
  body: string,
  extra?: Record<string, string>,
): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...extra },
  });
}

async function listTags(repoDir: string): Promise<string[] | null> {
  const args = ["tag", "--list", "--sort=-version:refname"];
  const r = await git(repoDir, args);
  if (r.code !== 0) {
    logGitFailure("tag --list", args, r);
    return null;
  }
  return decoder.decode(r.stdout).split("\n").filter((s) => s.length > 0);
}

async function getVersionedFile(
  req: Request,
  match: URLPatternResult,
  root: string,
): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return textPlain(405, "method not allowed", { allow: "GET, HEAD" });
  }

  const { repo, version, file } = match.pathname.groups as {
    repo: string;
    version: string;
    file: string;
  };

  // `file` is concatenated into `refs/tags/<version>:<file>`. git rejects
  // out-of-tree paths itself, but we'd rather not hand it anything weird.
  if (
    file.startsWith("/") ||
    file.split("/").some((seg) => seg === "" || seg === "..")
  ) {
    return textPlain(404, "file not found");
  }

  const repoDir = path.resolve(root, repo);
  if (repoDir !== root && !repoDir.startsWith(root + path.SEPARATOR)) {
    return textPlain(404, "repository not found");
  }
  try {
    const stat = await Deno.stat(repoDir);
    if (!stat.isDirectory) return textPlain(404, "repository not found");
  } catch {
    return textPlain(404, "repository not found");
  }

  // Listing tags up front lets us (a) reject unknown versions without ever
  // passing untrusted input through to a git ref expression and (b) give
  // the caller a useful 404 body listing what *does* exist.
  const tags = await listTags(repoDir);
  if (tags === null) return textPlain(500, "internal error");
  if (!tags.includes(version)) {
    const list = tags.length === 0 ? "(no tags)" : tags.join("\n");
    return textPlain(
      404,
      `version not found\n\navailable versions:\n${list}\n`,
    );
  }

  // Get the blob ID and size without reading its contents. Besides making the
  // object ID available as an ETag, this avoids loading the blob for HEAD and
  // conditional requests.
  const infoArgs = [
    "--literal-pathspecs",
    "ls-tree",
    "-z",
    "--format=%(objectname) %(objecttype) %(objectsize)",
    `refs/tags/${version}`,
    "--",
    file,
  ];
  const info = await git(repoDir, infoArgs);
  if (info.code !== 0) {
    logGitFailure("ls-tree", infoArgs, info);
    return textPlain(500, "internal error");
  }
  const blobInfo = decoder.decode(info.stdout).match(
    /^([0-9a-f]+) blob ([0-9]+)\0$/,
  );
  if (blobInfo === null) return textPlain(404, "file not found");

  const [, objectId, size] = blobInfo;
  const etag = `"${objectId}"`;
  const ifNoneMatch = req.headers.get("if-none-match");
  if (
    ifNoneMatch !== null &&
    ifNoneMatch.split(",").some((candidate) => {
      const tag = candidate.trim();
      return tag === "*" || tag === etag || tag === `W/${etag}`;
    })
  ) {
    return new Response(null, {
      status: 304,
      headers: { "cache-control": CACHE_CONTROL, etag },
    });
  }

  const headers = {
    "content-type": getMimeType(file) ?? "application/octet-stream",
    "content-length": size,
    "cache-control": CACHE_CONTROL,
    etag,
  };
  if (req.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }

  const blobArgs = ["cat-file", "blob", objectId];
  const blob = await git(repoDir, blobArgs);
  if (blob.code !== 0) {
    logGitFailure("cat-file blob", blobArgs, blob);
    return textPlain(500, "internal error");
  }
  // Deno typings give us Uint8Array<ArrayBufferLike>; BodyInit wants the
  // narrower Uint8Array<ArrayBuffer>. The buffer is in fact an ArrayBuffer.
  return new Response(blob.stdout as Uint8Array<ArrayBuffer>, {
    status: 200,
    headers,
  });
}

export function createHandler(
  targetDir: string,
): (req: Request) => Promise<Response> {
  const root = path.resolve(targetDir);
  return (req) => {
    const match = GET_VERSIONED_FILE.exec(req.url);
    if (match) return getVersionedFile(req, match, root);
    return Promise.resolve(textPlain(404, "not found"));
  };
}
