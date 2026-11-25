#!/usr/bin/env bash
# 포크 패치 묶음을 업스트림 릴리즈 태그 위로 옮기고, 검사·빌드·이 컴퓨터용 시험 포장까지 한다.
# --release N이면 이어서 origin에 올리고 태그 fork-<태그>-N으로 릴리즈 워크플로를 돌려 초안까지 기다린다.
# 설치(sudo)와 릴리즈 게시는 하지 않는다. 구조와 순서는 fork/README.md.
set -euo pipefail

usage() {
  cat <<'EOF'
사용법: fork/rebase-onto-release.sh <새태그> [--from <브랜치>] [--release <N>]
  <새태그>         업스트림 릴리즈 태그 (예: v1.4.276)
  --from <브랜치>  옮길 패치 묶음 (기본: origin의 fork/v* 중 가장 높은 버전)
  --release <N>    끝나면 origin에 올리고 태그 fork-<새태그>-<N>으로 릴리즈 초안을 만든다
fork/<새태그>가 이미 있으면 그것을 이어서 검사·빌드·포장한다
(충돌을 풀고 git rebase --continue를 끝낸 뒤, 또는 새 패치를 더한 뒤 같은 명령을 다시 실행).
작업 폴더: ~/orca-fork-build (고정; fork/verify-linux-release.sh --stop이 지울 수 있는 곳과 같다)
EOF
}

REGEN_SUBJECT='fork: regenerate generated files'
GENERATED=(
  src/renderer/src/i18n/en-runtime-required.json
  src/shared/rpc-contract/rpc-params-catalog.generated.ts
  src/shared/plugins/languages/protected-copy-keys.json
)
BUILD_ROOT=$HOME/orca-fork-build
# 빌드 루트는 실제 폴더여야 한다(링크면 정리 명령 --stop이 거부하므로 만들기 전에 멈춘다).
[[ ! -L "$BUILD_ROOT" ]] || { echo "$BUILD_ROOT가 심볼릭 링크다. 실제 폴더로 바꾼 뒤 다시." >&2; exit 1; }
# AUR 설치본. 가져다 쓰는 실행기(bin/orca-ide, /usr/bin/orca-ide)가 이 경로를 고정해 쓰므로 바꿀 수 없다.
INSTALLED=/usr/lib/orca-ide
# 원격 서버 템플릿: AUR 설치본이 실제로 파일을 담은 리눅스 x64 두 대상. glibc217은 linux-x64-glibc의
# 호환 대상이라 템플릿 빌드·검증에는 기본 대상만 넘기고, 둘 다 들어갔는지는 따로 확인한다.
ORCAD_BASE_TARGET=linux-x64-glibc
ORCAD_TARGETS='linux-x64-glibc linux-x64-glibc217'
# glibc217 슬롯은 업스트림 CI(node-server-tests.yml)와 같은 이미지에서 만든다.
GLIBC217_IMAGE=quay.io/pypa/manylinux2014_x86_64@sha256:6f74cabeac2432570aa4bfdb29f7c1f30313d4d6654d764c44e574b6ffdd4ed5
PREBUILDS=config/scripts/orcad-distribution/prebuilds/build-orcad-prebuilds.mjs

say() { printf '\n== %s\n' "$*"; }
die() {
  printf '오류: %s\n' "$*" >&2
  exit 1
}
only_generated() { ! grep -qvxF -f <(printf '%s\n' "${GENERATED[@]}"); } # stdin의 경로가 모두 생성 파일인가
# 안내문(셸 명령)과 sed에 그대로 들어가므로 경로는 평범한 글자만 받는다.
plain_path() { [[ "$1" =~ ^/[A-Za-z0-9._/+-]+$ ]] || die "경로에 공백·특수 문자가 있다: '$1'"; }

TAG='' FROM='' RELEASE=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --from) FROM=${2:?--from에 브랜치가 필요하다}; shift 2 ;;
    --release) RELEASE=${2:?--release에 번호가 필요하다}; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    -*) usage >&2; die "모르는 옵션: $1" ;;
    *) [[ -z "$TAG" ]] || die "태그는 하나만 받는다"; TAG=$1; shift ;;
  esac
done
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { usage >&2; die "태그 형식은 vX.Y.Z: '${TAG}'"; }
BRANCH=fork/$TAG
[[ -z "$RELEASE" || "$RELEASE" =~ ^[1-9][0-9]*$ ]] || die "--release는 1 이상의 번호: '$RELEASE'"
RELEASE_TAG=${RELEASE:+fork-$TAG-$RELEASE}
FORK_REPO=vbalien/orca

REPO=$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)
g() { git -C "$REPO" "$@"; }
plain_path "$BUILD_ROOT"

# git 2.38+ (rebase --no-update-refs).
printf '%s\n%s\n' 2.38 "$(git version | awk '{print $3}')" | sort -V -C || die "git 2.38 이상이 필요하다"
# 원격이 맞는 저장소인지 (무엇을 받아 실행하고 어디로 올리는지). https·ssh 둘 다 받는다.
is_github_repo() { [[ "$1" =~ ^(https://github\.com/|git@github\.com:|ssh://git@github\.com/)$2(\.git)?/?$ ]]; }
is_github_repo "$(g remote get-url upstream)" stablyai/orca || die "upstream이 github.com/stablyai/orca가 아니다: $(g remote get-url upstream)"
is_github_repo "$(g remote get-url origin)" "$FORK_REPO" || die "origin이 github.com/$FORK_REPO가 아니다: $(g remote get-url origin)"

# 빌드 환경: 빌드할 때만 확인한다(이미 포장한 커밋의 릴리즈만 이어서 할 때는 필요 없다).
check_build_env() {
  # 이 릴리즈가 쓰는 Electron 메이저 = 시험 포장이 돌 시스템 electron.
  TARGET_MAJOR=$(node -p 'require("./package.json").devDependencies.electron.split(".")[0]')
  [[ "$TARGET_MAJOR" =~ ^[0-9]+$ ]] || die "package.json에서 Electron 버전을 읽지 못했다"
  SYSTEM_ELECTRON=/usr/lib/electron$TARGET_MAJOR/electron
  TEST_PACKAGE=1
  local installed_electron=''
  for file in orca-ide.js apparmor-profile package-type bin/orca-ide; do
    [[ -f "$INSTALLED/$file" ]] || { TEST_PACKAGE=''; echo "주의: $INSTALLED/$file이 없어 시험 포장(직접 교체용)은 건너뛴다."; break; }
  done
  skip_test_package() { TEST_PACKAGE=''; echo "주의: $1 — 시험 포장(직접 교체용)은 건너뛰고 검사·빌드·릴리즈는 계속한다."; }
  if [[ -n "$TEST_PACKAGE" ]]; then
    installed_electron=$(grep -oE '/usr/lib/electron[0-9]+/electron' "$INSTALLED/bin/orca-ide" | head -n 1 || true)
    if [[ "$(cat "$INSTALLED/package-type")" != deb ]]; then
      skip_test_package "$INSTALLED/package-type이 deb가 아니다"
    elif ! grep -qs "_APPDIR=\"$INSTALLED\"" /usr/bin/orca-ide; then
      skip_test_package "/usr/bin/orca-ide가 없거나 $INSTALLED를 쓰지 않는다"
    elif [[ ! -x "$SYSTEM_ELECTRON" ]]; then
      TEST_PACKAGE=''
      echo "주의: electron$TARGET_MAJOR가 없어 시험 포장은 건너뛴다(만들려면 pacman -S electron$TARGET_MAJOR 뒤 이 커밋의 기록 폴더를 지우고 다시 실행)."
    elif [[ "$installed_electron" != "$SYSTEM_ELECTRON" ]] || ! grep -qw "electron$TARGET_MAJOR" /usr/bin/orca-ide; then
      # 지금 설치본의 실행기는 다른 Electron을 부른다: 파일만 갈아 끼우면 맞지 않는다. 릴리즈 + AUR 패키지로 설치한다.
      TEST_PACKAGE=''
      echo "주의: 설치본은 ${installed_electron:-?}, 이 릴리즈는 electron$TARGET_MAJOR — 직접 교체용 시험 포장은 건너뛴다(fork/aur/INSTALL.md로 설치)."
    fi
  fi
  if [[ -n "$TEST_PACKAGE" ]] && ! timeout -k 10 30 docker info >/dev/null 2>&1; then
    skip_test_package "docker를 쓸 수 없다(시험 포장의 glibc217 서버 슬롯 빌드에 필요)"
  fi
}

# 같은 태그를 동시에 두 번 돌리지 않는다(작업 공간·포장 폴더를 함께 쓴다). 잠금은 저장소 공통 git 폴더에.
mkdir -p "$BUILD_ROOT"
exec 9>"$(g rev-parse --path-format=absolute --git-common-dir)/orca-fork-$TAG.lock"
flock -n 9 || die "$TAG 작업이 이미 돌고 있다"

# Node 24(engines)와 pnpm: 기본 node가 다르면 nvm의 v24를 앞에 둔다. 저장소 스크립트가 pnpm을 직접 부르므로 shim을 둔다.
if [[ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)" != 24 ]]; then
  nvm24=$(ls -d "$HOME"/.nvm/versions/node/v24.*/bin 2>/dev/null | sort -V | tail -n 1 || true)
  [[ -n "$nvm24" ]] || die "Node 24가 필요하다 (nvm install 24)"
  PATH=$nvm24:$PATH
fi
TMP=$(mktemp -d)
STAGE=''
CIDFILE=$TMP/glibc217.cid # 이 실행이 띄운 glibc217 컨테이너. 시간 초과·중단 때 이것만 지운다.
cleanup() {
  if [[ -s "$CIDFILE" ]]; then
    local cid
    cid=$(cat "$CIDFILE")
    timeout -k 10 60 docker rm -f "$cid" >/dev/null 2>&1 ||
      printf '경고: glibc217 빌드 컨테이너를 지우지 못했다. 직접 지운다: docker rm -f %s\n' "$cid" >&2
  fi
  rm -rf "$TMP"
  [[ -z "$STAGE" ]] || rm -rf "$STAGE"
}
trap cleanup EXIT
if ! command -v pnpm >/dev/null; then
  printf '#!/bin/sh\nexec corepack pnpm "$@"\n' >"$TMP/pnpm"
  chmod +x "$TMP/pnpm"
  PATH=$TMP:$PATH
fi
export PATH
# 검사·빌드가 띄우는 Orca 창이 포커스를 뺏지 않게(저장소 규칙).
export ORCA_BACKGROUND_LAUNCH=1

say "태그 확인"
# 네트워크 명령은 시간 상한을 둔다(잠금을 쥔 채 멈추지 않게).
gnet() { timeout -k 10 300 git -C "$REPO" "$@"; }
# upstream이 가진 태그 커밋 (주석 태그면 가리키는 커밋).
upstream_tag_sha() { gnet ls-remote upstream "refs/tags/$1" "refs/tags/$1^{}" | sort -k2 | tail -n 1 | cut -f1; }
# 업스트림의 그 태그만 믿는다: 로컬에 같은 이름의 다른 태그가 있으면 fetch가 거부한다.
gnet fetch --quiet --no-tags upstream "refs/tags/$TAG:refs/tags/$TAG" || die "upstream에서 태그 $TAG를 가져오지 못했다"
[[ "$(upstream_tag_sha "$TAG")" == "$(g rev-parse "$TAG^{commit}")" ]] || die "로컬 태그 $TAG가 upstream과 다르다"
gnet fetch --quiet upstream --tags || die "upstream 태그를 가져오지 못했다" # 옛 기반 태그를 찾을 때 쓴다
gnet fetch --quiet origin || die "origin을 가져오지 못했다"
# 릴리즈 단계의 push는 이 시점에 본 origin 브랜치 값으로만 덮는다(빌드 중에 누가 올린 커밋은 지키게).
ORIGIN_BRANCH_SHA=$(g rev-parse -q --verify "refs/remotes/origin/$BRANCH" || true)
if command -v gh >/dev/null && ! timeout -k 5 60 gh release view "$TAG" -R stablyai/orca --json tagName >/dev/null 2>&1; then
  echo "주의: $TAG의 GitHub Release가 아직 공개되지 않았다(태그만 있음). AUR도 아직 이 버전이 아닐 수 있다."
fi

# ---- rebase ----
wt() { git -C "$WT" "$@"; }
in_rebase() {
  [[ -d "$(wt rev-parse --path-format=absolute --git-path rebase-merge)" ||
    -d "$(wt rev-parse --path-format=absolute --git-path rebase-apply)" ]]
}

stop_for_conflict() {
  printf '\n멈춘 커밋: %s\n' "$(wt log -1 --format='%h %s' REBASE_HEAD 2>/dev/null || echo '(알 수 없음)')"
  if [[ -n "$(wt diff --name-only --diff-filter=U)" ]]; then
    printf '충돌 파일:\n'
    wt diff --name-only --diff-filter=U | sed 's/^/  /'
  else
    printf '충돌 파일은 없다(커밋이 비었거나 다른 이유로 멈춤). git -C "%s" status 로 본다.\n' "$WT"
    printf '새 릴리즈에 이미 들어간 패치라 비었다면: git -C "%s" rebase --skip\n' "$WT"
  fi
  cat <<EOF

작업 공간: $WT
풀고 나서:  git -C "$WT" add <파일> && git -C "$WT" rebase --continue
끝나면 같은 명령을 다시 실행한다:  $0 $TAG
그만두려면: git -C "$WT" rebase --abort  (그 뒤 브랜치 $BRANCH와 작업 공간은 직접 정리한다)
EOF
  exit 2
}

# 재생성 커밋인가: 제목이 정확히 REGEN_SUBJECT면 예. 그런데 생성 파일 밖도 바꿨으면 멈춘다.
is_regen() { # <sha>
  [[ "$(g log -1 --format=%s "$1")" == "$REGEN_SUBJECT" ]] || return 1
  g diff-tree --no-commit-id --name-only -r "$1" | only_generated ||
    die "커밋 $1은 제목이 '$REGEN_SUBJECT'인데 생성 파일 밖도 바꾼다. 제목을 바꾸거나 나눠라."
}
# 범위 안 재생성 커밋 수. 잘못 쓴 제목의 검사(die)는 $() 안에서 묻히므로 check_regen을 먼저 따로 부른다.
regen_count() { # <범위>
  local sha n=0
  for sha in $(wt rev-list "$1"); do
    if is_regen "$sha"; then n=$((n + 1)); fi
  done
  echo "$n"
}
check_regen() { regen_count "$1" >/dev/null; } # <범위>, 셸 안에서 돌아 die가 스크립트를 멈춘다

# 재생성 커밋을 모두 빼고 <onto> 위로 옮긴다. 충돌이 생성 파일뿐이면 새 기반 쪽을 쓰고 계속한다(끝에서 다시 만든다).
check_linear() { # <범위>
  [[ -z "$(wt rev-list --merges "$1")" ]] || die "패치 묶음에 merge 커밋이 있다. 선형 커밋으로 정리한 뒤 다시."
}
rebase_stack() { # <onto> <base>
  check_regen "$2..HEAD"
  check_linear "$2..HEAD"
  # 지우지 않고 drop으로 바꾼다(rebase.missingCommitsCheck 설정과도 맞는다).
  local editor="sed -i 's/^pick \\([0-9a-f]*\\) ${REGEN_SUBJECT}\$/drop \\1 ${REGEN_SUBJECT}/'"
  local status=0
  # 이미 새 릴리즈에 들어가 비게 된 패치는 버린다(--empty=drop). 할 일 목록 형식은 사용자 설정과 무관하게 고정.
  GIT_SEQUENCE_EDITOR=$editor wt -c rebase.instructionFormat=%s -c rebase.abbreviateCommands=false \
    rebase -i --empty=drop --no-update-refs --onto "$1" "$2" || status=$? # 다른 브랜치는 움직이지 않는다
  while ((status != 0)); do
    in_rebase || die "rebase가 실패했다(충돌이 아님). 위 git 메시지를 보라."
    local conflicted
    conflicted=$(wt diff --name-only --diff-filter=U)
    [[ -n "$conflicted" ]] && printf '%s\n' "$conflicted" | only_generated || stop_for_conflict
    # 새 기반 쪽을 쓴다(끝에서 다시 만든다). 새 기반에서 지워진 파일 등 그렇게 못 하면 사람이 푼다.
    printf '%s\n' "$conflicted" | while read -r file; do
      { wt checkout --ours -- "$file" && wt add -- "$file"; } 2>/dev/null || exit 1
    done || stop_for_conflict
    status=0
    if wt diff --cached --quiet; then
      wt rebase --skip || status=$? # 생성 파일만 바꾸던 커밋이 비었다
    else
      GIT_EDITOR=true wt rebase --continue || status=$?
    fi
  done
  wt merge-base --is-ancestor "$1" HEAD || die "rebase 뒤 $1이 HEAD의 조상이 아니다"
  [[ "$(regen_count "$1..HEAD")" == 0 ]] || die "재생성 커밋이 남았다"
}

# 패치 묶음의 기반 = 가장 가까운 릴리즈 태그. 그 태그가 upstream의 것과 같은지도 확인한다.
base_tag_of() {
  local tag
  tag=$(g describe --tags --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*' --exclude '*-*' "$1") ||
    die "$1의 기반 릴리즈 태그를 찾지 못했다"
  [[ "$(upstream_tag_sha "$tag")" == "$(g rev-parse "$tag^{commit}")" ]] ||
    die "$1의 가장 가까운 태그 $tag가 upstream의 것이 아니다(로컬 태그?)"
  echo "$tag"
}

# origin에 이미 fork/<태그>가 있는데 로컬에 없으면, 그 원격 브랜치를 가져와 이어서 한다(원격에만 있는 패치를 덮지 않게).
if ! g rev-parse -q --verify "refs/heads/$BRANCH" >/dev/null &&
  g rev-parse -q --verify "refs/remotes/origin/$BRANCH" >/dev/null; then
  echo "알림: origin/$BRANCH가 이미 있어 그것을 로컬 $BRANCH로 가져와 이어서 한다${FROM:+(--from $FROM은 쓰지 않는다)}."
  g branch --quiet --no-track "$BRANCH" "origin/$BRANCH"
fi
if g rev-parse -q --verify "refs/heads/$BRANCH" >/dev/null; then
  # 이어서 하기: 이미 만든 브랜치(충돌을 푼 뒤, 또는 새 패치를 더한 뒤).
  # 이어서 하기에서는 출발 브랜치가 이미 정해져 있다(처음 명령에 --from이 있었어도 같은 명령으로 이어 간다).
  [[ -z "$FROM" ]] || echo "알림: $BRANCH가 이미 있어 --from $FROM은 쓰지 않고 그 브랜치를 이어서 한다."
  # 브랜치가 체크아웃된 worktree. rebase 중이면 HEAD가 떨어져 있으니 rebase가 기록한 원래 브랜치로 찾는다.
  WT=$(g worktree list --porcelain | awk -v b="branch refs/heads/$BRANCH" '/^worktree /{w=substr($0,10)} $0==b{print w}')
  if [[ -z "$WT" ]]; then
    while IFS= read -r w; do
      head_name=$(git -C "$w" rev-parse --path-format=absolute --git-path rebase-merge/head-name 2>/dev/null) || continue
      if [[ -f "$head_name" && "$(cat "$head_name")" == "refs/heads/$BRANCH" ]]; then WT=$w; fi
    done < <(g worktree list --porcelain | awk '/^worktree /{print substr($0,10)}')
  fi
  if [[ -z "$WT" ]]; then
    WT=$BUILD_ROOT/src/$TAG
    [[ ! -e "$WT" ]] || die "$WT가 이미 있지만 $BRANCH의 작업 공간이 아니다"
    mkdir -p "$(dirname "$WT")"
    g worktree add --quiet "$WT" "$BRANCH"
  fi
  in_rebase && stop_for_conflict
  [[ -z "$(wt status --porcelain)" ]] || die "$WT에 커밋 안 한 변경이나 추적 안 하는 파일이 있다: $(wt status --porcelain | head -n 5)"
  # origin에만 있는 커밋(재생성 커밋 제외)이 있으면 멈춘다. 이 스크립트가 다시 쓴 것은 내용이 같아 걸리지 않는다.
  if g rev-parse -q --verify "refs/remotes/origin/$BRANCH" >/dev/null; then
    missing=''
    for sha in $(g cherry "$BRANCH" "origin/$BRANCH" | awk '$1=="+"{print $2}'); do
      is_regen "$sha" || missing+=" $sha"
    done
    [[ -z "$missing" ]] || die "origin/$BRANCH에 로컬에 없는 커밋이 있다:$missing (맞춘 뒤 다시)"
  fi
  [[ "$(base_tag_of "$BRANCH")" == "$TAG" ]] || die "$BRANCH의 기반이 $TAG가 아니다"
  say "$BRANCH 이어서 하기 ($WT)"
  # 재생성 커밋이 맨 위 하나뿐이면 다시 쓰지 않는다(내용이 같으면 SHA도 그대로).
  check_regen "$TAG..HEAD"
  check_linear "$TAG..HEAD"
  if [[ "$(regen_count "$TAG..HEAD")" != "$(regen_count "HEAD~1..HEAD")" ]]; then
    rebase_stack "$TAG" "$TAG"
  fi
else
  if [[ -z "$FROM" ]]; then
    FROM=$(g for-each-ref --format='%(refname:lstrip=2)' 'refs/remotes/origin/fork/v*' |
      grep -E '^origin/fork/v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1 || true)
    [[ -n "$FROM" ]] || die "origin에 fork/v* 브랜치가 없다. --from으로 정하라."
  fi
  g rev-parse -q --verify "$FROM^{commit}" >/dev/null || die "출발 브랜치 $FROM이 없다"
  OLD_TAG=$(base_tag_of "$FROM")
  WT=$BUILD_ROOT/src/$TAG
  [[ ! -e "$WT" ]] || die "$WT가 이미 있다(지난 실행의 잔재면 git worktree remove로 지운다)"
  say "$FROM ($OLD_TAG 기반) → $BRANCH ($TAG 기반). 옮길 커밋:"
  g log --oneline "$OLD_TAG..$FROM"
  mkdir -p "$(dirname "$WT")"
  g worktree add --quiet -b "$BRANCH" "$WT" "$FROM"
  rebase_stack "$TAG" "$OLD_TAG"
fi
cd "$WT"
[[ -z "$(git status --porcelain)" ]] || die "$WT에 커밋 안 한 변경이나 추적 안 하는 파일이 있다: $(git status --porcelain | head -n 5)"
# 같은 커밋을 이미 포장했으면 설치·빌드를 하지 않는다: --release면 그 포장을 확인하고 릴리즈 단계로, 아니면 멈춘다.
PACKAGED=$BUILD_ROOT/$TAG-$(git rev-parse --short=10 HEAD)
if [[ -e "$PACKAGED" ]]; then
  [[ -n "$RELEASE" ]] || die "$PACKAGED가 이미 있다(이 커밋은 이미 검사·포장됨). 릴리즈하려면 --release <N>"
  say "이미 검사한 커밋: $PACKAGED 확인"
  [[ -f "$PACKAGED/checked" && "$(cat "$PACKAGED/checked")" == "$(git rev-parse HEAD)" ]] ||
    die "$PACKAGED의 검사 표식이 지금 커밋($(git rev-parse HEAD))의 것이 아니다"
  if [[ -d "$PACKAGED/orca-ide" ]]; then
    (cd "$PACKAGED/orca-ide" && sha256sum --quiet -c ../orca-ide.sha256) || die "$PACKAGED가 목록과 다르다"
  fi
  SKIP_BUILD=1
else
  SKIP_BUILD=''
fi
# glibc217 컨테이너가 pnpm 상대 링크를 풀려면 작업 공간이 홈 아래여야 한다(아래 docker 참고).
[[ "$WT" == "$HOME"/* ]] || die "작업 공간이 홈 밖에 있다: $WT"
say "패치 묶음 ($TAG..$BRANCH)"
git log --oneline "$TAG..HEAD"

if [[ -z "$SKIP_BUILD" ]]; then
check_build_env
# ---- 생성 파일·검사 ----
say "의존성 설치"
timeout -k 30 1800 pnpm install --frozen-lockfile
timeout -k 30 1800 pnpm -C mobile install --frozen-lockfile # build의 mobile-web이 쓴다

say "생성 파일 다시 만들기"
pnpm run sync:localization-runtime-catalog
pnpm run sync:localization-protected-copy
pnpm run generate:rpc-params-catalog
changed=$(git status --porcelain --untracked-files=no | cut -c4-)
if [[ -n "$changed" ]]; then
  printf '%s\n' "$changed" | only_generated || die "생성 파일 밖에서 변경이 생겼다: $changed"
  git add -- "${GENERATED[@]}"
  if [[ "$(git log -1 --format=%s HEAD)" == "$REGEN_SUBJECT" ]]; then
    git commit --quiet --amend --no-edit
  else
    git commit --quiet -m "$REGEN_SUBJECT" -m "Regenerated by fork/rebase-onto-release.sh on $TAG."
  fi
fi
# 여기서부터 검사·빌드·포장·릴리즈는 이 커밋 하나에 대한 것이다.
FULL_SHA=$(git rev-parse HEAD)
SHA=${FULL_SHA:0:10}
OUT=$BUILD_ROOT/$TAG-$SHA
[[ ! -e "$OUT" ]] || die "$OUT가 이미 있다(이 커밋은 이미 포장됨)"

say "검사 (check:changed --base=$TAG)"
timeout -k 30 900 pnpm check:changed --base="$TAG"
# 포크 도구 자체: 셸 문법과 설치 안내의 프로필 복원 회귀 시험.
for f in fork/*.sh fork/aur/*.sh; do bash -n "$f" || die "$f 문법 오류"; done
timeout -k 5 120 bash fork/aur/test-orca-service-checks.sh
timeout -k 5 300 bash fork/test-verify-linux.sh

# ---- 빌드 ----
say "빌드 (build:unpack)"
rm -rf dist/linux-unpacked out/orcad-template out/orcad-prebuilds
timeout -k 30 3600 pnpm build:unpack

[[ -z "$(git status --porcelain)" ]] || die "빌드가 작업 공간을 바꿨다(포장이 커밋과 달라진다): $(git status --porcelain | head -n 5)"

# ---- 시험 포장: 임시 폴더에서 다 확인한 뒤 이름을 붙인다 ----
VERSION=$(node -p 'require("./package.json").version')
[[ "v$VERSION" == "$TAG" ]] || die "package.json 버전 $VERSION이 태그 $TAG와 다르다"
STAGE=$(mktemp -d "$BUILD_ROOT/.partial-$TAG-$SHA-XXXX") # 실패하면 cleanup이 지운다
if [[ -z "$TEST_PACKAGE" ]]; then
  echo "시험 포장 없음(위 주의). 검사·빌드만 했다." >"$STAGE/NO-TEST-PACKAGE.txt"
else
# build:unpack은 orcad-template(SSH·WSL 서버 배포본)을 넣지 않고, 패키징 검증은 8개 대상 전부를 요구한다.
# 그래서 설치본이 실제로 담은 리눅스 x64 두 대상만 같은 소스로 만들어 포장 때 넣는다.
say "원격 서버 템플릿 ($ORCAD_TARGETS)"
timeout -k 30 1800 pnpm build:orcad-prebuilds
timeout -k 30 600 pnpm build:orcad-prebuilds --smoke # 업스트림 CI처럼 기본 슬롯도 pinned Node로 띄워 본다
compat_node=$(timeout -k 10 900 node "$PREBUILDS" --slot=linux-x64-glibc217 --print-runtime) # 처음엔 내려받는다
[[ "$compat_node" == "$WT"/* ]] || die "glibc-217 Node가 작업 공간 밖에 있다: $compat_node"
# node_modules는 pnpm 저장소로 가는 상대 링크(../../...)다. 작업 공간을 /work에 두면 위로 올라가는 링크가
# /에서 멈춰 /<홈 아래 경로>로 풀리므로, 저장소를 그 경로에 붙인다(같은 경로로 붙이면 이 이미지에선 안 보였다).
store=$(pnpm store path)
[[ "$store" == "$HOME"/* ]] || die "pnpm 저장소가 홈 밖에 있다: $store"
timeout -k 30 1800 docker run --cidfile "$CIDFILE" --rm --init -i -u "$(id -u):$(id -g)" -e HOME=/tmp \
  -e ORCA_BACKGROUND_LAUNCH=1 -e COMPAT_NODE="/work/${compat_node#"$WT"/}" -e CC=gcc -e CXX=g++ \
  -e PYTHON=/opt/python/cp312-cp312/bin/python3 -v "$WT:/work" -v "$store:/${store#"$HOME"/}:ro" \
  -w /work "$GLIBC217_IMAGE" bash -s <<EOF
set -eu
export PATH="\$(dirname "\$COMPAT_NODE"):\$PATH"
node $PREBUILDS --slot=linux-x64-glibc217
node $PREBUILDS --require-slots linux-x64-glibc217
env -u LD_LIBRARY_PATH node $PREBUILDS --slot=linux-x64-glibc217 --smoke
EOF
rm -f "$CIDFILE"
timeout -k 30 1800 pnpm build:orcad-template --targets "$ORCAD_BASE_TARGET" # glibc217 슬롯은 호환 대상으로 함께 들어간다
template_targets=$(node -p "Object.keys(require('./out/orcad-template/orcad-template.json').targets).sort().join(' ')")
[[ "$template_targets" == "$ORCAD_TARGETS" ]] || die "템플릿 대상이 '$template_targets'다 ('$ORCAD_TARGETS'여야 한다)"
[[ -z "$(git status --porcelain)" ]] || die "템플릿 빌드가 작업 공간을 바꿨다: $(git status --porcelain | head -n 5)"
say "시험 포장 (AUR orca-ide-bin과 같은 deb 형태)"
UNPACKED=dist/linux-unpacked
[[ -f "$UNPACKED/resources/app.asar" ]] || die "빌드 산출물 $UNPACKED/resources/app.asar가 없다"
built_abi=$(ELECTRON_RUN_AS_NODE=1 "$UNPACKED/orca-ide" -p process.versions.modules)
system_abi=$(ELECTRON_RUN_AS_NODE=1 "$SYSTEM_ELECTRON" -p process.versions.modules)
[[ "$built_abi" == "$system_abi" ]] || die "네이티브 모듈 ABI가 다르다: 빌드 $built_abi, 시스템 electron $system_abi"

cp -a "$UNPACKED/resources" "$STAGE/orca-ide"
rm -rf "$STAGE/orca-ide/node-runtime" # AppImage 전용
cp -a out/orcad-template "$STAGE/orca-ide/orcad-template"
node -e "require('./config/scripts/orcad-distribution/template/verify-packaged-orcad-template.cjs')
  .verifyPackagedOrcadTemplate(process.argv[1], [process.argv[2]])" "$STAGE/orca-ide" "$ORCAD_BASE_TARGET"
for file in orca-ide.js apparmor-profile package-type bin/orca-ide; do
  cp -a "$INSTALLED/$file" "$STAGE/orca-ide/$file"
done
# 포장본의 node-pty·koffi를 시스템 electron으로 불러 PTY를 한 번 돌린다(15초 안에).
(cd "$TMP" && ELECTRON_RUN_AS_NODE=1 timeout -k 5 30 "$SYSTEM_ELECTRON" -e "
const d = process.argv[1]
const pty = require(d + '/node_modules/node-pty')
require(d + '/node_modules/koffi')
const p = pty.spawn('/bin/sh', ['-c', 'echo fork-pty-ok'], { cols: 80, rows: 24 })
const timer = setTimeout(() => { p.kill(); console.error('PTY 확인 시간 초과'); process.exit(1) }, 15000)
let o = ''
p.onData((x) => (o += x))
p.onExit((e) => {
  clearTimeout(timer)
  if (e.exitCode !== 0 || !o.includes('fork-pty-ok')) {
    console.error('PTY 확인 실패', e, JSON.stringify(o))
    process.exit(1)
  }
  process.exit(0)
})" "$STAGE/orca-ide") || die "포장본의 node-pty·koffi가 시스템 electron에서 돌지 않는다"
# 포장본의 CLI를 시스템 electron으로(빈 HOME에서) 띄워 버전을 본다.
cli_version=$(cd "$TMP" && HOME=$TMP ELECTRON_RUN_AS_NODE=1 timeout -k 5 60 "$SYSTEM_ELECTRON" \
  "$STAGE/orca-ide/app.asar.unpacked/out/cli/index.js" --version | tail -n 1)
[[ "$cli_version" == "$VERSION" ]] || die "포장본 CLI가 '$cli_version'을 말한다($VERSION이어야 한다)"
(cd "$STAGE/orca-ide" && find . -type f -print0 | sort -z | xargs -0 sha256sum) >"$STAGE/orca-ide.sha256"

# 설치본의 실제 앱 버전(포크를 설치했으면 pacman 기록과 다르다).
installed_version=$(cd "$TMP" && ELECTRON_RUN_AS_NODE=1 timeout -k 5 30 "$SYSTEM_ELECTRON" \
  -p "require(process.argv[1] + '/app.asar/package.json').version" "$INSTALLED" 2>/dev/null || true)
if [[ -z "$installed_version" ]]; then
  direction="알 수 없음"
elif [[ "$installed_version" == "$VERSION" ]]; then
  direction="같은 버전"
elif [[ "$(printf '%s\n%s\n' "$installed_version" "$VERSION" | sort -V | tail -n 1)" == "$VERSION" ]]; then
  direction="업그레이드"
else
  direction="다운그레이드 (주의: 더 옛 릴리즈다)"
fi
sed -e "s|@TAG@|$TAG|g" -e "s|@SHA@|$SHA|g" -e "s|@OUT@|$OUT|g" -e "s|@BRANCH@|$BRANCH|g" \
  -e "s|@INSTALLED@|$INSTALLED|g" -e "s|@TARGETS@|$ORCAD_TARGETS|g" \
  -e "s|@INSTALLED_VERSION@|${installed_version:-알 수 없음}|g" -e "s|@VERSION@|$VERSION|g" -e "s|@DIRECTION@|$direction|g" \
  "$WT/fork/install-guide.template.md" >"$STAGE/README-설치순서.md"
cp "$WT/fork/aur/orca-service-checks.sh" "$STAGE/"
fi
# 표식을 남기기 전에, 검사한 커밋 그대로인지 확인한다(그사이 커밋·변경이 생겼으면 기록하지 않는다).
[[ "$(git rev-parse HEAD)" == "$FULL_SHA" ]] || die "검사하는 동안 $WT의 HEAD가 바뀌었다"
[[ -z "$(git status --porcelain)" ]] || die "검사하는 동안 $WT에 변경이 생겼다"
# 이 커밋은 검사·빌드를 통과했다(--release로 이어서 할 때 이 표식을 본다).
printf '%s\n' "$FULL_SHA" >"$STAGE/checked"
mv "$STAGE" "$OUT"
STAGE=''

fi

if [[ -n "$SKIP_BUILD" ]]; then OUT=$PACKAGED; FULL_SHA=$(git rev-parse HEAD); fi
# 검사한 커밋 그대로인지(그사이 이 작업 공간에 커밋·변경이 생겼으면 멈춘다).
[[ "$(git rev-parse HEAD)" == "$FULL_SHA" ]] || die "검사한 뒤 $WT의 HEAD가 바뀌었다"
[[ -z "$(git status --porcelain)" ]] || die "검사한 뒤 $WT에 변경이 생겼다"
say "로컬 끝"
cat <<EOF
브랜치: $BRANCH @ $(git rev-parse HEAD)
검사 기록·시험 포장: $OUT   (시험 포장이 있으면 $OUT/README-설치순서.md)
EOF
[[ -n "$RELEASE" ]] || {
  echo "릴리즈하려면 같은 명령에 --release <N>을 붙여 다시 실행한다."
  exit 0
}

# ---- 릴리즈: origin에 올리고 태그로 워크플로를 돌려 초안까지 ----
say "릴리즈 $RELEASE_TAG"
command -v gh >/dev/null || die "gh가 필요하다"
[[ "$(timeout -k 5 60 gh api "repos/$FORK_REPO/actions/permissions" --jq .enabled)" == true ]] ||
  die "$FORK_REPO의 GitHub Actions가 꺼져 있다(설정 → Actions에서 켠 뒤 다시)"
while IFS= read -r url; do
  is_github_repo "$url" "$FORK_REPO" || die "origin의 push 주소가 $FORK_REPO가 아니다: $url"
done < <(g remote get-url --push --all origin)
HEAD_SHA=$FULL_SHA
# 1) 브랜치: origin에 없거나 조상이면 그냥, 이 스크립트가 다시 썼으면(같은 내용) 시작 때 본 origin 값으로만 덮는다.
# 태그는 로컬·원격 모두 이 커밋이어야 한다(먼저 확인해 아무것도 올리기 전에 멈춘다).
if g rev-parse -q --verify "refs/tags/$RELEASE_TAG" >/dev/null; then
  [[ "$(g rev-parse "$RELEASE_TAG^{commit}")" == "$HEAD_SHA" ]] || die "로컬 태그 $RELEASE_TAG가 다른 커밋이다. 다음 번호로 다시."
fi
remote_tag=$(gnet ls-remote origin "refs/tags/$RELEASE_TAG" "refs/tags/$RELEASE_TAG^{}" | sort -k2 | tail -n 1 | cut -f1)
[[ -z "$remote_tag" || "$remote_tag" == "$HEAD_SHA" ]] ||
  die "origin의 태그 $RELEASE_TAG가 다른 커밋($remote_tag)이다. 다음 번호로 다시."
# 1) 브랜치: 검증한 커밋을 명시해 올린다(호출한 저장소의 HEAD가 아니라).
if [[ -z "$ORIGIN_BRANCH_SHA" ]]; then
  # 시작 때 없던 브랜치: 그사이 누가 만들었으면 거부된다.
  gnet push --force-with-lease="refs/heads/$BRANCH:" origin "$HEAD_SHA:refs/heads/$BRANCH"
elif [[ "$ORIGIN_BRANCH_SHA" != "$HEAD_SHA" ]]; then
  gnet push --force-with-lease="refs/heads/$BRANCH:$ORIGIN_BRANCH_SHA" origin "$HEAD_SHA:refs/heads/$BRANCH" ||
    die "origin/$BRANCH가 시작한 뒤 바뀌었다. 맞춘 뒤 다시."
fi
# 2) 태그: 없으면 만들어 올린다.
if [[ -z "$remote_tag" ]]; then
  g rev-parse -q --verify "refs/tags/$RELEASE_TAG" >/dev/null ||
    g tag -a "$RELEASE_TAG" -m "Fork release $RELEASE_TAG (stablyai/orca $TAG + fork patches)" "$HEAD_SHA"
  gnet push origin "refs/tags/$RELEASE_TAG"
fi
# 3) 그 태그의 실행을 찾아(전체 5분) 기다린다.
run_id=''
deadline=$((SECONDS + 300))
# 남은 시간을 한 번 읽어 양수일 때만 쓴다(GNU timeout 0은 '제한 없음').
while left=$((deadline - SECONDS)) && ((left > 0)); do
  run_id=$(timeout -k 5 "$((left < 30 ? left : 30))" gh run list -R "$FORK_REPO" --workflow fork-release.yml \
    --branch "$RELEASE_TAG" --json databaseId,headSha \
    --jq ".[] | select(.headSha == \"$HEAD_SHA\") | .databaseId" 2>/dev/null | head -n 1 || true)
  [[ -n "$run_id" ]] && break
  left=$((deadline - SECONDS)) && ((left > 0)) && sleep "$((left < 10 ? left : 10))"
done
[[ -n "$run_id" ]] || die "5분 안에 $RELEASE_TAG의 워크플로 실행이 보이지 않는다. 확인: gh run list -R $FORK_REPO --workflow fork-release.yml"
echo "실행: https://github.com/$FORK_REPO/actions/runs/$run_id"
watch_status=0
timeout -k 30 25200 gh run watch "$run_id" -R "$FORK_REPO" --exit-status --interval 60 || watch_status=$?
if ((watch_status == 124 || watch_status == 137)); then
  echo "7시간 안에 끝나지 않았다(실행은 계속된다). 같은 명령을 다시 실행하면 이어서 기다린다."
  exit 3
fi
if ((watch_status != 0)); then
  # 감시만 끊겼는지, 실행이 실제로 실패했는지 본다.
  conclusion=$(timeout -k 5 60 gh run view "$run_id" -R "$FORK_REPO" --json status,conclusion --jq '.status + "/" + .conclusion' 2>/dev/null || true)
  case "$conclusion" in
    completed/success) watch_status=0 ;;
    completed/*) ;;
    *) echo "감시가 끊겼다(실행 상태: ${conclusion:-확인 못 함}). 같은 명령을 다시 실행하면 이어서 기다린다."; exit 3 ;;
  esac
fi
((watch_status == 0)) || die "릴리즈 워크플로가 실패했다: https://github.com/$FORK_REPO/actions/runs/$run_id
  일시적(러너·네트워크, 템플릿 조립 잡의 25분 대기 초과 등)이면: gh run rerun $run_id -R $FORK_REPO --failed  그 뒤 같은 명령을 다시 실행해 기다린다(하루 안에).
  코드·설정을 고쳤거나 하루가 지났으면: 고친 커밋(또는 같은 커밋)에 다음 번호로 --release $((RELEASE + 1))"
say "초안 준비됨"
release_state=$(timeout -k 5 60 gh release view "$RELEASE_TAG" -R "$FORK_REPO" --json url,isDraft \
  --jq '(if .isDraft then "draft" else "published" end) + " " + .url' 2>/dev/null || true)
case "$release_state" in
  published\ *) echo "이미 게시됐다: ${release_state#published }"; exit 0 ;;
  draft\ *) ;;
  *)
    echo "실행은 성공했는데 릴리즈 $RELEASE_TAG을 읽지 못했다: https://github.com/$FORK_REPO/actions/runs/$run_id . 같은 명령을 다시 실행해 확인한다."
    exit 3
    ;;
esac
cat <<EOF
초안: ${release_state#draft }
게시 전: fork/verify-linux-release.sh $RELEASE_TAG --keep (격리 실행; fork/README.md "게시 전 확인")
게시: fork/screen-checks.txt 화면 확인 뒤 fork/publish-release.sh $RELEASE_TAG --screens-checked (검증 기록과 초안이 같을 때만)
EOF
