#!/usr/bin/env bash
# 검증을 통과한 포크 릴리즈 초안을 게시한다. 검증 때 기록한 것(릴리즈 ID, 태그 커밋, 모든 자산의 이름·크기·sha256)과
# 지금 초안이 같을 때만 게시한다(그사이 재실행 등으로 자산이 바뀌었으면 멈추고 다시 검증하라고 한다).
# 자동 검증(기록)과 별개로, 사람이 화면 확인(fork/screen-checks.txt)을 마쳤다고 --screens-checked로 밝혀야 게시한다.
# 게시 직전에 업스트림의 게시된 최신 릴리즈를 다시 확인해, 이 릴리즈의 기준보다 새것이면 게시하지 않는다
# (포크 릴리즈는 게시된 최신 업스트림 위에 낸다; 기준이 아직 미게시 태그인 것은 괜찮다).
#   fork/publish-release.sh fork-vX.Y.Z-N --screens-checked
set -euo pipefail
TAG=${1:-}
[[ "$TAG" =~ ^fork-v[0-9]+\.[0-9]+\.[0-9]+-[0-9]+$ && $# -le 2 ]] || { echo "사용법: $0 fork-vX.Y.Z-N --screens-checked" >&2; exit 1; }
if [[ "${2:-}" != --screens-checked ]]; then
  cat "$(dirname "${BASH_SOURCE[0]}")/screen-checks.txt" >&2
  echo "위 화면 확인을 이 초안의 자산으로 마친 뒤: $0 $TAG --screens-checked (릴리즈 노트가 이 확인을 했다고 적는다)" >&2
  exit 1
fi
FORK_REPO=vbalien/orca
RECORD=$HOME/orca-fork-build/verified-$TAG.json
[[ -f "$RECORD" ]] || { echo "검증 기록이 없다: $RECORD (먼저 fork/verify-linux-release.sh $TAG)" >&2; exit 1; }
snapshot() {
  local id
  id=$(timeout -k 5 60 gh release view "$TAG" -R "$FORK_REPO" --json databaseId,isDraft,body \
    --jq 'select(.isDraft and (.body | contains("<!-- fork-release: uploading -->") | not)) | .databaseId') ||
    { echo "초안 $TAG을 읽지 못했다(이미 게시됐거나 없음)" >&2; return 1; }
  [[ -n "$id" ]] || { echo "$TAG이 다 올라간 초안이 아니다(업로드 중·게시됨·없음)" >&2; return 1; }
  timeout -k 5 60 gh api "repos/$FORK_REPO/releases/$id" --jq '{id, tag: .tag_name,
    commit: .target_commitish, assets: ([.assets[] | {name, size, digest}] | sort_by(.name))}'
}
now=$(snapshot)
tag_commit=$(timeout -k 5 60 gh api "repos/$FORK_REPO/commits/$TAG" --jq .sha)
# target_commitish는 브랜치 이름일 수 있으므로 태그가 가리키는 커밋은 따로 비교한다.
expected=$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(JSON.stringify({id:r.release.id, assets:r.release.assets, commit:r.tagCommit}))' "$RECORD")
actual=$(printf '%s' "$now" | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log(JSON.stringify({id:r.id, assets:r.assets, commit:process.argv[1]}))' "$tag_commit")
if [[ "$expected" != "$actual" ]]; then
  echo "검증한 뒤 초안이 바뀌었다. 다시 검증한다: fork/verify-linux-release.sh $TAG" >&2
  diff <(printf '%s\n' "$expected" | node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(0,"utf8")),null,1))') \
    <(printf '%s\n' "$actual" | node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(0,"utf8")),null,1))') >&2 || true
  exit 1
fi
BASE=${TAG#fork-v}
BASE=${BASE%-*}
latest=$(timeout -k 5 60 gh api repos/stablyai/orca/releases/latest --jq .tag_name) ||
  { echo "업스트림의 게시된 최신 릴리즈를 확인하지 못했다. 게시하지 않는다." >&2; exit 1; }
[[ "$latest" =~ ^v([0-9]+\.[0-9]+\.[0-9]+)$ ]] ||
  { echo "업스트림 최신 릴리즈 태그 형식이 이상하다: '$latest'. 게시하지 않는다." >&2; exit 1; }
if [[ "${BASH_REMATCH[1]}" != "$BASE" && "$(printf '%s\n' "${BASH_REMATCH[1]}" "$BASE" | sort -V | tail -n 1)" != "$BASE" ]]; then
  echo "업스트림이 $latest를 게시했다(이 릴리즈의 기준 v$BASE보다 새것). 게시하지 않는다." >&2
  echo "새 기준으로 다시 낸다: fork/rebase-onto-release.sh $latest --release 1" >&2
  exit 1
fi
echo "업스트림 게시 최신: $latest (기준 v$BASE)"
# 이 릴리즈를 포크의 Latest로 둔다(예전 포크 릴리즈는 그대로 남는다).
timeout -k 5 60 gh release edit "$TAG" -R "$FORK_REPO" --draft=false --latest >/dev/null
echo "게시함: $(gh release view "$TAG" -R "$FORK_REPO" --json url --jq .url)"
