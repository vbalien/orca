#!/usr/bin/env bash
# 포크 릴리즈 초안의 리눅스 설치 파일을 게시 전에 이 컴퓨터에서 확인한다. 설치·sudo 없음.
# 주인 프로필·설치본·서비스·키링은 쓰지 않는다: 빈 HOME·XDG, 독립 D-Bus, 별도 Xvfb 화면.
#   fork/verify-linux-release.sh fork-vX.Y.Z-N [--keep]
#   fork/verify-linux-release.sh --stop <폴더>   (~/orca-fork-build 바로 아래 폴더 하나: --keep으로 남긴 앱이나 정리에 실패한
#   실행을 끝내고 지운다. 검증 폴더가 아닌 빌드 폴더도 같은 확인 — 그 폴더를 쓰는 프로세스가 없을 때만 — 뒤에 지운다)
# 성공하면 작업 폴더를 지운다. --keep이면 성공 뒤 Arch 방식 앱을 띄운 채 두고(CDP 포트 출력) 사람이 Slack 화면을 본다.
# 실패하면 이 실행이 띄운 프로세스는 끄고, 로그·화면은 남겨 경로를 알려 준다.
set -euo pipefail

STOP_DIR=''
if [[ "${1:-}" == --stop ]]; then
  STOP_DIR=${2:-}
  # 작업 공간(src/, git worktree)은 받지 않는다(git worktree remove로 지운다).
  # 이름: 영숫자로 시작하는 것, 또는 끊긴 시험 포장의 .partial-*
  [[ $# == 2 && "$STOP_DIR" =~ ^"$HOME/orca-fork-build/"(\.partial-)?[A-Za-z0-9][A-Za-z0-9._-]*$ && "${STOP_DIR##*/}" != src &&
    -d "$STOP_DIR" && ! -L "$STOP_DIR" ]] ||
    { echo "사용법: $0 --stop $HOME/orca-fork-build/<폴더 이름> (src 제외, 정확한 이름 하나)" >&2; exit 1; }
  # 빌드 루트가 링크면 거부하고, 대상의 실제 경로가 실제 빌드 루트 바로 아래인지 본다(상위 링크로 밖을 지우지 않게).
  [[ ! -L "$HOME/orca-fork-build" ]] && root_real=$(realpath -e -- "$HOME/orca-fork-build") &&
    [[ "$(realpath -e -- "$STOP_DIR")" == "$root_real/${STOP_DIR##*/}" ]] ||
    { echo "$STOP_DIR가 ~/orca-fork-build 바로 아래의 실제 폴더가 아니다(빌드 루트가 링크인지 확인)" >&2; exit 1; }
else
  TAG=${1:-}
  KEEP=${2:-}
  [[ "$TAG" =~ ^fork-v([0-9]+\.[0-9]+\.[0-9]+)-([0-9]+)$ ]] || { echo "사용법: $0 fork-vX.Y.Z-N [--keep] | --stop <작업 폴더>" >&2; exit 1; }
  VERSION=${BASH_REMATCH[1]}
  [[ -z "$KEEP" || "$KEEP" == --keep ]] && [[ $# -le 2 ]] || { echo "모르는 옵션: ${*:2}" >&2; exit 1; }
fi
FORK_REPO=vbalien/orca
# 빌드 루트는 실제 폴더여야 한다(링크면 --stop이 정리를 거부한다: 만들기 전에 멈춘다).
[[ ! -L "$HOME/orca-fork-build" ]] || { echo "$HOME/orca-fork-build가 심볼릭 링크다. 실제 폴더로 바꾼 뒤 다시." >&2; exit 1; }
mkdir -p "$HOME/orca-fork-build"
if [[ -n "$STOP_DIR" ]]; then W=$STOP_DIR; else W=$(mktemp -d "$HOME/orca-fork-build/verify-$TAG-XXXX"); fi
VID=$(basename "$W")
# 같은 폴더의 실제 경로(HOME이 링크를 거치면 다르다). /proc의 현재 폴더는 실제 경로로 나온다.
W_REAL=$(realpath -e -- "$W")
in_w() { [[ "$1" == *"$W" || "$1" == *"$W/"* || "$1" == *"$W_REAL" || "$1" == *"$W_REAL/"* ]]; }
VERIFY_REF=refs/fork-verify/$VID # 이 실행만의 임시 ref(끝날 때 지운다)
XVFB_PID='' PASSED=''
SPARE_PID='' # stop_ours가 남겨 둘 PID(실행 사이에 Xvfb를 유지할 때)
# 이 실행이 띄운 것 = 환경에 ORCA_FORK_VERIFY_ID=<작업 폴더 이름>이 있는 프로세스(Xvfb, D-Bus, 앱, 렌더러, 분리된 데몬;
# 모두 이 표식을 넣은 env로 띄우고 자식은 물려받는다). 끄는 것은 이것뿐이다. 명령행에 작업 폴더가 든 다른 프로세스
# (예: 로그를 연 편집기)는 끄지 않고, 남아 있으면 작업 폴더를 지우지 않는다.
# /proc/<pid>/stat의 2번째 칸(이름)은 괄호 안에 공백이 들 수 있다: 마지막 ") " 뒤에서 칸을 센다(3번째 칸 = $1).
proc_field() { # <pid> <stat 칸 번호(3 이상)> -> 값, 못 읽으면 실패
  local st
  st=$(cat "/proc/$1/stat" 2>/dev/null) && [[ "$st" == *') '* ]] || return 1
  set -- "$2" ${st##*) }
  local n=$(($1 - 1))
  [[ -n "${!n:-}" ]] && echo "${!n}"
}
proc_start() { proc_field "$1" 22; }
# 이 스크립트의 하위 셸($(...)·파이프): 부모가 이 스크립트이고 명령행이 이 스크립트와 같은 것만. 이 스크립트가 띄운
# 다른 프로그램(Xvfb 등 직접 자식)은 명령행이 달라 정리 대상에 남는다.
SELF_CMD=$(tr '\0' ' ' <"/proc/$$/cmdline")
own_subshell() { # <pid>
  [[ "$1" == "$$" ]] && return 0
  [[ "$(proc_field "$1" 4 2>/dev/null || true)" == "$$" && "$( { tr '\0' ' ' <"/proc/$1/cmdline"; } 2>/dev/null)" == "$SELF_CMD" ]]
}
# 조회 실패 처리: 그 프로세스가 그사이 끝났으면(또는 좀비라 파일·폴더를 쥐지 않으면) 건너뛰고,
# 살아 있는데 읽지 못했으면 실패로 돌려준다(부르는 쪽은 "남았다"로 보고 지우지 않는다).
gone_or_zombie() { [[ ! -e "/proc/$1" || "$(proc_field "$1" 3 2>/dev/null || true)" == Z ]]; }
# 명령행(누구나 읽을 수 있음)에 작업 폴더가 있는가. 0: 있음, 1: 없음, 2: 읽지 못함
cmdline_has_w() {
  local -a args
  local arg
  { mapfile -d '' -t args <"/proc/$1/cmdline"; } 2>/dev/null || return 2
  for arg in "${args[@]}"; do in_w "$arg" && return 0; done
  return 1
}
# 환경·현재 폴더를 읽지 못한 살아 있는 프로세스: dump 불가로 설정된 프로그램(systemd --user, ssh-agent 등)은
# 같은 사용자도 못 읽는다. 명령행에 작업 폴더가 있거나 명령행도 못 읽으면 "확인 못 함"(실패), 아니면 이 폴더와 무관.
# 읽는 사이에 끝나는 프로세스(다른 작업의 짧은 프로세스)도 있어, 명령행을 못 읽었으면 잠깐씩 세 번 더 본다.
unreadable() { # <pid> -> 0: 무관(건너뜀), 1: 확인 못 함
  local rc try
  for try in 1 2 3 4; do
    gone_or_zombie "$1" && return 0
    rc=0
    cmdline_has_w "$1" || rc=$?
    [[ $rc == 1 ]] && return 0
    [[ $rc == 0 ]] && break # 명령행에 작업 폴더가 있다: 기다려도 바뀌지 않는다
    [[ $try == 4 ]] || sleep 0.2
  done
  echo "프로세스 $1의 환경·현재 폴더를 읽지 못했다($( { tr '\0' ' ' <"/proc/$1/cmdline"; } 2>/dev/null | cut -c1-120))" >&2
  return 1
}
ours_list() { # "PID 시작시각" 줄들. 시작시각 → 표식 → 시작시각 순으로 읽어 같을 때만(그사이 PID가 바뀌지 않았다)
  local d pid st env bad=0
  for d in /proc/[0-9]*; do
    pid=${d#/proc/}
    [[ "$pid" == "$SPARE_PID" ]] && continue
    [[ -O "$d" ]] || continue # 내 프로세스만
    own_subshell "$pid" && continue
    if ! st=$(proc_start "$pid") || ! env=$( { tr '\0' '\n' <"$d/environ"; } 2>/dev/null); then
      unreadable "$pid" || bad=1
      continue
    fi
    grep -qxF "ORCA_FORK_VERIFY_ID=$VID" <<<"$env" || continue
    [[ "$(proc_start "$pid" || true)" == "$st" ]] && echo "$pid $st"
  done
  return "$bad"
}
# 목록("PID 시작시각" 줄들)에 적은 그 프로세스(PID와 시작시각이 그대로)에만 신호를 보낸다. 시작시각을 못 읽으면 보내지 않는다.
signal_list() { # <신호> <목록>
  local pid st now
  while read -r pid st; do
    [[ -n "$pid" ]] || continue
    now=$(proc_start "$pid") || continue
    [[ "$now" == "$st" ]] && kill "-$1" "$pid" 2>/dev/null || true
  done <<<"$2"
}
alive_in() { # <목록>: 목록의 프로세스가 하나라도 아직 그대로 있으면 참(그 PID만 본다 — 반복이 싸다)
  local pid st
  while read -r pid st; do
    # 좀비는 끝난 것으로 본다(부모가 거두기 전까지 남을 뿐, 파일·폴더를 쥐지 않는다).
    [[ -n "$pid" && "$(proc_start "$pid" 2>/dev/null || true)" == "$st" ]] && ! gone_or_zombie "$pid" && return 0
  done <<<"$1"
  return 1
}
# 작업 폴더를 쓰는 다른 내 프로세스: 명령행 인자 어딘가에 작업 폴더(또는 그 안의 경로)가 있거나, 현재 폴더가 그 안.
# 이 스크립트와 그 하위 셸(부모가 이 스크립트)은 뺀다.
others_list() {
  local d pid cwd rc bad=0
  for d in /proc/[0-9]*; do
    pid=${d#/proc/}
    [[ -O "$d" && "$pid" != "$SPARE_PID" ]] || continue
    own_subshell "$pid" && continue
    if ! cwd=$(readlink "$d/cwd" 2>/dev/null); then
      unreadable "$pid" || bad=1
      continue
    fi
    if [[ "$cwd" == "$W" || "$cwd" == "$W/"* || "$cwd" == "$W_REAL" || "$cwd" == "$W_REAL/"* ]]; then echo "$pid"; continue; fi
    rc=0
    cmdline_has_w "$pid" || rc=$?
    case $rc in 0) echo "$pid" ;; 2) unreadable "$pid" || bad=1 ;; esac
  done
  return "$bad"
}
stop_ours() { # 0: 다 끝났고 작업 폴더를 쓰는 다른 프로세스도 없음, 1: 아님
  # 목록 조회가 실패하면(하위 셸 오류 포함) 남았다고 본다: 지우는 쪽으로 넘어가지 않는다.
  # 한 차례 = 전체 검색 → TERM, 마감 10초까지 그 PID만 확인 → 남으면 KILL, 마감 5초. 끄는 사이 새로 생긴 자식이
  # 있을 수 있어 전체 검색을 다시 하고, 세 차례 안에 비어야 한다(전체 상한 약 45초).
  local list others round end
  for round in 1 2 3; do
    list=$(ours_list) || return 1
    [[ -n "$list" ]] || break
    signal_list TERM "$list"
    end=$((SECONDS + 10))
    while alive_in "$list" && ((SECONDS < end)); do sleep 0.5; done
    if alive_in "$list"; then
      signal_list KILL "$list"
      end=$((SECONDS + 5))
      while alive_in "$list" && ((SECONDS < end)); do sleep 0.5; done
    fi
  done
  # 지우기 직전에 전체를 다시 찾는다.
  list=$(ours_list) || return 1
  [[ -z "$list" ]] || { echo "이 실행의 프로세스가 끝나지 않았다: $(cut -d' ' -f1 <<<"$list" | tr '\n' ' ')" >&2; return 1; }
  others=$(others_list) || { echo "프로세스 조회 실패" >&2; return 1; }
  [[ -z "$others" ]] || {
    echo "작업 폴더를 쓰는 다른 프로세스가 있다(끄지 않는다): $(tr '\n' ' ' <<<"$others")" >&2
    return 1
  }
}
if [[ -n "$STOP_DIR" ]]; then
  # 끄는 데 검증 도구는 필요 없다(검증 뒤 도구를 지웠거나 저장소를 옮겨도 끈다). 임시 ref는 할 수 있을 때만 지운다.
  stop_ours || { echo "작업 폴더를 지우지 않는다: $W" >&2; exit 1; }
  git -C "$(dirname "${BASH_SOURCE[0]}")" update-ref -d "$VERIFY_REF" 2>/dev/null || true
  rm -rf "$W"
  echo "정리했다: $W"
  exit 0
fi
REPO=$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)
for tool in gh git Xvfb dbus-daemon bsdtar makepkg node curl; do
  command -v "$tool" >/dev/null || { echo "$tool이 필요하다" >&2; exit 1; }
done
LOGS=$W/logs
mkdir -p "$LOGS"
cleanup() {
  git -C "$REPO" update-ref -d "$VERIFY_REF" 2>/dev/null || true
  if [[ -n "$PASSED" && -n "$KEEP" ]]; then
    # 앱을 일부러 남긴 성공: 기록을 확정한다.
    mv "$W/verified.json" "$RECORD" || { echo "검증 기록을 남기지 못했다: $RECORD" >&2; exit 1; }
    echo "검증 기록: $RECORD (화면 확인 뒤 게시: fork/publish-release.sh $TAG --screens-checked)"
    return
  fi
  if ! stop_ours; then
    printf '\n정리 실패: 남은 프로세스가 있어 작업 폴더를 지우지 않는다: %s\n다시 정리: fork/verify-linux-release.sh --stop %q\n' "$W" "$W" >&2
    exit 1
  fi
  if [[ -n "$PASSED" ]]; then
    if ! mv "$W/verified.json" "$RECORD"; then
      printf '검증 기록을 남기지 못했다: %s (작업 폴더를 남긴다: %s)\n' "$RECORD" "$W" >&2
      exit 1
    fi
    echo "검증 기록: $RECORD (화면 확인 뒤 게시: fork/publish-release.sh $TAG --screens-checked)"
    rm -rf "$W"
  else
    # 앱·데몬 로그(각 임시 프로필의 userData/logs)를 모은 뒤, 큰 산출물만 지우고 로그·화면은 남긴다.
    for p in "$W"/profile-*; do
      [[ -d "$p" ]] || continue
      if [[ ! -d "$p/config/orca/logs" ]] || cp -a "$p/config/orca/logs" "$LOGS/app-logs-${p##*/profile-}"; then
        rm -rf "$p"
      else
        printf '앱 로그를 옮기지 못해 프로필을 남긴다: %s\n' "$p" >&2
      fi
    done
    rm -rf "$W/dl" "$W/root" "$W/squashfs-root" "$W/aur" "$W/pkg" "$W/src"
    printf '\n실패. 로그·화면: %s\n' "$LOGS" >&2
  fi
}
trap cleanup EXIT
fail() {
  printf '실패: %s\n' "$*" >&2
  exit 1
}
ok() { printf '통과: %s\n' "$*"; }
echo "작업 폴더: $W"

# 0) 검증 도구(PKGBUILD·실행기·템플릿 검증기)는 그 릴리즈 태그의 것을 쓴다.
# 릴리즈가 가리키는 커밋을 GitHub API로 확인하고, 고정 주소에서 받은 태그가 그 커밋인지 대조한 뒤 쓴다.
release_sha=$(timeout -k 5 60 gh api "repos/$FORK_REPO/commits/$TAG" --jq .sha) || fail "$FORK_REPO의 $TAG 커밋을 읽지 못했다"
ref=$VERIFY_REF
timeout -k 5 120 git -C "$REPO" fetch --quiet --no-tags "https://github.com/$FORK_REPO" "+refs/tags/$TAG:$ref" ||
  fail "https://github.com/$FORK_REPO 에서 태그 $TAG를 받지 못했다"
[[ "$(git -C "$REPO" rev-parse "$ref^{commit}")" == "$release_sha" ]] || fail "받은 태그 $TAG가 릴리즈 커밋 $release_sha가 아니다"
mkdir -p "$W/src"
git -C "$REPO" archive "$release_sha" fork config src/shared | tar -x -C "$W/src"
export NODE_PATH=$REPO/node_modules # @electron/asar, playwright-core (확인 도구만)
ok "검증 도구: $TAG (${release_sha:0:10})"

# 1) 초안의 지금 상태(릴리즈 ID, 모든 자산의 이름·크기·sha256)를 먼저 적어 두고, 받은 파일이 그 자산인지 본다.
#    통과하면 이것을 검증 기록으로 남긴다(fork/publish-release.sh가 게시 직전에 다시 대조한다).
release_id=$(timeout -k 5 60 gh release view "$TAG" -R "$FORK_REPO" --json databaseId,isDraft,body \
  --jq 'select(.isDraft and (.body | contains("<!-- fork-release: uploading -->") | not)) | .databaseId')
[[ -n "$release_id" ]] || fail "$TAG이 다 올라간 초안이 아니다(업로드 중이거나, 이미 게시됐거나, 없음)"
timeout -k 5 60 gh api "repos/$FORK_REPO/releases/$release_id" \
  --jq '{id, assets: ([.assets[] | {name, size, digest}] | sort_by(.name))}' >"$W/release-snapshot.json"
# 모든 플랫폼 설치 파일과 SHA256SUMS.txt가 다 있고 그 밖은 없다.
diff <({ grep -v '^#' "$W/src/fork/release-assets.txt" | sed "s/@V@/$VERSION/g"; echo SHA256SUMS.txt; } | sort) \
  <(node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).assets.forEach((a)=>console.log(a.name))' "$W/release-snapshot.json" | sort) ||
  fail "초안 자산이 필수 목록과 다르다(위 차이)"
# 1) 초안 자산(인증해서 받음)과 해시
timeout -k 5 600 gh release download "$TAG" -R "$FORK_REPO" -D "$W/dl" \
  -p SHA256SUMS.txt -p orca-linux.AppImage -p "orca-ide_${VERSION}_amd64.deb"
# 받은 두 파일 각각에 목록 항목이 정확히 하나 있고 맞아야 한다(--ignore-missing만으로는 항목이 빠져도 통과).
for f in orca-linux.AppImage "orca-ide_${VERSION}_amd64.deb"; do
  [[ "$(awk -v f="$f" '$2 == f || $2 == "*" f' "$W/dl/SHA256SUMS.txt" | wc -l)" == 1 ]] || fail "SHA256SUMS.txt에 $f 항목이 하나가 아니다"
  (cd "$W/dl" && awk -v f="$f" '$2 == f || $2 == "*" f' SHA256SUMS.txt | sha256sum --quiet -c -) || fail "$f 해시가 다르다"
  digest=$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const a=r.assets.find((x)=>x.name===process.argv[2]); console.log(a ? a.digest : "")' "$W/release-snapshot.json" "$f")
  [[ "$digest" == "sha256:$(sha256sum "$W/dl/$f" | cut -d' ' -f1)" ]] || fail "$f가 기록한 초안 자산(${digest:-없음})과 다르다"
done
# SHA256SUMS.txt가 자기 자신을 뺀 모든 자산을 정확히 담고, 그 값이 초안 자산의 digest와 같다.
diff <(awk '{sub(/^\*/, "", $2); print $2 " sha256:" $1}' "$W/dl/SHA256SUMS.txt" | sort) \
  <(node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).assets.filter((a)=>a.name!=="SHA256SUMS.txt").forEach((a)=>console.log(a.name+" "+a.digest))' "$W/release-snapshot.json" | sort) ||
  fail "SHA256SUMS.txt가 초안 자산 전체와 맞지 않는다"
ok "초안 자산 해시"

# 2) Arch 패키지(이 컴퓨터 설치 방식)를 만들어 푼다
cp -a "$W/src/fork/aur/." "$W/aur/"
"$W/aur/update-pkgbuild.sh" "$TAG" >"$LOGS/update-pkgbuild.log"
cp "$W/dl/orca-ide_${VERSION}_amd64.deb" "$W/aur/orca-ide-$TAG-x86_64.deb"
(cd "$W/aur" && PKGDEST="$W/pkg" SRCDEST="$W/aur" timeout -k 10 1800 makepkg -f >"$LOGS/makepkg.log" 2>&1) ||
  fail "makepkg 실패($LOGS/makepkg.log)"
mapfile -t pkgs < <(cd "$W/aur" && PKGDEST="$W/pkg" makepkg --packagelist)
[[ ${#pkgs[@]} == 1 && -f "${pkgs[0]}" ]] || fail "패키지 파일이 하나가 아니다: ${pkgs[*]}"
mkdir -p "$W/root" && bsdtar -xf "${pkgs[0]}" -C "$W/root"
APP=$W/root/usr/lib/orca-ide
ok "Arch 패키지 $(basename "${pkgs[0]}")"

# 3) 원격 서버 템플릿 전체 대상, 빌드 define 치환, 포크 안내 문구
(cd "$W/src" && node -e "require('./config/scripts/orcad-distribution/template/verify-packaged-orcad-template.cjs')
  .verifyPackagedOrcadTemplate(process.argv[1])" "$APP") >"$LOGS/template.log" 2>&1 ||
  fail "원격 서버 템플릿이 온전하지 않다($LOGS/template.log)"
ok "원격 서버 템플릿(전체 대상)"
# asar 전체를 풀지 않는다: PKGBUILD가 (AUR처럼) 다른 OS용 unpacked 파일을 지워 extractAll이 실패한다.
# out/main·out/renderer의 JS만 읽는다(asar 안의 것, 또는 디스크에 남은 unpacked 것).
asar_check=$(node -e '
const asar = require("@electron/asar"), fs = require("fs"), path = require("path")
const [archive] = process.argv.slice(1)
const r = { mainFiles: 0, mainHasDefine: false, rendererHasNotice: false }
for (const entry of asar.listPackage(archive)) {
  const rel = entry.replace(/^[\\/]+/, "").split(path.sep).join("/")
  if (!/^out\/(main|renderer)\/.*\.(js|cjs|mjs)$/.test(rel)) continue
  const st = asar.statFile(archive, rel)
  if (!st || !("size" in st)) continue
  const onDisk = path.join(archive + ".unpacked", rel)
  if (st.unpacked && !fs.existsSync(onDisk)) continue
  const text = (st.unpacked ? fs.readFileSync(onDisk) : asar.extractFile(archive, rel)).toString()
  if (rel.startsWith("out/main/")) { r.mainFiles++; if (/\bORCA_FORK_BUILD\b/.test(text)) r.mainHasDefine = true }
  else if (text.includes("Self-update is off in this fork build")) r.rendererHasNotice = true
}
console.log(JSON.stringify(r))' "$APP/app.asar") || fail "app.asar를 읽지 못했다"
printf '%s\n' "$asar_check" >"$LOGS/asar-check.json"
[[ "$asar_check" == *'"mainHasDefine":false'* && "$asar_check" != *'"mainFiles":0,'* ]] ||
  fail "app.asar에 ORCA_FORK_BUILD가 치환되지 않고 남았거나 main 번들이 없다($LOGS/asar-check.json)"
[[ "$asar_check" == *'"rendererHasNotice":true'* ]] || fail "포크 업데이트 안내 문구가 없다($LOGS/asar-check.json)"
ok "define 치환·안내 문구(실제 값은 아래 실행 중 확인)"

# 4) 시스템 electron으로 네이티브 모듈과 CLI
electron_major=$(sed -n 's/^_electronversion=//p' "$W/aur/PKGBUILD")
E=/usr/lib/electron$electron_major/electron
[[ -x "$E" ]] || fail "$E가 없다"
(cd "$W" && env -i ORCA_FORK_VERIFY_ID="$VID" PATH=/usr/bin:/bin HOME="$W" ELECTRON_RUN_AS_NODE=1 timeout -k 5 30 "$E" -e "
const pty = require(process.argv[1] + '/node_modules/node-pty'); require(process.argv[1] + '/node_modules/koffi')
const p = pty.spawn('/bin/sh', ['-c', 'echo fork-pty-ok'], {}); let o = ''
const t = setTimeout(() => process.exit(1), 15000)
p.onData((x) => (o += x)); p.onExit((e) => { clearTimeout(t); process.exit(e.exitCode === 0 && o.includes('fork-pty-ok') ? 0 : 1) })
" "$APP") || fail "node-pty·koffi가 시스템 electron에서 돌지 않는다"
ok "node-pty·koffi PTY (시스템 electron$electron_major)"
(cd "$W" && chmod +x dl/orca-linux.AppImage && timeout -k 5 300 dl/orca-linux.AppImage --appimage-extract >/dev/null)
AIMG=$W/squashfs-root

# 5) 격리 기동 두 가지: Arch 방식(시스템 electron, 설치본과 같은 실행기 방식)과 AppImage(번들 Electron).
# 화면 번호는 Xvfb가 직접 고른다(-displayfd): 동시에 돌아도 겹치지 않는다.
exec 8<> <(:)
env ORCA_FORK_VERIFY_ID="$VID" Xvfb -displayfd 8 -screen 0 1280x800x24 -nolisten tcp >"$LOGS/xvfb.log" 2>&1 &
XVFB_PID=$!
display=''
read -r -t 20 display <&8 || true
exec 8<&-
[[ "$display" =~ ^[0-9]+$ ]] && kill -0 "$XVFB_PID" 2>/dev/null || fail "Xvfb가 뜨지 않았다($LOGS/xvfb.log)"

# 남은 시간(초). $1: 마감(SECONDS 기준)
left() { local l=$(($1 - SECONDS)); ((l > 0)) && echo "$l" || echo 0; }
cap() { (($1 < $2)) && echo "$1" || echo "$2"; } # 둘 중 작은 값

# 격리 프로필 폴더(빈 HOME·XDG, run은 0700). 무엇이든 그 안에 쓰기 전에 부른다.
prep_profile() { # <이름>
  local p=$W/profile-$1
  mkdir -p "$p/home" "$p/config" "$p/data" "$p/cache" "$p/run" && chmod 700 "$p/run"
}
# 격리 환경의 명령. $1: 프로필 이름. 나머지: 실행할 명령.
isolated() {
  local p=$W/profile-$1
  shift
  prep_profile "${p##*/profile-}"
  env -i ORCA_FORK_VERIFY_ID="$VID" PATH=/usr/bin:/bin HOME="$p/home" XDG_CONFIG_HOME="$p/config" XDG_DATA_HOME="$p/data" \
    XDG_CACHE_HOME="$p/cache" XDG_RUNTIME_DIR="$p/run" DISPLAY=":$display" ORCA_BACKGROUND_LAUNCH=1 \
    DBUS_SESSION_BUS_ADDRESS="unix:path=$p/run/bus" ORCA_USER_DATA_PATH="$p/config/orca" "$@"
}
# CDP(Playwright): 첫 창을 1280x800으로 캡처하고 렌더러에서 업데이트 상태를 읽는다. 전체 60초 상한.
cdp() { # <CDP 주소 http://127.0.0.1:PORT> <png> -> {"update": 업데이트 상태, "agents": 에이전트 감지 결과} JSON
  timeout -k 5 120 node -e "
const { chromium } = require('playwright-core')
;(async () => {
  const browser = await chromium.connectOverCDP(process.argv[1], { timeout: 30000 })
  const page = browser.contexts().flatMap((c) => c.pages())[0]
  if (!page) throw new Error('no page')
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.screenshot({ path: process.argv[2], timeout: 20000 })
  const update = await page.evaluate(() => window.api.updater.getStatus())
  // 앱 자신의 에이전트 감지를 새로 돌린다(로그인 셸 PATH까지 다시 읽음): 봇 첫 턴이 쓸 수 있는 CLI가 있는지의 실제 판정.
  const agents = await page.evaluate(() => window.api.preflight.refreshAgents())
  console.log(JSON.stringify({ update, agents }))
  process.exit(0) // 연결만 끊는다(browser.close()는 앱을 닫는다)
})().catch((e) => { console.error(e.message); process.exit(1) })" "$1" "$2"
}
# 기동 → 창 → 화면·업데이트 상태 → 런타임 준비·버전·업데이트 꺼짐.
# $1: 이름, $2: CLI를 띄울 electron, $3: CLI index.js, 나머지: 앱 명령.
check_launch() {
  local name=$1 port page st ust deadline
  local cli_cmd=("$2" "$3")
  shift 3
  prep_profile "$name"
  # 이 프로필만의 세션 버스(표식 환경변수로 띄워 stop_ours가 함께 끈다; 주인 세션 버스·키링을 쓰지 않는다).
  (($(printf %s "$W/profile-$name/run/bus" | wc -c) < 100)) || fail "세션 버스 소켓 경로가 너무 길다: $W"
  # 서비스 디렉터리가 없는 전용 설정: 자동 활성화(키링·접근성 버스 등)가 일어나지 않아, 버스 밖에 자식이 생기지 않는다.
  cat >"$W/profile-$name/dbus.conf" <<CONF
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:path=$W/profile-$name/run/bus</listen>
  <auth>EXTERNAL</auth>
  <policy context="default"><allow send_destination="*" eavesdrop="true"/><allow eavesdrop="true"/><allow own="*"/></policy>
</busconfig>
CONF
  isolated "$name" dbus-daemon --nofork --nopidfile --config-file="$W/profile-$name/dbus.conf" >"$LOGS/dbus-$name.log" 2>&1 &
  for _ in $(seq 20); do [[ -S "$W/profile-$name/run/bus" ]] && break; sleep 0.25; done
  [[ -S "$W/profile-$name/run/bus" ]] || fail "$name: 세션 버스가 뜨지 않았다($LOGS/dbus-$name.log)"
  # 포트는 앱이 고르고(0), 이 프로필에 쓴 DevToolsActivePort로만 찾는다(다른 프로세스의 CDP에 붙지 않게).
  isolated "$name" "$@" --remote-debugging-port=0 >"$LOGS/app-$name.log" 2>&1 &
  local app_pid=$! active=''
  port='' page='' deadline=$((SECONDS + 180))
  local l
  while l=$(left $deadline) && ((l > 0)); do
    kill -0 "$app_pid" 2>/dev/null || fail "$name: 앱이 끝났다($LOGS/app-$name.log)"
    active=$(find "$W/profile-$name" -name DevToolsActivePort -newer "$LOGS/xvfb.log" 2>/dev/null | head -n 1)
    if [[ -n "$active" ]]; then
      port=$(head -n 1 "$active")
      # timeout 0은 '제한 없음'이라 남은 시간을 한 번 읽어 양수일 때만 쓴다.
      page=$(timeout -k 2 "$(cap "$l" 5)" curl -fs "http://127.0.0.1:$port/json/list" 2>/dev/null | node -e '
const l = JSON.parse(require("fs").readFileSync(0, "utf8")).filter((t) => t.type === "page")
if (l[0]) console.log(l[0].id)' 2>/dev/null || true)
      [[ -n "$page" ]] && break
    fi
    l=$(left $deadline) && ((l > 0)) && sleep "$(cap "$l" 2)"
  done
  [[ -n "$page" ]] || fail "$name: 3분 안에 창이 뜨지 않았다($LOGS/app-$name.log)"
  # 런타임이 준비될 때까지(그래프 포함) 최대 3분.
  st='' deadline=$((SECONDS + 180))
  while l=$(left $deadline) && ((l > 0)); do
    st=$(isolated "$name" ELECTRON_RUN_AS_NODE=1 timeout -k 2 "$(cap "$l" 30)" "${cli_cmd[@]}" status --json 2>"$LOGS/status-$name.err") ||
      echo "status 종료 코드 $?" >>"$LOGS/status-$name.err"
    printf '%s' "$st" | node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); process.exit(s.result?.runtime?.state === "ready" ? 0 : 1)' 2>/dev/null && break
    l=$(left $deadline) && ((l > 0)) && sleep "$(cap "$l" 3)"
  done
  printf '%s\n' "$st" >"$LOGS/status-$name.json"
  printf '%s' "$st" | node -e '
const s = JSON.parse(require("fs").readFileSync(0, "utf8")); const r = s.result?.runtime
process.exit(s.ok && r?.reachable && r.state === "ready" && r.appVersion === process.argv[1] &&
  r.remoteUpdateSupport?.reason === "updater-unavailable" && r.remoteUpdateSupport?.automatic === false ? 0 : 1)' "$VERSION" 2>/dev/null ||
    fail "$name: 런타임이 준비·버전 $VERSION·자체 업데이트 꺼짐이 아니다($LOGS/status-$name.json, 마지막 오류 $LOGS/status-$name.err)"
  ust=$(cdp "http://127.0.0.1:$port" "$LOGS/window-$name.png") || fail "$name: 창을 CDP로 읽지 못했다"
  printf '%s\n' "$ust" >"$LOGS/app-state-$name.json"
  printf '%s' "$ust" | node -e 'const u=JSON.parse(require("fs").readFileSync(0,"utf8")).update; process.exit(u.state === "not-available" && u.forkUpdatesOff === true ? 0 : 1)' ||
    fail "$name: 앱의 업데이트 상태가 '포크라 꺼짐'이 아니다($LOGS/app-state-$name.json)"
  # 봇을 만들면 첫 턴이 자동으로 시도된다: 앱이 쓸 수 있는 에이전트가 없어야 한다(로그인 셸 PATH까지 읽은 판정이어야 한다).
  printf '%s' "$ust" | node -e 'const a=JSON.parse(require("fs").readFileSync(0,"utf8")).agents; process.exit(Array.isArray(a?.agents) && a.agents.length === 0 && a.shellHydrationOk === true ? 0 : 1)' ||
    fail "$name: 격리 앱이 에이전트를 찾았거나 로그인 셸 PATH를 읽지 못했다($LOGS/app-state-$name.json) — 봇 첫 턴이 실제로 돌 수 있다"
  ok "$name: 창(화면 $LOGS/window-$name.png), 런타임 준비·$VERSION, 자체 업데이트 꺼짐(forkUpdatesOff), 감지된 에이전트 없음"
  LAST_PORT=$port
}
SYS_CLI=$APP/app.asar.unpacked/out/cli/index.js
AIMG_CLI=$AIMG/resources/app.asar.unpacked/out/cli/index.js
[[ "$(isolated cli ELECTRON_RUN_AS_NODE=1 timeout -k 5 60 "$E" "$SYS_CLI" --version | tail -n 1)" == "$VERSION" ]] ||
  fail "CLI(시스템 electron) 버전이 $VERSION이 아니다"
[[ "$(isolated cli ELECTRON_RUN_AS_NODE=1 timeout -k 5 60 "$AIMG/orca-ide" "$AIMG_CLI" --version | tail -n 1)" == "$VERSION" ]] ||
  fail "CLI(AppImage) 버전이 $VERSION이 아니다"
ok "CLI --version (시스템 electron, AppImage)"

# 사용자가 AppImage를 실행할 때와 같은 진입점(AppRun: APPDIR·환경을 정한 뒤 orca-ide를 띄운다)으로 띄운다.
# AppImage 외피(FUSE 마운트)는 거치지 않는다(추출본) — 릴리즈 노트의 확인 범위에 적는다.
[[ -x "$AIMG/AppRun" ]] || fail "AppImage에 AppRun이 없다"
check_launch appimage "$AIMG/orca-ide" "$AIMG_CLI" "$AIMG/AppRun" --no-sandbox
SPARE_PID=$XVFB_PID
stop_ours || fail "AppImage 앱이 끝나지 않았다"
SPARE_PID=''

# Arch 방식: 패키지에 든 실제 데스크톱 실행기(/usr/bin/orca-ide)를 설치 경로만 풀어 낸 곳으로 바꿔 띄운다
# (/usr/bin/electronNN을 거쳐 packaged 표시, --require·_APPDIR·LD_LIBRARY_PATH 그대로).
launcher=$W/orca-ide-launcher
sed "s#/usr/lib/orca-ide#$APP#g" "$W/root/usr/bin/orca-ide" >"$launcher" && chmod +x "$launcher"
grep -qF "$APP" "$launcher" || fail "패키지의 실행기에서 설치 경로를 찾지 못했다"
check_launch arch "$E" "$SYS_CLI" "$launcher"

# 검증 기록(게시 스크립트가 대조): 시작 때 적은 초안 상태 + 태그 커밋. 정리까지 성공해야 확정한다(cleanup에서 rename).
RECORD=$HOME/orca-fork-build/verified-$TAG.json
node -e 'const fs=require("fs"); fs.writeFileSync(process.argv[3], JSON.stringify({tag:process.argv[2], tagCommit:process.argv[4], release:JSON.parse(fs.readFileSync(process.argv[1],"utf8")), verifiedAt:new Date().toISOString()}, null, 1))' \
  "$W/release-snapshot.json" "$TAG" "$W/verified.json" "$release_sha"
PASSED=1
echo "자동 확인 끝. 게시 전에 사람이 할 확인(끝나면 fork/publish-release.sh $TAG --screens-checked):"
cat "$(dirname "${BASH_SOURCE[0]}")/screen-checks.txt" # 실행 중인 스크립트 옆의 최신 안내(publish-release.sh와 같은 파일)
if [[ -n "$KEEP" ]]; then
  echo "Arch 방식 앱을 띄운 채 둔다: CDP http://127.0.0.1:$LAST_PORT , DISPLAY=:$display , 화면·로그 $LOGS"
  printf '끝내기: fork/verify-linux-release.sh --stop %q\n' "$W"
fi
