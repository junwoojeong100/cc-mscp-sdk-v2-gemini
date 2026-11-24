#!/usr/bin/env bash
set -euo pipefail

# One-time install of the LiteLLM proxy into .runtime/ (git-ignored).
#
# LiteLLM is a supply-chain-sensitive package, so nothing here floats: pip must
# find a wheel whose SHA-256 equals the pinned value below (--require-hashes) and
# only that file is installed. LiteLLM pins its own proxy dependencies; FastAPI is
# pinned here as well. The package index is whatever your pip is configured to use
# (a corporate mirror or PyPI), so the same command works on both.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${GEMINI_LITELLM_HOME:-$ROOT_DIR/.runtime}"
VENV_DIR="$RUNTIME_DIR/litellm-venv"
KEY_FILE="$RUNTIME_DIR/litellm-master-key"
LITELLM_VERSION="1.97.0"
FASTAPI_VERSION="0.139.0"
PYTHON_VERSION="3.13"

# SHA-256 of the litellm 1.97.0 wheel PyPI published (2026-08-16) for each platform.
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) WHEEL_SHA256="2983b40ed5d8b1bcbbfbc0d66fefa21b04db91b87c05dd680ae77cba74e561ef" ;;
  Darwin-x86_64) WHEEL_SHA256="ff401dd5d66f54b9b474f0652c419fb7bf883fbf5ca64c0bc363acdc98b758b5" ;;
  Linux-aarch64|Linux-arm64) WHEEL_SHA256="e3a1f70d693716b4e8a8108f0a464b0e2c555e274ddbb8ef89c4c59c80be14ed" ;;
  Linux-x86_64) WHEEL_SHA256="5b56dce7df44a6a9e6caf5379de2578a8cb82831ceabd3d71cc99b370a1015e7" ;;
  *)
    echo "No pinned LiteLLM wheel for $(uname -s) $(uname -m)." >&2
    exit 1
    ;;
esac

for command in uv node; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "Required command not found: $command" >&2
    [[ "$command" == "uv" ]] && echo "Install it with: brew install uv" >&2
    exit 1
  }
done

installed_version() {
  "$VENV_DIR/bin/python" -c 'import importlib.metadata as m; print(m.version("litellm"))' 2>/dev/null || true
}

if [[ -x "$VENV_DIR/bin/litellm" && "$(installed_version)" == "$LITELLM_VERSION" ]]; then
  echo "LiteLLM $LITELLM_VERSION is already installed in .runtime/litellm-venv."
else
  mkdir -p "$RUNTIME_DIR"
  DOWNLOAD_DIR="$(mktemp -d "$RUNTIME_DIR/download.XXXXXX")"
  trap 'rm -rf "$DOWNLOAD_DIR"' EXIT

  # uv does not read pip's configuration; hand it the index pip would use.
  INDEX_URL="${PIP_INDEX_URL:-$(pip3 config list 2>/dev/null | sed -n "s/^[a-z]*\.index-url=['\"]*\([^'\"]*\)['\"]*$/\1/p" | head -1)}"
  UV_INDEX_ARGS=()
  [[ -z "$INDEX_URL" ]] || UV_INDEX_ARGS=(--index-url "$INDEX_URL")

  rm -rf "$VENV_DIR"
  uv venv --quiet --python "$PYTHON_VERSION" "$VENV_DIR"
  "$VENV_DIR/bin/python" -m ensurepip --default-pip >/dev/null

  echo "Downloading litellm==$LITELLM_VERSION (SHA-256 pinned) ..."
  printf 'litellm==%s --hash=sha256:%s\n' "$LITELLM_VERSION" "$WHEEL_SHA256" >"$DOWNLOAD_DIR/requirements.txt"
  "$VENV_DIR/bin/python" -m pip download --quiet --disable-pip-version-check \
    --no-deps --only-binary=:all: --require-hashes \
    -r "$DOWNLOAD_DIR/requirements.txt" -d "$DOWNLOAD_DIR"
  WHEEL_FILE="$(ls "$DOWNLOAD_DIR"/litellm-*.whl)"
  echo "SHA-256 verified: $(basename "$WHEEL_FILE")"

  echo "Installing the proxy and its dependencies ..."
  uv pip install --quiet --python "$VENV_DIR/bin/python" ${UV_INDEX_ARGS[@]+"${UV_INDEX_ARGS[@]}"} \
    "litellm[proxy] @ file://$WHEEL_FILE" "fastapi==$FASTAPI_VERSION"
fi

if [[ ! -f "$KEY_FILE" ]]; then
  node -e '
    const crypto = require("node:crypto");
    const fs = require("node:fs");
    fs.writeFileSync(
      process.argv[1],
      `sk-${crypto.randomBytes(32).toString("hex")}\n`,
      { mode: 0o600 },
    );
  ' "$KEY_FILE"
fi
chmod 600 "$KEY_FILE"

printf 'LiteLLM %s is ready. Start the gateway with: gemini-litellm up\n' "$LITELLM_VERSION"
