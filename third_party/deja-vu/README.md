# Dosu Drive deja-vu runtime

Dosu Drive bundles a private macOS build of
[vshulcz/deja-vu](https://github.com/vshulcz/deja-vu) under its MIT license.
It does not replace or configure a user's own `deja` installation.

- Upstream release: `v0.17.3`
- Upstream commit: `8e6e440e70eca808d9f26e54e3f4eeaee6213277`
- Dosu runtime version: `0.17.3-dosu.1`
- Dosu changes: early selected-repository filtering, related Git
  checkout/worktree matching, and machine-readable scan-path progress
- Reproducible change set: `dosu-project-scope.patch`

Build from an upstream checkout after applying the patch:

```sh
CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -trimpath \
  -ldflags '-s -w -buildid= -X main.version=0.17.3-dosu.1' \
  -o bin/runtime/deja-darwin-arm64 ./cmd/deja

CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 go build -trimpath \
  -ldflags '-s -w -buildid= -X main.version=0.17.3-dosu.1' \
  -o bin/runtime/deja-darwin-x64 ./cmd/deja
```

Bundled SHA-256:

- arm64: `b9ed47eebb9ea84812c44775cc1d85be7587ca141a233fad5471f2a9ab0a8bdf`
- x64: `19e1eb6bdd6565faf15461f5fb48669cba929ce1ff7a71249ff938f95f082b80`
