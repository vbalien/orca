# (시험용) Orca 포크 빌드 직접 교체 순서 (@BRANCH@ @SHA@)

> **시험용이다.** 이 순서는 pacman이 관리하는 `@INSTALLED@` 파일을 직접 덮어쓴다. 공개 포크 릴리즈를 설치할 때는 저장소의 `fork/aur/INSTALL.md`(패키지로 설치)를 쓴다.

- 빌드한 커밋: `@SHA@` (`@BRANCH@` = 업스트림 릴리즈 `@TAG@` + 포크 패치 묶음)
- 지금 설치본의 앱 버전: `@INSTALLED_VERSION@` → 이 포장본: `@TAG@` (**@DIRECTION@**, 포장할 때 기준)
- 교체할 디렉터리: `@OUT@/orca-ide/` (파일 해시 목록: `@OUT@/orca-ide.sha256`)
  - `pnpm build:unpack`의 `dist/linux-unpacked/resources/`에서 AppImage 전용 `node-runtime/`을 빼고,
    같은 소스로 만든 원격 서버 템플릿(`orcad-template/`, 대상 @TARGETS@)을 넣고,
    설치본(`@INSTALLED@`)의 `orca-ide.js`, `apparmor-profile`, `package-type`(deb), `bin/orca-ide`를 그대로 가져왔다.
  - 스크립트가 확인한 것: 포장본의 node-pty·koffi를 시스템 electron으로 불러 PTY 실행, 포장본 CLI의 `--version`.

## 먼저 읽을 것

1. 교체 전에 프로필을 백업한다. 릴리즈 사이의 저장 형식 변경과, 옛 빌드로 되돌렸을 때 봇의 `slackConnection`이 남는지는 확인하지 않았다. `slackGate`는 확인했다: OpenAI Decisions 게이트는 fork-v1.4.277-2 이하가 "게이트 없음"으로 읽고, 그 빌드가 봇 목록을 저장하면 사라진다(봇은 남는다). 새 빌드는 첫 실행 때 남은 TypeSafe Jev 게이트를 지운다.
   위 방향이 "다운그레이드"면 더 새 빌드가 쓴 프로필을 옛 코드가 읽게 되니 특히 조심한다.
2. 재시작하면 지금 도는 봇·워커 세션이 끊긴다. Orca가 다시 뜬 뒤 대화를 이어 붙이지만 진행 중이던 턴은 멈춘다.
3. 원격 서버 배포(SSH·WSL)는 설치본처럼 리눅스 x64(@TARGETS@)만 된다.
4. pacman이 관리하는 파일을 덮어쓴다. `orca-ide-bin`을 다시 설치·업그레이드하면 포크가 덮어써지므로 IgnorePkg로 막는다.
5. 포크 빌드는 앱 자체 업데이트를 끈다. 새 버전은 저장소의 절차로 다시 만든다.

## 설치 (주인이 직접)

아래 블록을 터미널에 그대로 붙여 넣는다. `bash -euo pipefail`로 돌아서 무엇이든 실패하면 그 자리에서 멈추고, 어디서 멈췄는지와 다음 할 일을 출력한다(sudo 암호는 중간에 묻는다).

```bash
bash -euo pipefail <<'INSTALL'
NEW=@OUT@/orca-ide
source @OUT@/orca-service-checks.sh          # orca_left, stop_orca, backup_profile, wait_ready
mkdir -p ~/orca-backup
BK=$(mktemp -d ~/orca-backup/@TAG@-@SHA@-XXXX)
cp @OUT@/orca-service-checks.sh "$BK/"
PHASE=before
trap 'if [ "$PHASE" = replacing ]; then
  echo "교체 중에 멈췄다. 서버를 띄우지 말고, 아래 되돌리기를 BK=$BK 로 한다."
elif [ "$PHASE" = replaced ]; then
  echo "교체는 끝났는데 서버가 뜨지 않았다. 되돌리려면 BK=$BK 로 아래 되돌리기를 한다."
else
  echo "교체 전에 멈췄다(설치본은 그대로). 서버를 멈췄다면 systemctl --user start orca-serve.service 로 다시 띄운다."
fi' ERR
echo "백업 폴더: $BK"

# 1) 포장본이 빌드 그대로인지 확인
(cd "$NEW" && sha256sum --quiet -c ../orca-ide.sha256)

# 2) pacman/paru 업그레이드에서 orca-ide-bin을 뺀다 (이미 있으면 그대로, 다른 IgnorePkg 항목은 남긴다)
if ! grep -qE '^IgnorePkg.*[ =]orca-ide-bin( |$)' /etc/pacman.conf; then
  touch "$BK/added-ignorepkg"                 # 이번에 더했다는 기록(되돌릴 때 이것만 뺀다)
  if grep -q '^IgnorePkg' /etc/pacman.conf; then
    sudo sed -i '0,/^IgnorePkg/ s/^\(IgnorePkg.*\)$/\1 orca-ide-bin/' /etc/pacman.conf
  else
    sudo sed -i '/^\[options\]/a IgnorePkg = orca-ide-bin' /etc/pacman.conf
  fi
fi
grep -qE '^IgnorePkg.*[ =]orca-ide-bin( |$)' /etc/pacman.conf

# 3) 서버를 멈춘다(봇·워커 세션이 끊긴다). 따로 띄운 창은 먼저 닫는다. PTY 데몬(열린 터미널)은 살아 있다.
stop_orca

# 4) 백업: 설치본과 프로필(PTY 데몬이 쓰는 daemon/·terminal-history/는 뺀다). 다 끝나야 완료 표식.
sudo cp -a @INSTALLED@ "$BK/orca-ide-before"
backup_profile "$BK/config-orca"
touch "$BK/.complete"

# 5) 교체
PHASE=replacing
sudo rsync -a --delete --chown=root:root "$NEW"/ @INSTALLED@/
(cd @INSTALLED@ && sha256sum --quiet -c "$NEW/../orca-ide.sha256")
PHASE=replaced

# 6) 다시 띄운다
systemctl --user start orca-serve.service
wait_ready @VERSION@                           # 3분 안에 준비·버전 @VERSION@ 확인, 아니면 로그를 보여 주고 멈춘다
echo "끝. 백업 폴더: $BK"
INSTALL
```

## 확인

```bash
@INSTALLED@/bin/orca-ide --version              # @VERSION@ (`orca`라는 이름은 다른 프로그램일 수 있어 절대 경로로)
journalctl --user -u orca-serve.service -n 50 --no-pager
pgrep -fa 'daemon-entry.js' | head -2
```

- 봇 설정 → 커넥터 → Slack에 "직접 만든 Slack 앱" 선택지와 "깨우기 전에 확인" 카드가 보이는지, 기존 봇이 평소처럼 답하는지 본다.

## 되돌리기

`BK`에는 설치 때 출력된 백업 폴더를 넣는다. 완료 표식(`.complete`)이 없는 백업은 쓰지 않는다.

```bash
BK=~/orca-backup/<설치 때 출력된 폴더> bash -euo pipefail <<'ROLLBACK'
test -f "$BK/.complete"                    # 백업이 끝까지 됐다는 표식 (없으면 여기서 멈춘다)
test -f "$BK/orca-ide-before/app.asar"
test -d "$BK/config-orca"
source "$BK/orca-service-checks.sh"
trap 'echo "되돌리기 중에 멈췄다. 원인을 고친 뒤 이 블록을 다시 돌린다."' ERR
stop_orca
sudo rsync -a --delete "$BK/orca-ide-before"/ @INSTALLED@/
# 프로필까지 되돌리려면(포크에서 바꾼 봇 설정은 사라진다; 열린 터미널도 닫힌다. 터미널 기록은 지금 것을 옮겨 온다)
# 다음 줄의 주석을 푼다. 중간에 멈춰도 이 블록을 다시 돌리면 멈춘 곳부터 잇는다:
# restore_profile "$BK"
systemctl --user start orca-serve.service
wait_ready
echo "되돌리기 끝: $(@INSTALLED@/bin/orca-ide --version | tail -n 1)"
# 시험을 끝내고 AUR 판으로 돌아가면, 설치 때 이 순서가 IgnorePkg에 더한 경우에만 뺀다:
#   [ -f "$BK/added-ignorepkg" ] && sudo sed -i -E '/^IgnorePkg/ s/ ?orca-ide-bin//' /etc/pacman.conf
ROLLBACK
```

- 쓸 백업이 없으면 `/etc/pacman.conf`의 IgnorePkg 줄을 되돌리고 `paru -S orca-ide-bin`으로 AUR 판을 다시 설치한다.
