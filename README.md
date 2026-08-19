# serve-esm

`deno serve` script to serve library sources that can't go on JSR

- GET `/:repo/:version/*file` finds repo in target directory, looks up tag named
  with version, and serves the file from that repo at that tag
