# serve-esm

`deno serve` script to serve library sources that can't go on JSR

## usage

- GET `/:repo/:version/*file` finds repo in target directory, looks up tag named
  with version, and serves the file from that repo at that tag
- if repo not found in target dir, return 404 with text/plain "repository not
  found"
- if version tag not found in repo, return 404 with text/plain "version not
  found" followed by the list of available tags (newest-first, by version sort)
- return successful responses with a public + 1 year + immutable Cache-Control
  header and a strong ETag derived from the Git blob ID
- honor If-None-Match with a 304 response
- succesful responses should mostly have text/javascript or text/typescript MIME
  types
