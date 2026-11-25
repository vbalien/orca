#!/usr/bin/env bash
# fork/verify-linux-release.sh --stop 정리 규칙 시험(설치·네트워크 없음). ~/orca-fork-build 아래 임시 폴더만 쓴다.
#   fork/test-verify-linux.sh
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
V=$HERE/verify-linux-release.sh
T=$(mktemp -d) # 조회 실패를 넣은 사본
trap 'kill_all; rm -rf "$T"' EXIT
mkdir -p "$HOME/orca-fork-build"
pass=0 fail=0
pids=()
# 시험 프로세스와 그 자식(bash -c 안의 sleep 등)까지 끈다.
kill_all() {
  local p
  for p in "${pids[@]}"; do pkill -KILL -P "$p" 2>/dev/null; kill -KILL "$p" 2>/dev/null; done
  pids=()
}
check() { # <설명> <기대 종료 코드> <기대 폴더 상태 kept|gone> <폴더> <스크립트> -- 실행
  local desc=$1 want_rc=$2 want_dir=$3 dir=$4 script=$5 rc=0 state out
  out=$(bash "$script" --stop "$dir" 2>&1) || rc=$?
  [[ -d "$dir" ]] && state=kept || state=gone
  if [[ $rc == "$want_rc" && $state == "$want_dir" ]]; then pass=$((pass + 1)); else
    fail=$((fail + 1)); echo "실패: $desc (rc=$rc 기대 $want_rc, 폴더 $state 기대 $want_dir)"
    printf '  검증기 출력: %s\n' "$out" | head -5
  fi
}
alive() { kill -0 "$1" 2>/dev/null; }
expect() { # <설명> <참이어야 할 명령...>
  local desc=$1; shift
  if "$@"; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "실패: $desc"; fi
}
newdir() { mktemp -d "$HOME/orca-fork-build/verify-fork-v0.0.0-1-XXXX"; }

# 1) 표식 프로세스(TERM 무시, 이름에 공백·괄호)는 끄고 폴더를 지운다.
D=$(newdir); M=ORCA_FORK_VERIFY_ID=${D##*/}
env "$M" sleep 300 >/dev/null 2>&1 & pids+=($!); disown "$!"; a=$!
(exec -a 'Orca Renderer (x)' env "$M" bash -c "trap '' TERM; exec -a 'Orca (Helper) x' sleep 300") >/dev/null 2>&1 & pids+=($!); disown "$!"; b=$!
sleep 0.3
check "표식 프로세스 정리" 0 gone "$D" "$V"
expect "표식 프로세스 종료" bash -c "! kill -0 $a 2>/dev/null && ! kill -0 $b 2>/dev/null"

# 2) 폴더를 현재 폴더·파일 인자·--x=경로로 쓰는 다른 프로세스는 끄지 않고 폴더를 남긴다.
D=$(newdir); touch "$D/log"
(cd "$D" && exec sleep 300) >/dev/null 2>&1 & pids+=($!); disown "$!"; c=$!
tail -f "$D/log" >/dev/null & pids+=($!); disown "$!"; f=$!
(exec -a "ed --file=$D/log" sleep 300) >/dev/null 2>&1 & pids+=($!); disown "$!"; e=$!
sleep 0.3
check "다른 프로세스가 쓰는 폴더" 1 kept "$D" "$V"
expect "다른 프로세스는 살아 있음" bash -c "kill -0 $c && kill -0 $f && kill -0 $e"
kill_all; sleep 0.3
check "다른 프로세스가 끝난 뒤" 0 gone "$D" "$V"

# 3) 조회 실패(살아 있는 프로세스를 못 읽음)는 지우지 않는다: 환경·현재 폴더 읽기를 실패하게 한 사본.
# 표식이 든 프로세스의 환경을 못 읽는 경우(명령행에 작업 폴더가 있으면 "확인 못 함")
sed 's#! env=$( { tr#! env=$( { false \&\& tr#' "$V" >"$T/no-environ.sh"
sed 's#cwd=$(readlink "$d/cwd" 2>/dev/null)#cwd=$(false)#' "$V" >"$T/no-cwd.sh"
expect "실패 주입 사본이 원본과 다름(environ)" bash -c "! cmp -s '$V' '$T/no-environ.sh'"
expect "실패 주입 사본이 원본과 다름(cwd)" bash -c "! cmp -s '$V' '$T/no-cwd.sh'"
# 3a) 표식 프로세스의 환경을 못 읽으면(명령행에 작업 폴더가 있음) 끄지도 지우지도 않는다.
D=$(newdir); M=ORCA_FORK_VERIFY_ID=${D##*/}
env "$M" bash -c 'sleep 300; :' "app --user-data-dir=$D/p" >/dev/null 2>&1 & pids+=($!); disown "$!"; m=$!
sleep 0.3
check "환경 조회 실패" 1 kept "$D" "$T/no-environ.sh"
expect "환경을 못 읽은 표식 프로세스는 살아 있음" kill -0 "$m"
check "조회 정상(표식 프로세스 정리)" 0 gone "$D" "$V"
# 3b) 다른 프로세스의 현재 폴더를 못 읽으면 "확인 못 함"으로 보존한다(사용자로 판정해 보존하는 것과 메시지로 구분).
D=$(newdir)
bash -c 'sleep 300; :' "viewer $D/log" >/dev/null 2>&1 & pids+=($!); disown "$!"
sleep 0.3
out=$(bash "$T/no-cwd.sh" --stop "$D" 2>&1); rc=$?
expect "현재 폴더 조회 실패는 확인 못 함으로 보존" bash -c "[[ $rc == 1 && -d '$D' ]] && grep -q '읽지 못했다' <<<\"\$1\"" _ "$out"
kill_all; sleep 0.3
check "조회 정상(사용자 끝난 뒤)" 0 gone "$D" "$V"

# 4) 받는 경로: ~/orca-fork-build 바로 아래 하나(.partial-* 포함), src·심볼릭 링크·그 밖은 거부.
P=$(mktemp -d "$HOME/orca-fork-build/.partial-v0.0.0-XXXX")
check ".partial-* 허용" 0 gone "$P" "$V"
check "orca-fork-build 밖 거부" 1 kept "$T" "$V"
L=$HOME/orca-fork-build/test-stop-link-$$
ln -s "$T" "$L"
check "심볼릭 링크 거부" 1 kept "$L" "$V"
rm -f "$L"
# 링크를 거친 경로(이름은 형식에 맞지만 실제 폴더가 빌드 루트 밖)는 거부한다.
mkdir -p "$T/outside"
ln -s "$T/outside" "$HOME/orca-fork-build/test-stop-alias-$$"
check "빌드 루트 밖을 가리키는 링크 이름 거부" 1 kept "$HOME/orca-fork-build/test-stop-alias-$$" "$V"
expect "링크 너머 폴더가 남아 있음" test -d "$T/outside"
rm -f "$HOME/orca-fork-build/test-stop-alias-$$"
[[ -e "$HOME/orca-fork-build/src" ]] && check "src 거부" 1 kept "$HOME/orca-fork-build/src" "$V"

# 5) 검증기가 직접 띄운 자식(Xvfb처럼 부모가 검증기)도 정리한다: --stop 분기 맨 앞에서 표식 자식을 띄우는 사본.
awk -v pidf="$T/child.pid" '{print} /^if \[\[ -n "\$STOP_DIR" \]\]; then$/ && !done {print "  env ORCA_FORK_VERIFY_ID=\"$VID\" sleep 300 & echo $! >\"" pidf "\"; sleep 0.3"; done=1}' "$V" >"$T/child.sh"
expect "직접 자식 사본이 원본과 다름" bash -c "! cmp -s '$V' '$T/child.sh'"
D=$(newdir)
check "직접 자식 정리" 0 gone "$D" "$T/child.sh"
expect "직접 자식 종료" bash -c "[[ -s '$T/child.pid' ]] && ! kill -0 \$(cat '$T/child.pid') 2>/dev/null"

echo "통과 $pass, 실패 $fail"
[[ $fail == 0 ]]
