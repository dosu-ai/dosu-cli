# Dosu Drive deja-vu runtime

Dosu Drive bundles a private macOS build of
[vshulcz/deja-vu](https://github.com/vshulcz/deja-vu) under its MIT license.
It does not replace or configure a user's own `deja` installation.

- Upstream release: `v0.17.3`
- Upstream commit: `8e6e440e70eca808d9f26e54e3f4eeaee6213277`
- Dosu patch head: `e23e2af7b630aa864472db9fb28bec124a39cc04`
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

- arm64: `3b5beb9fd7d184bd57904f315d1475e74d88f3b2fac0429947e1a3f52ecd4c01`
- x64: `cf8b212c64a687a366bfd0833ced31db4ba89444fe6b2ef9e3746773df87d97e`
