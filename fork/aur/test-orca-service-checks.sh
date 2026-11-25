#!/usr/bin/env bash
# orca-service-checks.sh의 restore_profile 회귀 시험(가짜 프로필, 설치본·주인 프로필 무관).
# 불변식: 어느 단계에서 끊겼다 다시 돌려도 결과 프로필 = 백업 설정 + 최신 터미널 기록, 표식 없음.
# 거부 경로(다른 백업의 준비 폴더, 심볼릭 링크, 경로 충돌)에서는 아무것도 바꾸지 않고 데몬도 끄지 않는다.
set -euo pipefail
CHECKS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/orca-service-checks.sh"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
n=0
fail() { echo "실패: $*" >&2; exit 1; }
mk() { # 새 가짜 환경 → 전역 t: 백업 설정 old, 지금 프로필 new + 터미널 기록 x
  n=$((n + 1)); t=$ROOT/$n
  mkdir -p "$t/bk/config-orca" "$t/prof/terminal-history"
  echo old >"$t/bk/config-orca/settings"; echo new >"$t/prof/settings"; echo h >"$t/prof/terminal-history/x"
}
run() { # <환경> : restore_profile 실행, 데몬 정지 횟수를 stops 파일에
  bash -euo pipefail -c 'E=$1; ORCA_PROFILE=$E/prof; source "$2"; stop_orca_daemon() { echo x >>"$E/stops"; }; restore_profile "$E/bk"' _ "$1" "$CHECKS"
}
restored_ok() { # <환경> <기대 기록 "이름=내용 ..."> (기록이 없어야 하면 빈 문자열)
  local got=''
  [ "$(cat "$1/prof/settings")" = old ] || fail "$1: 설정이 백업 것이 아니다"
  if [ -d "$1/prof/terminal-history" ]; then
    got=$(cd "$1/prof/terminal-history" && for f in *; do [ -e "$f" ] && printf '%s=%s ' "$f" "$(cat "$f")"; done)
  fi
  [ "$got" = "$2" ] || fail "$1: 기록이 '$2'가 아니라 '$got'"
  ! ls -a "$1/prof" | grep -qE '^\.(ready|orca-restore-id)$' || fail "$1: 표식이 남았다"
}
stops() { [ -f "$1/stops" ] && wc -l <"$1/stops" || echo 0; }

mk; run "$t" >/dev/null; restored_ok "$t" "x=h "; run "$t" >/dev/null; restored_ok "$t" "x=h "
[ "$(stops "$t")" = 1 ] || fail "완료 뒤 재실행이 데몬을 또 껐다"
# 경로만 기록한 뒤 끊김
mk; echo "$t/prof.fork-9" >"$t/bk/profile-moved-to"; run "$t" >/dev/null; restored_ok "$t" "x=h "
[ "$(cat "$t/prof.fork-9/settings")" = new ] || fail "옮긴 프로필이 원래 것이 아니다"
# 준비 폴더 ready 뒤 끊김 + 그사이 기록이 늘어남
mk; mkdir "$t/prof.restoring"; echo bk >"$t/prof.restoring/.orca-restore-id"; cp -a "$t/bk/config-orca/." "$t/prof.restoring/"
touch "$t/prof.restoring/.ready"; echo h2 >"$t/prof/terminal-history/y"; run "$t" >/dev/null; restored_ok "$t" "x=h y=h2 "
# 준비 폴더에 기록까지 맞춘 뒤 끊김 → 그사이 기록 내용이 바뀜 / 기록 폴더가 지워짐
mk; mkdir "$t/prof.restoring"; echo bk >"$t/prof.restoring/.orca-restore-id"; cp -a "$t/bk/config-orca/." "$t/prof.restoring/"
cp -a "$t/prof/terminal-history" "$t/prof.restoring/"; touch "$t/prof.restoring/.ready"; echo changed >"$t/prof/terminal-history/x"
run "$t" >/dev/null; restored_ok "$t" "x=changed "
mk; mkdir "$t/prof.restoring"; echo bk >"$t/prof.restoring/.orca-restore-id"; cp -a "$t/bk/config-orca/." "$t/prof.restoring/"
cp -a "$t/prof/terminal-history" "$t/prof.restoring/"; touch "$t/prof.restoring/.ready"; rm -rf "$t/prof/terminal-history"
run "$t" >/dev/null; restored_ok "$t" ""
# 준비 폴더를 만들다(표식을 쓴 임시 폴더를 옮기기 전) 끊김: 남은 임시 폴더는 무시하고 이어진다
mk; mkdir "$t/prof.restoring-new-abcd"; echo bk >"$t/prof.restoring-new-abcd/.orca-restore-id"; run "$t" >/dev/null; restored_ok "$t" "x=h "
# 옆으로 옮긴 직후 끊김
mk; echo "$t/prof.fork-9" >"$t/bk/profile-moved-to"; mkdir "$t/prof.restoring"; echo bk >"$t/prof.restoring/.orca-restore-id"
cp -a "$t/bk/config-orca/." "$t/prof.restoring/"; touch "$t/prof.restoring/.ready"; mv "$t/prof" "$t/prof.fork-9"; run "$t" >/dev/null; restored_ok "$t" "x=h "
# 마지막 이동 직후(완료 기록 전) 끊김
mk; echo "$t/prof.fork-9" >"$t/bk/profile-moved-to"; mv "$t/prof" "$t/prof.fork-9"; mkdir "$t/prof"
cp -a "$t/bk/config-orca/." "$t/prof/"; cp -a "$t/prof.fork-9/terminal-history" "$t/prof/"; echo bk >"$t/prof/.orca-restore-id"; touch "$t/prof/.ready"
run "$t" >/dev/null; restored_ok "$t" "x=h "; [ -f "$t/bk/profile-restored" ] || fail "완료 기록이 없다"
# 완료 기록 뒤·표식 삭제 전 끊김
mk; echo "$t/prof.fork-9" >"$t/bk/profile-moved-to"; mv "$t/prof" "$t/prof.fork-9"; mkdir "$t/prof"
cp -a "$t/bk/config-orca/." "$t/prof/"; cp -a "$t/prof.fork-9/terminal-history" "$t/prof/"; echo bk >"$t/prof/.orca-restore-id"
cp "$t/bk/profile-moved-to" "$t/bk/profile-restored"; run "$t" >/dev/null; restored_ok "$t" "x=h "
# 거부 경로(빈·다른 형식의 경로 기록 포함): 아무것도 바꾸지 않고 데몬도 끄지 않는다
for kind in foreign unmarked symlink conflict empty-record bad-record; do
  mk
  case $kind in
    foreign) mkdir "$t/prof.restoring"; echo other >"$t/prof.restoring/.orca-restore-id" ;;
    unmarked) mkdir "$t/prof.restoring"; echo junk >"$t/prof.restoring/f" ;;
    symlink) ln -s "$ROOT" "$t/prof.restoring" ;;
    conflict) echo "$t/prof.fork-9" >"$t/bk/profile-moved-to"; mkdir "$t/prof.fork-9" ;;
    empty-record) : >"$t/bk/profile-moved-to" ;;
    bad-record) echo "$ROOT" >"$t/bk/profile-moved-to" ;;
  esac
  ! run "$t" >/dev/null 2>&1 || fail "$kind: 거부해야 하는데 통과했다"
  [ "$(cat "$t/prof/settings")" = new ] || fail "$kind: 프로필이 바뀌었다"
  [ "$(stops "$t")" = 0 ] || fail "$kind: 데몬을 껐다"
done
echo "restore_profile 회귀 시험 통과($n가지)"
