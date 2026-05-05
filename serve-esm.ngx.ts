import ngx from "@char/ngx";

const DOMAIN = "esm.char.lt";
const SOCKET = "/run/serve-esm/serve-esm.sock";
const CACHE_ZONE = "serve_esm";
const CACHE_PATH = "/var/cache/nginx/serve-esm";

// proxy_cache_path must live in http {} context; emitted alongside the server block
// and expected to be included from a file loaded at http scope.
const cachePath =
  `proxy_cache_path ${CACHE_PATH} levels=1:2 keys_zone=${CACHE_ZONE}:32m ` +
  `max_size=4g inactive=30d use_temp_path=off;`;

const config = ngx("server", [
  [
    ngx.serverName(DOMAIN),
    ...ngx.listen(),
    ...ngx.http3(),
    ...ngx.letsEncrypt(DOMAIN),
  ],
  ngx("location /", [
    `proxy_pass http://unix:${SOCKET}`,
    "proxy_http_version 1.1",
    "proxy_set_header Host $host",
    "proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for",
    "proxy_set_header X-Forwarded-Proto $scheme",

    `proxy_cache ${CACHE_ZONE}`,
    "proxy_cache_key $request_uri",
    "proxy_cache_valid 200 301 302 30d",
    "proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504",
    "proxy_cache_background_update on",
    "proxy_cache_lock on",
    "proxy_cache_revalidate on",
    "add_header X-Cache-Status $upstream_cache_status",
  ]),
]);

if (import.meta.main) console.log([cachePath, config.build()].join("\n"));
