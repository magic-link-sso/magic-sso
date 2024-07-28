#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Wojciech Polak

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
docs_dir="${repo_root}/docs"

if ! command -v plantuml >/dev/null 2>&1; then
    echo "plantuml is required to regenerate flow diagram images." >&2
    exit 1
fi

render_diagram() {
    local source_file="$1"
    local light_png="$2"
    local dark_png="$3"

    plantuml -tpng -pipe <"${source_file}" >"${light_png}"
    plantuml -tpng -darkmode -pipe <"${source_file}" >"${dark_png}"

    echo "Generated:"
    echo "  ${light_png}"
    echo "  ${dark_png}"
}

render_diagram \
    "${docs_dir}/MagicLinkSSO-Flow.puml" \
    "${docs_dir}/MagicLinkSSO_Flow_light.png" \
    "${docs_dir}/MagicLinkSSO_Flow_dark.png"

render_diagram \
    "${docs_dir}/MagicLinkSSO-Gate-Flow.puml" \
    "${docs_dir}/MagicLinkSSO_Gate_Flow_light.png" \
    "${docs_dir}/MagicLinkSSO_Gate_Flow_dark.png"

render_diagram \
    "${docs_dir}/MagicLinkSSO-Overview.puml" \
    "${docs_dir}/MagicLinkSSO_Overview_light.png" \
    "${docs_dir}/MagicLinkSSO_Overview_dark.png"
