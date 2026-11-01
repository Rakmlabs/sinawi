#!/bin/bash
# Ad-hoc sign the bundle with a stable identifier + designated requirement, so macOS privacy grants
# (TCC: 화면 기록·손쉬운 사용·알림) are keyed to "kr.rakm.agentorchestra" instead of the per-build cdhash.
set -euo pipefail
APP="${1:-src-tauri/target/release/bundle/macos/Agent Orchestra.app}"
ID="kr.rakm.agentorchestra"
codesign --force --deep --sign - --identifier "$ID" -r="designated => identifier \"$ID\"" "$APP"
codesign -d -r- "$APP" 2>&1 | grep designated
