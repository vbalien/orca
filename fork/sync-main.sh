#!/usr/bin/env bash
# 포크 main을 게시된 최신 포크 릴리즈로 맞춘다(fork/publish-release.sh가 게시 성공 뒤 부른다; 단독 실행도 된다).
#   fork/sync-main.sh fork-vX.Y.Z-N [--confirm-ported <SHA>]... [--confirm-upstream <포크SHA>=<업스트림SHA>]...
# main은 그 릴리즈 태그 커밋으로(태그 뒤 브랜치 커밋이 도구 경로만이면 브랜치 끝으로) --force-with-lease로 옮긴다.
# 지금 main에만 있고 새 릴리즈에 없는 포크 커밋이 있으면 멈춘다(조용히 사라지지 않게). 규칙은 fork/README.md.
# 종료: 0 맞춤(또는 이미 같음), 1 멈춤·변경 없음, 2 결과 미확정(원격 main을 직접 확인).
set -euo pipefail

usage() { echo "사용법: $0 fork-vX.Y.Z-N [--confirm-ported <SHA>]... [--confirm-upstream <포크SHA>=<업스트림SHA>]..." >&2; }
TAG='' MS_CONFIRM_PORTED='' MS_CONFIRM_UPSTREAM=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --confirm-ported) [[ "${2:-}" =~ ^[0-9a-f]{40}$ ]] || { usage; exit 1; }; MS_CONFIRM_PORTED+=" $2"; shift 2 ;;
    --confirm-upstream) [[ "${2:-}" =~ ^[0-9a-f]{40}=[0-9a-f]{40}$ ]] || { usage; exit 1; }; MS_CONFIRM_UPSTREAM+=" $2"; shift 2 ;;
    -*) usage; exit 1 ;;
    *) [[ -z "$TAG" ]] || { usage; exit 1; }; TAG=$1; shift ;;
  esac
done
[[ "$TAG" =~ ^fork-v([0-9]+\.[0-9]+\.[0-9]+)-[0-9]+$ ]] || { usage; exit 1; }
VERSION=${BASH_REMATCH[1]}
BRANCH=fork/v$VERSION
FORK=vbalien/orca
UPSTREAM=stablyai/orca

MS_REPO=$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)
# shellcheck source=fork/lib-main-sync.sh
source "$MS_REPO/fork/lib-main-sync.sh"
die() { ms_die "$*" || exit 1; }
net() { timeout -k 10 120 "$@"; }
gnet() { net git -C "$MS_REPO" "$@"; }
ghs() { net gh "$@"; } # 호스트는 호출마다 고정한다(--repo github.com/…, api --hostname github.com)

printf '%s\n%s\n' 2.38 "$(git version | awk '{print $3}')" | sort -V -C || die "git 2.38 이상이 필요하다"
command -v gh >/dev/null || die "gh가 필요하다"
# 어떤 네트워크 작업보다 먼저: 실제 통신 대상 확인.
ms_check_remotes "$FORK" "$UPSTREAM" || exit 1
ms_lock || exit 1

release_state() { # <태그> → published|draft|error
  local d
  d=$(ghs release view "$1" --repo "github.com/$FORK" --json isDraft --jq .isDraft 2>/dev/null) || { echo error; return; }
  case "$d" in false) echo published ;; true) echo draft ;; *) echo error ;; esac
}
latest_tag() { ghs api --hostname github.com "repos/$FORK/releases/latest" --jq .tag_name 2>/dev/null; }
pc=0
ms_pending_check release_state || pc=$?
# 3: 미확정이던 게시가 게시로 확인돼 기록을 지웠다 — 이어서 이 태그가 Latest인지 아래에서 가른다.
case $pc in 0 | 3) ;; *) exit 1 ;; esac

latest=$(latest_tag) || die "vbalien/orca의 Latest 릴리즈를 읽지 못했다"
[[ "$latest" == "$TAG" ]] || die "$TAG는 지금 Latest($latest)가 아니다. main은 Latest 릴리즈로만 맞춘다(의도적인 롤백은 README의 되돌리는 명령으로 사람이)."

say() { printf '== %s\n' "$*"; }
say "가져오기"
gnet fetch --quiet --no-tags origin "+refs/heads/main:refs/remotes/origin/main" "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH" \
  "+refs/tags/$TAG:refs/tags/$TAG" || die "origin에서 main·$BRANCH·$TAG를 가져오지 못했다"
gnet fetch --quiet --no-tags upstream '+refs/tags/v*:refs/tags/v*' || die "upstream 릴리즈 태그를 가져오지 못했다"
upstream_tag_sha() { gnet ls-remote upstream "refs/tags/$1" "refs/tags/$1^{}" | sort -k2 | tail -n 1 | cut -f1; }
base_of() { # <커밋> → 가장 가까운 업스트림 릴리즈 태그(업스트림 것과 같아야)
  local t
  t=$(ms_git describe --tags --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*' --exclude '*-*' "$1") || return 1
  [[ "$(upstream_tag_sha "$t")" == "$(ms_git rev-parse "$t^{commit}")" ]] || return 1
  echo "$t"
}

TAG_COMMIT=$(ms_git rev-parse "$TAG^{commit}")
TIP=$(ms_git rev-parse "refs/remotes/origin/$BRANCH")
M=$(ms_git rev-parse refs/remotes/origin/main)
read -r T why reason < <(ms_pick_target "$TAG_COMMIT" "$TIP")
echo "대상: ${T:0:12} ($([[ $why == tip ]] && echo "브랜치 끝" || echo "태그 커밋") — $reason)"
base=$(base_of "$T") || die "${T:0:12}의 기반 릴리즈 태그가 업스트림 것이 아니다"
[[ "$base" == "v$VERSION" ]] || die "${T:0:12}의 기반이 $base다(v$VERSION이어야)"
merges=$(ms_git rev-list --merges "$base..$T") || die "대상 $base..${T:0:12}의 merge 여부를 읽지 못했다"
[[ -z "$merges" ]] || die "대상 $base..${T:0:12}에 merge 커밋이 있다"

if [[ "$M" == "$T" ]]; then
  echo "main이 이미 ${T:0:12}이다."
  exit 0
fi
B=$(base_of "$M") || die "지금 main(${M:0:12})의 기반 릴리즈 태그를 확인하지 못했다(사람이 확인)"
[[ "$(printf '%s\n' "${B#v}" "$VERSION" | sort -V | tail -n 1)" == "$VERSION" ]] ||
  die "지금 main의 기반 $B가 v$VERSION보다 새것이다(뒤로 가지 않는다)"
merges=$(ms_git rev-list --merges "$B..$M") || die "지금 main($B..main)의 merge 여부를 읽지 못했다"
[[ -z "$merges" ]] || die "지금 main의 포크 커밋($B..main)에 merge 커밋이 있다(사람이 정리)"

say "main에만 있는 포크 커밋 확인 ($B..main 중 새 대상에 없는 것)"
export MS_CONFIRM_PORTED MS_CONFIRM_UPSTREAM
result=$(ms_classify_main "$M" "$T" "$B" "$base") || die "사라질 커밋 판정을 끝내지 못했다(조회 실패). 멈춘다."
[[ -z "$result" ]] || printf '%s\n' "$result" | sed 's/^/  /'
if grep -q '^need ' <<<"$result"; then
  die "위 커밋이 새 main에서 사라진다. 다음 릴리즈에 넣거나(릴리즈 브랜치에 옮겨 새 번호로), 이식을 확인했으면 --confirm-ported/--confirm-upstream으로 다시."
fi

# push 직전에 Latest를 한 번 더 본다.
[[ "$(latest_tag)" == "$TAG" ]] || die "그사이 Latest가 바뀌었다. 멈춘다."
LOG=$MS_STATE_DIR/main-history.log
# 판정 근거(원본 커밋:방법:대응 커밋, 전체 SHA)를 남긴다 — 사람 확인도 구분된다.
kept=$(awk '$1=="ok"{printf " %s:%s:%s", $2, $3, $4}' <<<"$result")
printf 'attempt %s %s main %s -> %s (%s)%s\n' "$(date -u +%FT%TZ)" "$TAG" "$M" "$T" "$why" "${kept:+ kept:$kept}" >>"$LOG"
say "main ${M:0:12} → ${T:0:12}"
push_out=$(mktemp)
push_rc=0
timeout -k 10 300 git -C "$MS_REPO" push --no-follow-tags --porcelain --force-with-lease="refs/heads/main:$M" origin "$T:refs/heads/main" >"$push_out" 2>&1 || push_rc=$?
cat "$push_out"
observed=$(gnet ls-remote origin refs/heads/main | cut -f1 || true)
result_line() { printf 'result %s %s %s observed=%s\n' "$(date -u +%FT%TZ)" "$TAG" "$1" "${observed:-?}" >>"$LOG"; }
if [[ "$observed" == "$T" ]]; then
  result_line confirmed
  rm -f "$push_out"
  echo "main = $T"
  echo "되돌리려면: git -C $MS_REPO push --no-follow-tags --force-with-lease=refs/heads/main:$T origin $M:refs/heads/main"
  exit 0
fi
explicit_reject=''
if ((push_rc != 0 && push_rc != 124 && push_rc != 137)) && grep -qE 'stale info|\[rejected\]|! \[remote rejected\]|^!' "$push_out"; then
  explicit_reject=1
fi
rm -f "$push_out"
if [[ -n "$explicit_reject" && "$observed" == "$M" ]]; then
  result_line unchanged
  die "push가 거부됐고 main은 그대로(${M:0:12})다. 그사이 main이 바뀌었는지 보고 다시."
fi
result_line unknown
echo "결과 미확정: 원격 main=${observed:-조회 실패}. 서버가 늦게 적용할 수 있다. 잠시 뒤 확인: git ls-remote https://github.com/$FORK refs/heads/main" >&2
exit 2
