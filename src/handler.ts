import * as path from "@std/path";
import { getMimeType } from "./mime.ts";

const GET_VERSIONED_FILE = new URLPattern({
  pathname: "/:repo/:version/:file(.+)",
});

const decoder = new TextDecoder();

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

// git's "this object/path isn't here" failure modes, distinct from
// "git itself is unhappy" (corrupt repo, OOM, permissions, ...). The
// latter should surface as 5xx so we notice in logs.
function isGitNotFound(stderr: string): boolean {
  return /Not a valid object name|does not exist in|exists on disk, but not in/
    .test(stderr);
}

function logGitFailure(where: string, args: string[], r: GitResult): void {
  console.warn(
    `git ${where} failed (code ${r.code}): ${args.join(" ")}\n${
      r.stderr.trimEnd()
    }`,
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
    return textPlain(404, `version not found\n\navailable versions:\n${list}\n`);
  }

  // tag is now known-safe. Check object type before fetching content so a
  // tree (i.e. a directory request) becomes a 404 rather than a 500.
  const ref = `refs/tags/${version}:${file}`;
  const typeArgs = ["cat-file", "-t", ref];
  const typeRes = await git(repoDir, typeArgs);
  if (typeRes.code !== 0) {
    if (!isGitNotFound(typeRes.stderr)) {
      logGitFailure("cat-file -t", typeArgs, typeRes);
      return textPlain(500, "internal error");
    }
    return textPlain(404, "file not found");
  }
  if (decoder.decode(typeRes.stdout).trim() !== "blob") {
    return textPlain(404, "file not found");
  }

  const blobArgs = ["cat-file", "blob", ref];
  const blob = await git(repoDir, blobArgs);
  if (blob.code !== 0) {
    logGitFailure("cat-file blob", blobArgs, blob);
    return textPlain(500, "internal error");
  }

  const headers = {
    "content-type": getMimeType(file) ?? "application/octet-stream",
    "content-length": String(blob.stdout.byteLength),
    "cache-control": "public, max-age=31536000, immutable",
  };
  if (req.method === "HEAD") {
    return new Response(null, { status: 200, headers });
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
