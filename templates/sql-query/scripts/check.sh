#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

target="${1:-}"
if [ -z "$target" ]; then
  exec node checker/verify.mjs --self-check targets.json
fi

file=$(node -e '
  const m = JSON.parse(require("fs").readFileSync("targets.json", "utf8"));
  const t = (m.targets || []).find((x) => x.name === process.argv[1]);
  process.stdout.write(t ? t.file_path : "");
' "$target")
if [ -z "$file" ]; then
  echo "unknown target: $target" >&2
  exit 2
fi

holder_args=()
if base=$(git rev-parse --verify --quiet origin/HEAD 2>/dev/null ||
  git rev-parse --verify --quiet origin/main 2>/dev/null); then
  holder=$(mktemp)
  trap 'rm -f "$holder"' EXIT
  if git show "$base:$(git rev-parse --show-prefix)$file" >"$holder" 2>/dev/null; then
    holder_args=(--holder "$holder")
  fi
fi

verdict=$(node checker/verify.mjs verify --targets targets.json --target "$target" \
  --candidate "$file" ${holder_args[@]+"${holder_args[@]}"})
echo "$verdict"
node -e 'process.exit(JSON.parse(process.argv[1]).verdict === "ACCEPTED" ? 0 : 1)' "$verdict"
