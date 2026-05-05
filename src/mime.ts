// Values are full media types (with charset where appropriate) so callers
// can use them verbatim without guessing whether `; charset=...` is sensible
// for the type; it isn't, e.g., for application/wasm.
const MIME_TYPES: Record<string, string> = {
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  cjs: "text/javascript; charset=utf-8",
  jsx: "text/jsx; charset=utf-8",
  ts: "text/typescript; charset=utf-8",
  mts: "text/typescript; charset=utf-8",
  cts: "text/typescript; charset=utf-8",
  tsx: "text/tsx; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  css: "text/css; charset=utf-8",
  html: "text/html; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  svg: "image/svg+xml; charset=utf-8",
  wasm: "application/wasm",
};

export function getMimeType(path: string): string | undefined {
  const i = path.lastIndexOf(".");
  if (i < 0) return undefined;
  return MIME_TYPES[path.slice(i + 1).toLowerCase()];
}
