# 설치·되돌리기 안내가 같이 쓰는 확인 함수(source해서 쓴다). 설치본은 /usr/lib/orca-ide, 프로필은 ~/.config/orca.
# shellcheck shell=bash

ORCA_APP_DIR=${ORCA_APP_DIR:-/usr/lib/orca-ide}
ORCA_PROFILE=${ORCA_PROFILE:-$HOME/.config/orca}
# pgrep -f는 정규식을 받는다: 경로를 글자 그대로 찾도록 이스케이프한다.
orca_re() { printf '%s' "$1" | sed 's/[][\.*^$+?(){}|]/\\&/g'; }
ORCA_STATUS_ERR=$(mktemp) # 마지막 status 오류(이 실행만의 파일, 0600)
trap 'rm -f "$ORCA_STATUS_ERR"' EXIT

# 이 설치본이나 프로필을 쓰는 프로세스(서버, 창, 그 자식들). PTY 데몬(daemon-entry.js)은 빼고 본다.
orca_left() {
  local out rc=0
  out=$(pgrep -af -- "$(orca_re "$ORCA_APP_DIR")/|--user-data-dir=$(orca_re "$ORCA_PROFILE")") || rc=$?
  [ "$rc" -le 1 ] || { echo "pgrep 실패($rc)" >&2; return 2; }
  printf '%s\n' "$out" | grep -v -e 'daemon-entry\.js' -e '^$' || true
}

# 서버를 멈추고, 남은 Orca 프로세스가 없을 때까지(30초) 기다린다. 남거나 조회에 실패하면 실패.
stop_orca() {
  local out rc
  systemctl --user stop orca-serve.service
  for _ in $(seq 30); do
    rc=0
    out=$(orca_left) || rc=$?
    [ "$rc" = 0 ] || { echo "프로세스 조회 실패($rc)"; return 1; }
    [ -z "$out" ] && return 0
    sleep 1
  done
  printf '%s\n' "$out"
  echo 'Orca 프로세스가 아직 돈다(위 목록). 창을 닫고 다시 돌린다.'
  return 1
}

# 이 프로필의 PTY 데몬까지 끈다(열려 있던 터미널이 닫힌다). 프로필을 통째로 되돌릴 때만 쓴다.
stop_orca_daemon() {
  local pattern rc
  pattern="daemon-entry\\.js.*$(orca_re "$ORCA_PROFILE")/"
  pkill -TERM -f -- "$pattern" || { rc=$?; [ "$rc" -le 1 ] || { echo "pkill 실패($rc)"; return 1; }; }
  for _ in $(seq 20); do
    rc=0
    pgrep -f -- "$pattern" >/dev/null || rc=$?
    [ "$rc" = 1 ] && return 0                      # 1 = 남은 데몬 없음
    [ "$rc" = 0 ] || { echo "pgrep 실패($rc)"; return 1; }
    sleep 0.5
  done
  echo 'PTY 데몬이 끝나지 않았다.'
  return 1
}

# 프로필 백업: PTY 데몬이 살아서 쓰는 daemon/·terminal-history/는 뺀다(쓰는 중인 파일이 섞이지 않게).
backup_profile() { # <대상 폴더>
  rsync -a --exclude '/daemon/' --exclude '/terminal-history/' "$ORCA_PROFILE/" "$1/"
}

# 프로필을 백업으로 통째 되돌린다(포크에서 바꾼 봇 설정은 사라지고, 열린 터미널은 닫힌다; 터미널 기록은 지금 것을 옮겨 온다).
# 어느 이동 직후에 끊겨도 다시 돌리면 잇는다: 옆으로 옮길 경로는 옮기기 전에 백업 폴더에 적고, 복원 폴더 안의
# 식별 표식(.orca-restore-id)이 제자리에 와 있으면 마지막 이동은 끝난 것으로 본다. 서버는 stop_orca로 먼저 멈춘다.
restore_profile() { # <백업 폴더>
  local bk=$1 stage=$ORCA_PROFILE.restoring id aside src tmp
  id=$(basename "$bk")
  # 마지막 이동이 끝났으면(제자리에 이번 표식) 완료 기록을 먼저 확정한다(임시 파일 → rename).
  if [ -f "$ORCA_PROFILE/.orca-restore-id" ] && [ "$(cat "$ORCA_PROFILE/.orca-restore-id")" = "$id" ] &&
    [ ! -f "$bk/profile-restored" ]; then
    cp "$bk/profile-moved-to" "$bk/profile-restored.tmp" && mv "$bk/profile-restored.tmp" "$bk/profile-restored"
  fi
  if [ -f "$bk/profile-restored" ]; then
    # 완료 뒤 남았을 수 있는 이번 표식만 정리한다.
    if [ -f "$ORCA_PROFILE/.orca-restore-id" ] && [ "$(cat "$ORCA_PROFILE/.orca-restore-id")" = "$id" ]; then
      rm -f "$ORCA_PROFILE/.ready" "$ORCA_PROFILE/.orca-restore-id"
    fi
    echo "프로필을 되돌렸다. 바꾸기 전 프로필: $(cat "$bk/profile-restored")"
    return 0
  fi
  # 1) 복원 폴더 준비(.ready까지 끝났을 때만 쓴다). 기록은 지금 프로필(이미 옮겼으면 옮긴 곳)에서.
  # 준비 폴더는 이번 백업의 것(표식 일치, 심볼릭 링크 아님)일 때만 다시 쓴다. 아니면 건드리지 않고 멈춘다.
  if [ -L "$stage" ]; then echo "$stage가 심볼릭 링크다. 확인한 뒤 지우고 다시."; return 1; fi
  if [ -e "$stage" ] && { [ ! -f "$stage/.orca-restore-id" ] || [ "$(cat "$stage/.orca-restore-id")" != "$id" ]; }; then
    echo "$stage는 이번 백업($id)의 복원 준비 폴더가 아니다. 확인한 뒤 지우고 다시."
    return 1
  fi
  # 옆으로 옮길 경로(이미 정했으면 그것). 지금 프로필과 옮길 곳이 둘 다 있으면 멈춘다.
  if [ -f "$bk/profile-moved-to" ]; then aside=$(cat "$bk/profile-moved-to"); else aside=$ORCA_PROFILE.fork-$(date +%s); fi
  # 기록은 임시 파일 → rename으로만 쓰므로 비거나 다른 형식이면 이 함수가 쓴 것이 아니다: 바꾸기 전에 멈춘다.
  case $aside in
    "$ORCA_PROFILE".fork-[0-9]*) [[ "${aside#"$ORCA_PROFILE".fork-}" =~ ^[0-9]+$ ]] || aside='' ;;
    *) aside='' ;;
  esac
  [ -n "$aside" ] || { echo "$bk/profile-moved-to의 기록이 비었거나 형식이 다르다(확인한 뒤 지우고 다시)."; return 1; }
  if [ -e "$ORCA_PROFILE" ] && [ -e "$aside" ]; then
    echo "$ORCA_PROFILE와 $aside가 둘 다 있다(무엇이 만들었는지 확인)."
    return 1
  fi
  # 검사를 다 통과했다. 여기서부터 파일을 바꾼다: 먼저 이 프로필의 PTY 데몬을 끈다(열린 터미널이 닫힌다).
  stop_orca_daemon
  if [ ! -f "$bk/profile-moved-to" ]; then
    echo "$aside" >"$bk/profile-moved-to.tmp" && mv "$bk/profile-moved-to.tmp" "$bk/profile-moved-to"
  fi
  # 1) 복원 폴더 준비: 만들자마자 표식부터, 다 채운 뒤 .ready. 기록은 지금 프로필(이미 옮겼으면 옮긴 곳)에서.
  if [ ! -f "$stage/.ready" ]; then
    if [ -e "$stage" ]; then
      find "$stage" -mindepth 1 -maxdepth 1 ! -name .orca-restore-id -exec rm -rf {} +
    else
      # 표식을 다 쓴 새 폴더를 한 번에 제자리로(만들다 끊겨도 준비 경로에는 표식 없는 폴더가 남지 않는다).
      tmp=$(mktemp -d "$ORCA_PROFILE.restoring-new-XXXX")
      echo "$id" >"$tmp/.orca-restore-id"
      mv -T "$tmp" "$stage"
    fi
    cp -a "$bk/config-orca/." "$stage/"
    touch "$stage/.ready"
  fi
  # 터미널 기록은 옮기기 직전에 지금 것(이미 옮겼으면 옮긴 곳)으로 다시 맞춘다(재개 사이에 늘었어도 최신).
  src=$ORCA_PROFILE
  [ -e "$aside" ] && src=$aside
  if [ -d "$src/terminal-history" ]; then
    rsync -a --delete "$src/terminal-history/" "$stage/terminal-history/"
  else
    rm -rf "$stage/terminal-history" # 지금 기록이 없으면 준비 폴더의 옛 기록도 남기지 않는다
  fi
  # 2) 지금 프로필을 옆으로.
  if [ -e "$ORCA_PROFILE" ]; then mv "$ORCA_PROFILE" "$aside"; fi
  # 3) 제자리로, 표식 정리.
  mv "$stage" "$ORCA_PROFILE"
  cp "$bk/profile-moved-to" "$bk/profile-restored.tmp" && mv "$bk/profile-restored.tmp" "$bk/profile-restored"
  rm -f "$ORCA_PROFILE/.ready" "$ORCA_PROFILE/.orca-restore-id"
  echo "프로필을 되돌렸다. 바꾸기 전 프로필: $aside"
}

# 서버가 준비됐고 (주면) 그 버전인지. 전체 3분, 30초마다 진행 표시. $1: 기대 버전(비우면 버전은 안 본다).
wait_ready() {
  local end=$((SECONDS + 180)) last=0 left st
  while left=$((end - SECONDS)) && ((left > 0)); do
    st=$(timeout -k 2 "$((left < 20 ? left : 20))" "$ORCA_APP_DIR/bin/orca-ide" status --json 2>"$ORCA_STATUS_ERR") ||
      echo "status 종료 코드 $?" >>"$ORCA_STATUS_ERR"
    if printf '%s' "$st" | node -e '
const r = JSON.parse(require("fs").readFileSync(0, "utf8")).result?.runtime
process.exit(r?.state === "ready" && (!process.argv[1] || r.appVersion === process.argv[1]) ? 0 : 1)' "${1:-}" 2>/dev/null; then
      return 0
    fi
    ((SECONDS - last >= 30)) && { echo "서버 준비를 기다리는 중($((end - SECONDS))초 남음)"; last=$SECONDS; }
    left=$((end - SECONDS)) && ((left > 0)) && sleep "$((left < 3 ? left : 3))"
  done
  echo "마지막 status 오류:"
  cat "$ORCA_STATUS_ERR" 2>/dev/null || true
  journalctl --user -u orca-serve.service -n 40 --no-pager || true
  return 1
}
