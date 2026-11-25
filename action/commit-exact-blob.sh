#!/usr/bin/env bash
# Commits the exact judged bytes onto DEFAULT_BRANCH using the GitHub Git Data API.
# Never runs git merge or GitHub's merge API. Verifies DEFAULT_BRANCH still holds HOLDER_BLOB,
# creates blob + tree + commit, and updates refs/heads/$DEFAULT_BRANCH with force: false.
# Idempotent on repeat run if DEFAULT_BRANCH already holds CANDIDATE_BLOB from the same PR+HEAD_SHA.
#
# Exit codes:
#   0 -> committed (or idempotent repeat; outputs JSON {recorded, repeat, record_sha})
#   1 -> stale (DEFAULT_BRANCH moved away from HOLDER_BLOB before commit landed)
#   2 -> fault (invalid inputs, hash mismatch, or GitHub API failure)
set -euo pipefail

: "${REPO:?}" "${DEFAULT_BRANCH:?}" "${GH_TOKEN:?}"
: "${FILE_PATH:?}" "${CANDIDATE_FILE:?}" "${CANDIDATE_BLOB:?}" "${HOLDER_BLOB:?}"
: "${PR:?}" "${HEAD_SHA:?}"

printf '%s' "$PR" | grep -Eqx '[1-9][0-9]{0,6}' || { echo "bad pull request number" >&2; exit 2; }
printf '%s' "$HEAD_SHA" | grep -Eqx '[0-9a-f]{40}' || { echo "bad head sha" >&2; exit 2; }
printf '%s' "$CANDIDATE_BLOB" | grep -Eqx '[0-9a-f]{40}' || { echo "bad candidate blob sha" >&2; exit 2; }
printf '%s' "$HOLDER_BLOB" | grep -Eqx '[0-9a-f]{40}' || { echo "bad holder blob sha" >&2; exit 2; }
[ -s "$CANDIDATE_FILE" ] || { echo "missing or empty candidate file" >&2; exit 2; }

local_sha=$(git hash-object "$CANDIDATE_FILE")
if [ "$local_sha" != "$CANDIDATE_BLOB" ]; then
  echo "candidate file hash ($local_sha) does not match judged blob ($CANDIDATE_BLOB)" >&2
  exit 2
fi

trailer="Pull request #$PR, commit $HEAD_SHA."
if [ -n "${COMMIT_MESSAGE:-}" ]; then
  message="$COMMIT_MESSAGE"
  case "$message" in
    *"$trailer"*) ;;
    *) message="${message}"$'\n\n'"${trailer}" ;;
  esac
else
  step_label="${STEP:-0}"
  target_label="${TARGET:-target}"
  author_label="${AUTHOR:-contributor}"
  message="step-${step_label}: verified ${target_label} by ${author_label}"$'\n\n'"${trailer}"
fi

api() {
  gh api -H "X-GitHub-Api-Version: 2022-11-28" "$@"
}

blob_at() {
  api "repos/$REPO/contents/$2?ref=$1" --jq .sha 2>/dev/null
}

b64_file=$(mktemp)
trap 'rm -f "$b64_file"' EXIT
base64 < "$CANDIDATE_FILE" | tr -d '\n' > "$b64_file"

for _ in 1 2 3 4; do
  main_sha=$(api "repos/$REPO/git/ref/heads/$DEFAULT_BRANCH" --jq .object.sha) || exit 2
  now_blob=$(blob_at "$main_sha" "$FILE_PATH") || exit 2

  if [ "$now_blob" = "$CANDIDATE_BLOB" ]; then
    last_msg=$(api "repos/$REPO/commits?sha=$main_sha&path=$FILE_PATH&per_page=1" \
      --jq '.[0].commit.message') || exit 2
    if grep -Fqx "$trailer" <<<"$last_msg"; then
      last_commit=$(api "repos/$REPO/commits?sha=$main_sha&path=$FILE_PATH&per_page=1" \
        --jq '.[0].sha') || exit 2
      jq -cn --arg sha "$last_commit" '{recorded: true, repeat: true, record_sha: $sha}'
      exit 0
    fi
    exit 1
  fi

  [ "$now_blob" = "$HOLDER_BLOB" ] || exit 1

  blob=$(jq -n --rawfile content "$b64_file" '{content: $content, encoding: "base64"}' \
    | api -X POST "repos/$REPO/git/blobs" --input - --jq .sha) || exit 2
  [ "$blob" = "$CANDIDATE_BLOB" ] || exit 2

  base_tree=$(api "repos/$REPO/git/commits/$main_sha" --jq .tree.sha) || exit 2
  tree_items=$(jq -cn --arg path "$FILE_PATH" --arg sha "$blob" \
    '[{path: $path, mode: "100644", type: "blob", sha: $sha}]')

  if [ -n "${EXTRA_TREE_ITEMS_JSON:-}" ]; then
    tree_items=$(jq -cn --argjson cur "$tree_items" --argjson extra "$EXTRA_TREE_ITEMS_JSON" '$cur + $extra')
  fi

  new_tree=$(jq -n --arg base "$base_tree" --argjson items "$tree_items" \
    '{base_tree: $base, tree: $items}' \
    | api -X POST "repos/$REPO/git/trees" --input - --jq .sha) || exit 2

  new_commit=$(jq -n --arg message "$message" --arg tree "$new_tree" --arg parent "$main_sha" \
    '{message: $message, tree: $tree, parents: [$parent]}' \
    | api -X POST "repos/$REPO/git/commits" --input - --jq .sha) || exit 2

  if jq -n --arg sha "$new_commit" '{sha: $sha, force: false}' \
    | api -X PATCH "repos/$REPO/git/refs/heads/$DEFAULT_BRANCH" --input - >/dev/null 2>&1; then
    [ "$(blob_at "$new_commit" "$FILE_PATH")" = "$CANDIDATE_BLOB" ] || exit 2
    jq -cn --arg sha "$new_commit" '{recorded: true, repeat: false, record_sha: $sha}'
    exit 0
  fi
done

exit 1
