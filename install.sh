#!/bin/sh
#
# NaijaCloud CLI + MCP server installer.
#
#   curl -fsSL https://raw.githubusercontent.com/naijacloud/nc-cli/main/install.sh | sh
#
# Read this script before piping it to a shell. It:
#   1. works out your platform and the release to install
#   2. downloads that release's archive from GitHub
#   3. verifies its SHA-256 against the release's published checksums
#   4. unpacks it into ~/.local/share/naijacloud and symlinks both
#      ~/.local/bin/naijacloud and the short alias ~/.local/bin/njc
#
# The download is a self-contained executable — it embeds its own runtime, so
# Node.js is NOT required. Nothing runs as root and nothing is written outside
# your home directory.
#
# Prefer a package manager if you use one:
#   brew install naijacloud            # macOS / Linux
#   scoop install naijacloud           # Windows
#   winget install NaijaCloud.CLI      # Windows
#   npm install -g @naijacloud/cli      # any platform with Node >= 20
#
# Overridable with environment variables:
#   NAIJACLOUD_VERSION    release to install, e.g. 0.2.0  (default: latest)
#   NAIJACLOUD_REPO_SLUG  GitHub owner/repo               (default below)
#   NAIJACLOUD_BASE_URL   mirror holding the same files   (default: the release)
#   NAIJACLOUD_HOME       where the binary lives          (default: ~/.local/share/naijacloud)
#   NAIJACLOUD_BIN_DIR    where the symlink goes          (default: ~/.local/bin)

set -eu

REPO_SLUG="${NAIJACLOUD_REPO_SLUG:-naijacloud/nc-cli}"
VERSION="${NAIJACLOUD_VERSION:-latest}"
INSTALL_DIR="${NAIJACLOUD_HOME:-$HOME/.local/share/naijacloud}"
BIN_DIR="${NAIJACLOUD_BIN_DIR:-$HOME/.local/bin}"

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

if [ -t 1 ]; then
  BOLD="$(printf '\033[1m')"; RED="$(printf '\033[31m')"
  GREEN="$(printf '\033[32m')"; YELLOW="$(printf '\033[33m')"
  RESET="$(printf '\033[0m')"
else
  BOLD=""; RED=""; GREEN=""; YELLOW=""; RESET=""
fi

info()  { printf '%s\n' "$*"; }
step()  { printf '%s==>%s %s\n' "$BOLD" "$RESET" "$*"; }
warn()  { printf '%swarning:%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
die()   { printf '%serror:%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

has() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
# 1. Platform
# ---------------------------------------------------------------------------

step "Detecting your platform"

has curl || die "curl is required but not on your PATH."
has tar  || die "tar is required but not on your PATH."

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin) OS_NAME="darwin" ;;
  Linux)  OS_NAME="linux"  ;;
  *)
    die "No prebuilt binary for '$OS'.
  On Windows use: winget install NaijaCloud.CLI  (or scoop install naijacloud)
  Anywhere with Node >= 20: npm install -g @naijacloud/cli"
    ;;
esac

case "$ARCH" in
  x86_64|amd64)  ARCH_NAME="amd64" ;;
  arm64|aarch64) ARCH_NAME="arm64" ;;
  *)
    die "No prebuilt binary for '$ARCH'.
  Install with npm instead: npm install -g @naijacloud/cli"
    ;;
esac

TARGET="${OS_NAME}_${ARCH_NAME}"
info "  $OS $ARCH -> $TARGET"

# ---------------------------------------------------------------------------
# 2. Release
# ---------------------------------------------------------------------------

step "Resolving the release"

if [ "$VERSION" = "latest" ]; then
  # Read the tag from the API rather than following /releases/latest, so the
  # version is known before anything is downloaded and can be printed on error.
  VERSION="$(
    curl -fsSL "https://api.github.com/repos/${REPO_SLUG}/releases/latest" 2>/dev/null \
      | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([^"]*\)".*/\1/p' \
      | head -1
  )" || true

  [ -n "$VERSION" ] || die "Could not determine the latest release of ${REPO_SLUG}.
  Set one explicitly:  NAIJACLOUD_VERSION=0.1.0 sh install.sh"
fi

VERSION="${VERSION#v}"
# NAIJACLOUD_BASE_URL points the download at a mirror or an internal artifact
# host; the layout and filenames are expected to match the GitHub release.
BASE="${NAIJACLOUD_BASE_URL:-https://github.com/${REPO_SLUG}/releases/download/v${VERSION}}"
ARCHIVE="naijacloud_${VERSION}_${TARGET}.tar.gz"
CHECKSUMS="naijacloud_${VERSION}_checksums.txt"

info "  v$VERSION"

# ---------------------------------------------------------------------------
# 3. Download and verify
# ---------------------------------------------------------------------------

step "Downloading $ARCHIVE"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM

curl -fsSL "$BASE/$ARCHIVE" -o "$TMP/$ARCHIVE" || die "Could not download $BASE/$ARCHIVE
  Check that v$VERSION exists and includes a build for $TARGET."

# A tampered or truncated download is the one failure worth catching here, so
# the checksum is verified before anything is unpacked or made executable.
if curl -fsSL "$BASE/$CHECKSUMS" -o "$TMP/$CHECKSUMS" 2>/dev/null; then
  EXPECTED="$(sed -n "s/^\([a-f0-9]\{64\}\)[[:space:]][[:space:]]*\*\{0,1\}${ARCHIVE}$/\1/p" "$TMP/$CHECKSUMS" | head -1)"

  if [ -z "$EXPECTED" ]; then
    warn "$CHECKSUMS has no entry for $ARCHIVE; skipping verification."
  elif has sha256sum; then
    ACTUAL="$(sha256sum "$TMP/$ARCHIVE" | cut -d' ' -f1)"
  elif has shasum; then
    ACTUAL="$(shasum -a 256 "$TMP/$ARCHIVE" | cut -d' ' -f1)"
  else
    warn "Neither sha256sum nor shasum is available; skipping verification."
  fi

  if [ -n "${ACTUAL:-}" ] && [ -n "$EXPECTED" ]; then
    [ "$ACTUAL" = "$EXPECTED" ] || die "Checksum mismatch for $ARCHIVE.
  expected $EXPECTED
  actual   $ACTUAL
  Do not use this download."
    info "  sha256 verified"
  fi
else
  warn "Could not fetch $CHECKSUMS; skipping verification."
fi

# ---------------------------------------------------------------------------
# 4. Install
# ---------------------------------------------------------------------------

step "Installing to $INSTALL_DIR"

if [ -e "$INSTALL_DIR" ] && [ ! -d "$INSTALL_DIR" ]; then
  die "$INSTALL_DIR exists and is not a directory. Move it aside and re-run."
fi

mkdir -p "$INSTALL_DIR/bin"
tar -xzf "$TMP/$ARCHIVE" -C "$INSTALL_DIR/bin" || die "Could not unpack $ARCHIVE."
chmod +x "$INSTALL_DIR/bin/naijacloud"

# macOS quarantines anything downloaded by curl; clearing it here avoids the
# "cannot be opened because the developer cannot be verified" dialog.
if [ "$OS_NAME" = "darwin" ] && has xattr; then
  xattr -d com.apple.quarantine "$INSTALL_DIR/bin/naijacloud" 2>/dev/null || true
fi

INSTALLED_VERSION="$("$INSTALL_DIR/bin/naijacloud" --version 2>/dev/null || true)"
[ -n "$INSTALLED_VERSION" ] || die "The downloaded binary did not run. Report this with your OS and architecture."

# ---------------------------------------------------------------------------
# 5. Link onto PATH — user-owned, no sudo
# ---------------------------------------------------------------------------

step "Linking the naijacloud and njc executables"

mkdir -p "$BIN_DIR" || die "Could not create $BIN_DIR"

LINK="$BIN_DIR/naijacloud"
if [ -e "$LINK" ] && [ ! -L "$LINK" ]; then
  die "$LINK exists and is not a symlink. Move it aside and re-run."
fi

ln -sf "$INSTALL_DIR/bin/naijacloud" "$LINK"
info "  $LINK -> $INSTALL_DIR/bin/naijacloud"

# `njc` is the short alias for the same binary. Unlike the primary name a clash
# here is not fatal: the install is already usable, so it warns and moves on
# rather than throwing away a good install over a convenience alias.
ALIAS_LINK="$BIN_DIR/njc"
ALIAS_LINKED=0
if [ -e "$ALIAS_LINK" ] && [ ! -L "$ALIAS_LINK" ]; then
  warn "$ALIAS_LINK exists and is not a symlink; leaving it alone.
  Only the 'naijacloud' command was installed. Remove that file and re-run to get 'njc'."
elif ln -sf "$INSTALL_DIR/bin/naijacloud" "$ALIAS_LINK" 2>/dev/null; then
  ALIAS_LINKED=1
  info "  $ALIAS_LINK -> $INSTALL_DIR/bin/naijacloud"
else
  warn "Could not link $ALIAS_LINK; only the 'naijacloud' command was installed."
fi

ON_PATH=0
case ":$PATH:" in
  *":$BIN_DIR:"*) ON_PATH=1 ;;
esac

# ---------------------------------------------------------------------------
# 6. Next steps
# ---------------------------------------------------------------------------

printf '\n%sInstalled naijacloud %s%s\n\n' "$GREEN$BOLD" "$INSTALLED_VERSION" "$RESET"

if [ "$ON_PATH" -eq 0 ]; then
  case "${SHELL:-}" in
    */zsh)  RC="~/.zshrc"  ;;
    */bash) RC="~/.bashrc" ;;
    */fish) RC="~/.config/fish/config.fish" ;;
    *)      RC="your shell's startup file" ;;
  esac

  warn "$BIN_DIR is not on your PATH."
  info ""
  info "  Add it by appending this line to $RC, then opening a new shell:"
  info ""
  info "      export PATH=\"$BIN_DIR:\$PATH\""
  info ""
  info "  Until then, use the full path: $LINK"
  info ""
fi

if [ "$ALIAS_LINKED" -eq 1 ]; then
  info "Every command below also works as 'njc' — 'njc deploy' is 'naijacloud deploy'."
  info ""
fi

info "Next steps:"
info ""
info "  1. Sign in (stores a token in ~/.naijacloud/config.json, mode 0600):"
info ""
info "       naijacloud login"
info ""
info "  2. Deploy a site:"
info ""
info "       naijacloud deploy"
info ""
info "  3. Register the MCP server with Claude Code:"
info ""
info "       claude mcp add --transport stdio naijacloud -- naijacloud mcp"
info ""
info "  No token goes into the MCP config — the server reads the credentials"
info "  that 'naijacloud login' already stored."
info ""
