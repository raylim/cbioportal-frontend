#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PLAYWRIGHT_BIN="$SCRIPT_DIR/../node_modules/.bin/playwright"

has_display() {
    [[ -n "${DISPLAY:-}" || -n "${WAYLAND_DISPLAY:-}" ]]
}

has_arg() {
    local needle="$1"
    shift
    local arg
    for arg in "$@"; do
        if [[ "$arg" == "$needle" ]]; then
            return 0
        fi
    done
    return 1
}

args=()
for arg in "$@"; do
    # pnpm run <script> -- <args> forwards a literal standalone "--".
    # Playwright does not need it here, and leaving it in can cause the
    # remaining arguments to be interpreted as test filters incorrectly.
    if [[ "$arg" == "--" ]]; then
        continue
    fi
    args+=("$arg")
done

# Host-mode defaults to headed for interactive local work, but that fails on
# SSH-only machines and headless CI runners. Keep the old headed behavior when
# a display is available and fall back to headless when it is not.
if has_arg "test" "${args[@]}" &&
    [[ "${PW_FORCE_HEADLESS:-0}" != "1" ]] &&
    ! has_arg "--headed" "${args[@]}" &&
    ! has_arg "--ui" "${args[@]}" &&
    ! has_arg "--debug" "${args[@]}" &&
    has_display; then
    args+=("--headed")
fi

exec "$SCRIPT_DIR/with-env.sh" "$PLAYWRIGHT_BIN" "${args[@]}"
