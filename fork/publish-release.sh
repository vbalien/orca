#!/usr/bin/env bash
# 검증을 통과한 포크 릴리즈 초안을 게시하고, 게시가 확인되면 포크 main을 그 릴리즈로 맞춘다(fork/sync-main.sh).
# 검증 때 기록한 것(릴리즈 ID, 태그 커밋, 모든 자산의 이름·크기·sha256)과 지금 초안이 같을 때만 게시한다.
# 자동 검증(기록)과 별개로, 사람이 화면 확인(fork/screen-checks.txt)을 마쳤다고 --screens-checked로 밝혀야 게시한다.
# 게시 직전에 업스트림의 게시된 최신 릴리즈를 다시 확인해 이 릴리즈의 기준보다 새것이면, 또 포크의 지금 Latest보다
# 오래된 태그면 게시하지 않는다. 같은 컴퓨터의 게시·동기화는 잠금으로 하나씩만 돈다.
#   fork/publish-release.sh fork-vX.Y.Z-N --screens-checked
# 종료: 0 게시·main 맞춤, 1 멈춤(게시 안 함, 또는 게시는 됐고 main은 못 맞춤), 2 결과 미확정(안내대로 확인).
set -euo pipefail
TAG=${1:-}
[[ "$TAG" =~ ^fork-v[0-9]+\.[0-9]+\.[0-9]+-[0-9]+$ && $# -le 2 ]] || { echo "사용법: $0 fork-vX.Y.Z-N --screens-checked" >&2; exit 1; }
if [[ "${2:-}" != --screens-checked ]]; then
  cat "$(dirname "${BASH_SOURCE[0]}")/screen-checks.txt" >&2
  echo "위 화면 확인을 이 초안의 자산으로 마친 뒤: $0 $TAG --screens-checked (릴리즈 노트가 이 확인을 했다고 적는다)" >&2
  exit 1
fi
FORK_REPO=vbalien/orca
MS_REPO=$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)
# shellcheck source=fork/lib-main-sync.sh
source "$MS_REPO/fork/lib-main-sync.sh"
die() { ms_die "$*" || exit 1; }
# gh는 호스트를 고정한다(GH_HOST 영향 차단).
ghs() { timeout -k 5 60 gh "$@"; }
command -v gh >/dev/null || die "gh가 필요하다"
ms_lock || exit 1
release_state() { # <태그> → published|draft|error
  local d
  d=$(ghs release view "$1" --repo "github.com/$FORK_REPO" --json isDraft --jq .isDraft 2>/dev/null) || { echo error; return; }
  case "$d" in false) echo published ;; true) echo draft ;; *) echo error ;; esac
}
pc=0
ms_pending_check release_state || pc=$?
case $pc in
  0) ;;
  3) exit 1 ;; # 미확정이던 게시가 확인됐다: 그 태그의 sync부터(안내 출력됨)
  *) exit 1 ;;
esac

RECORD=$MS_STATE_DIR/verified-$TAG.json
[[ -f "$RECORD" ]] || die "검증 기록이 없다: $RECORD (먼저 fork/verify-linux-release.sh $TAG)"
snapshot() {
  local id
  id=$(ghs release view "$TAG" --repo "github.com/$FORK_REPO" --json databaseId,isDraft,body \
    --jq 'select(.isDraft and (.body | contains("<!-- fork-release: uploading -->") | not)) | .databaseId') ||
    { echo "초안 $TAG을 읽지 못했다(이미 게시됐거나 없음)" >&2; return 1; }
  [[ -n "$id" ]] || { echo "$TAG이 다 올라간 초안이 아니다(업로드 중·게시됨·없음)" >&2; return 1; }
  ghs api --hostname github.com "repos/$FORK_REPO/releases/$id" --jq '{id, tag: .tag_name,
    commit: .target_commitish, assets: ([.assets[] | {name, size, digest}] | sort_by(.name))}'
}
now=$(snapshot)
tag_commit=$(ghs api --hostname github.com "repos/$FORK_REPO/commits/$TAG" --jq .sha)
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
latest=$(ghs api --hostname github.com repos/stablyai/orca/releases/latest --jq .tag_name) ||
  die "업스트림의 게시된 최신 릴리즈를 확인하지 못했다. 게시하지 않는다."
[[ "$latest" =~ ^v([0-9]+\.[0-9]+\.[0-9]+)$ ]] ||
  die "업스트림 최신 릴리즈 태그 형식이 이상하다: '$latest'. 게시하지 않는다."
if [[ "${BASH_REMATCH[1]}" != "$BASE" && "$(printf '%s\n' "${BASH_REMATCH[1]}" "$BASE" | sort -V | tail -n 1)" != "$BASE" ]]; then
  echo "업스트림이 $latest를 게시했다(이 릴리즈의 기준 v$BASE보다 새것). 게시하지 않는다." >&2
  echo "새 기준으로 다시 낸다: fork/rebase-onto-release.sh $latest --release 1" >&2
  exit 1
fi
echo "업스트림 게시 최신: $latest (기준 v$BASE)"
# 포크의 지금 Latest보다 오래된 릴리즈는 게시하지 않는다(Latest·main 역행 방지).
# 조회 실패·예상 밖 응답이면 게시하지 않는다. Latest가 아직 없는 것(404)만 따로 허용한다(첫 게시).
latest_err=$(mktemp)
if fork_latest=$(ghs api --hostname github.com "repos/$FORK_REPO/releases/latest" --jq .tag_name 2>"$latest_err"); then
  [[ "$fork_latest" =~ ^fork-v[0-9]+\.[0-9]+\.[0-9]+-[0-9]+$ ]] ||
    { rm -f "$latest_err"; die "포크 Latest 태그 형식이 이상하다: '$fork_latest'. 게시하지 않는다."; }
  if ms_tag_older "$TAG" "$fork_latest"; then
    rm -f "$latest_err"
    die "$TAG는 포크의 지금 Latest($fork_latest)보다 오래됐다. 게시하지 않는다."
  fi
elif grep -q 'HTTP 404' "$latest_err"; then
  echo "포크에 아직 Latest 릴리즈가 없다(첫 게시)."
else
  echo "$(head -c 300 "$latest_err")" >&2
  rm -f "$latest_err"
  die "포크 Latest 릴리즈를 확인하지 못했다. 게시하지 않는다."
fi
rm -f "$latest_err"

# 게시 요청 전에 미확정 기록을 남긴다(요청 뒤 끊겨도 다음 실행이 이 태그부터 본다). 게시가 확인되면 지운다.
ms_pending_set "$TAG" || die "미확정 기록($(ms_pending_file))을 쓰지 못했다. 게시하지 않는다."
ghs release edit "$TAG" --repo "github.com/$FORK_REPO" --draft=false --latest >/dev/null || true
state=$(release_state "$TAG")
if [[ "$state" != published ]]; then
  echo "게시 결과 미확정(지금 상태: $state). 서버가 늦게 처리할 수 있다." >&2
  echo "확인: gh release view $TAG --repo github.com/$FORK_REPO --json isDraft — 게시됐으면 fork/sync-main.sh $TAG, 아직 초안이면 $(ms_pending_file)를 지우고 이 명령을 다시." >&2
  exit 2
fi
ms_pending_clear
echo "게시함: https://github.com/$FORK_REPO/releases/tag/$TAG"
sync_rc=0
"$MS_REPO/fork/sync-main.sh" "$TAG" || sync_rc=$?
case $sync_rc in
  0) ;;
  2)
    echo "릴리즈는 게시됐고 main 갱신 결과는 미확정이다. 다시 돌리기 전에 확인: git ls-remote https://github.com/$FORK_REPO refs/heads/main" >&2
    exit 2
    ;;
  *)
    echo "릴리즈는 게시됐다. main은 맞추지 못했다: 위 이유를 확인한 뒤 fork/sync-main.sh $TAG [--confirm-ported …]" >&2
    exit 1
    ;;
esac
