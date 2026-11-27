#!/usr/bin/env bash
# scripts/check.sh <target>  judges your working copy of that target's file against the record.
# scripts/check.sh           self-checks every target in targets.json.
# The verdict is read from the checker's own --out file, never from its stdout.
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

workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT
verdict_file="$workdir/verdict.json"

holder_args=()
if base=$(git rev-parse --verify --quiet origin/HEAD 2>/dev/null ||
  git rev-parse --verify --quiet origin/main 2>/dev/null); then
  if git show "$base:$(git rev-parse --show-prefix)$file" >"$workdir/holder.sql" 2>/dev/null; then
    holder_args=(--holder "$workdir/holder.sql")
  fi
fi

node checker/verify.mjs verify --targets targets.json --target "$target" \
  --candidate "$file" ${holder_args[@]+"${holder_args[@]}"} --out "$verdict_file" >/dev/null ||
  {
    echo "verifier failed to run" >&2
    exit 1
  }
if [ ! -s "$verdict_file" ]; then
  echo "verifier wrote no verdict" >&2
  exit 1
fi
cat "$verdict_file"
node -e '
  const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  process.exit(v.verdict === "ACCEPTED" ? 0 : 1);
' "$verdict_file"
