#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "$script_dir/.." && pwd)"
env_file="${SURFCAM_ENV_FILE:-$repo_dir/.env}"
port="${SURFCAM_PORT:-8090}"
session="${PLAYWRIGHT_SESSION:-mobile}"
url="http://127.0.0.1:${port}/index.html"
server_log="${TMPDIR:-/tmp}/surfcam-webkit-${port}.log"

for command in node python3 playwright-cli; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$command" >&2
    exit 1
  fi
done

if [[ ! -f "$env_file" ]]; then
  printf 'Stream URL file not found: %s\n' "$env_file" >&2
  exit 1
fi

stream_urls=()
while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%$'\r'}"
  [[ -z "${line//[[:space:]]/}" || "$line" == \#* ]] && continue

  # Support both the repository's one-URL-per-line format and conventional
  # KEY=https://... .env entries without sourcing arbitrary shell code.
  value="$line"
  if [[ "$value" == *=* ]]; then
    value="${value#*=}"
  fi
  value="${value#\"}"
  value="${value%\"}"
  value="${value#\'}"
  value="${value%\'}"
  [[ "$value" =~ ^https?:// ]] || continue
  stream_urls+=("$value")
done < "$env_file"

if (( ${#stream_urls[@]} == 0 )); then
  printf 'No http(s) stream URLs found in %s\n' "$env_file" >&2
  exit 1
fi

# Build the app's localStorage shape in memory. The URL list is never written
# to a generated file; isolated browser storage disappears with the session.
stream_config_json="$({ printf '%s\n' "${stream_urls[@]}"; } | node -e '
  const fs = require("node:fs");
  const urls = fs.readFileSync(0, "utf8").split(/\r?\n/).filter(Boolean);
  process.stdout.write(JSON.stringify(urls.map(url => ({ url, enabled: true }))));
')"

python3 -m http.server "$port" --bind 127.0.0.1 --directory "$repo_dir" >"$server_log" 2>&1 &
server_pid=$!

cleanup() {
  playwright-cli -s="$session" close >/dev/null 2>&1 || true
  if kill -0 "$server_pid" >/dev/null 2>&1; then
    kill "$server_pid" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

sleep 1
PLAYWRIGHT_MCP_DEVICE='iPhone 15' \
PLAYWRIGHT_MCP_BROWSER=webkit \
PLAYWRIGHT_MCP_ISOLATED=true \
playwright-cli -s="$session" open "$url" --browser webkit

playwright-cli -s="$session" localstorage-set liveDvrStreamConfigs_v1 "$stream_config_json" >/dev/null
playwright-cli -s="$session" reload >/dev/null

printf '\nMobile WebKit session is ready.\n'
printf 'URL: %s\n' "$url"
printf 'Session: %s\n' "$session"
printf 'Streams loaded from: %s\n' "$env_file"
printf 'Press Enter or Ctrl-C to stop the server and browser.\n'
read -r
