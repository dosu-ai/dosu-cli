# dosu-cli

The Dosu CLI Utility

## ⚠️ Pre-Release:
The Dosu CLI is pre-release alpha software and is not fully supported currently. Please check back soon. In the mean time, join our [Discord](https://go.dosu.dev/discord-cli) so you'll be the first to know when it's launched!

## Installation

### Homebrew (Recommended)

```bash
brew install dosu-ai/dosu/dosu
```

Or tap first:

```bash
brew tap dosu-ai/dosu
brew install dosu
```

### Manual Download

Download the appropriate archive from the [Releases](https://github.com/dosu-ai/dosu-cli/releases) page.

#### macOS Gatekeeper Warning

When downloading directly from GitHub releases on macOS, you may see:

> "Apple could not verify dosu is free of malware that may harm your Mac or compromise your privacy."

This happens because the binary is not signed with an Apple Developer certificate. To bypass this:

```bash
# After extracting the archive, remove the quarantine attribute:
xattr -d com.apple.quarantine ./dosu
```

Or right-click the binary, select "Open", and click "Open" in the dialog.

**Note:** Installing via Homebrew avoids this issue automatically.

## Releasing (for maintainers)

Releases are automated via [GoReleaser](https://goreleaser.com/) and GitHub Actions.

### Creating a Release

1. **Ensure all changes are committed and pushed to `main`**

2. **Create and push a new tag:**
   ```bash
   # List existing tags
   git tag -l

   # Create a new tag (use semantic versioning)
   git tag v0.1.0

   # Push the tag to trigger the release
   git push origin v0.1.0
   ```

3. **GitHub Actions will automatically:**
   - Build binaries for all platforms (macOS, Linux, Windows)
   - Create a GitHub release with the binaries
   - Generate checksums and changelog

4. **Update the Homebrew formula** (in [homebrew-dosu](https://github.com/dosu-ai/homebrew-dosu)):
   ```bash
   cd homebrew-dosu
   ./scripts/update-formula.sh 0.1.0
   git add Formula/dosu.rb
   git commit -m "Update dosu to v0.1.0"
   git push
   ```

### Version Naming

- Production releases: `v1.0.0`, `v1.1.0`, `v2.0.0`
- Pre-releases: `v0.1.0-alpha`, `v0.1.0-beta`, `v0.1.0-rc1`

Pre-release tags (containing `-alpha`, `-beta`, `-rc`) are automatically marked as pre-releases on GitHub.
