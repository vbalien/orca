# 포크 릴리즈를 이 컴퓨터(Arch, AUR orca-ide-bin 사용)에 설치하기

공개된 포크 릴리즈(`fork-vX.Y.Z-N`)의 deb를 AUR `orca-ide-bin`과 같은 방식으로 시스템 electron(그 릴리즈의 Electron 메이저, 예: electron43)에 얹어 `orca-ide-fork-bin` 패키지로 설치한다. 설치 경로(`/usr/lib/orca-ide`)와 실행기(`/usr/bin/orca-ide`)는 그대로라 `orca-serve.service`와 프로필은 바꿀 것이 없다. `orca-ide-bin`과 충돌(conflicts)하므로 pacman이 그것을 대체한다. 이 순서는 주인이 직접 한다(sudo).

## 0. 저장소 밖 빌드 폴더에 PKGBUILD를 그 릴리즈에 맞춘다

저장소의 `fork/aur`를 직접 고치지 않는다(작업 공간이 더러워지면 릴리즈 스크립트가 멈춘다). 그 릴리즈 태그에 든 `fork/aur`(게시 전에 검증한 것과 같은 PKGBUILD·실행기)를 꺼내 쓴다.

무엇이든 실패하면 여기서 멈춘다(다음 블록으로 넘어가지 않는다).

```bash
T=<설치할 릴리즈 태그, 예: fork-v1.4.275-1> R=<저장소> bash -euo pipefail <<'PREPARE'
git -C "$R" fetch --no-tags https://github.com/vbalien/orca "+refs/tags/$T:refs/tags/$T"
mkdir -p ~/orca-fork-build
# 매번 새 폴더(지난 폴더는 지우지 않는다: 거기 남은 패키지가 되돌리기 후보일 수 있다).
D=$(mktemp -d ~/orca-fork-build/aur-$T-XXXX)
git -C "$R" archive "$T" fork/aur | tar -x -C "$D" --strip-components=2
"$D"/update-pkgbuild.sh "$T"
[ "$(sed -n 's/^_forktag=//p' "$D/PKGBUILD")" = "$T" ]
printf '%s %s\n' "$T" "$D" >~/orca-fork-build/aur-current   # 아래 설치 블록이 이 태그·폴더를 쓴다(태그는 여기 한 곳에만 적는다)
echo "준비 끝: $D"
PREPARE
```

## 1. 백업하고 설치한다

아래 블록을 그대로 붙여 넣는다. 무엇이든 실패하면 그 자리에서 멈추고 어디서 멈췄는지 알려 준다.

```bash
read -r T D <~/orca-fork-build/aur-current && echo "설치할 릴리즈: $T ($D)"
[ "$(sed -n 's/^_forktag=//p' "$D/PKGBUILD")" = "$T" ] && cd "$D" && bash -euo pipefail <<'INSTALL'
source ./orca-service-checks.sh            # orca_left, stop_orca, backup_profile, wait_ready (되돌리기 때도 백업에서 쓴다)
VERSION=$(sed -n 's/^pkgver=//p' PKGBUILD)
mkdir -p ~/orca-backup
BK=$(mktemp -d ~/orca-backup/before-orca-ide-fork-$VERSION-XXXX)
cp ./orca-service-checks.sh "$BK/"
echo "백업 폴더: $BK"
trap 'echo "멈췄다. 백업 폴더: $BK. 서버를 멈춘 뒤라면 아래 되돌리기를 보거나 systemctl --user start orca-serve.service"' ERR

# 1) 지금 설치된 패키지를 기록하고, 정확히 같은 패키지 파일을 백업한다(되돌릴 때 쓴다).
name=$(LC_ALL=C pacman -Qoq /usr/lib/orca-ide/app.asar)
ver=$(pacman -Q "$name" | awk '{print $2}')
arch=$(LC_ALL=C pacman -Qi "$name" | awk -F': ' '/^Architecture/{print $2}')
echo "지금 설치: $name $ver ($arch)"
found=""
# AUR 도우미 캐시, 이전 포크 릴리즈의 빌드 폴더(~/orca-fork-build/aur-*), pacman 캐시. 압축 형식은 가리지 않고,
# 패키지 안의 이름·버전·아키텍처가 지금 설치된 것과 같은지 본다.
for cand in ~/.cache/paru/clone/"$name"/"$name-$ver-$arch".pkg.tar.* ~/.cache/yay/"$name"/"$name-$ver-$arch".pkg.tar.* \
  ~/orca-fork-build/aur-*/"$name-$ver-$arch".pkg.tar.* /var/cache/pacman/pkg/"$name-$ver-$arch".pkg.tar.*; do
  [ -f "$cand" ] && [[ "$cand" != *.sig ]] || continue
  [ "$(LC_ALL=C pacman -Qip "$cand" 2>/dev/null | awk -F': ' '/^(Name|Version|Architecture) /{printf "%s ", $2}')" = "$name $ver $arch " ] || continue
  found=$cand
  break
done
file=${found##*/}
if [ -z "$found" ]; then
  echo "되돌릴 패키지 파일($file)을 찾지 못했다."
  [ "${ALLOW_NO_ROLLBACK_PACKAGE:-}" = 1 ] || { echo "그래도 진행하려면 ALLOW_NO_ROLLBACK_PACKAGE=1 로 다시 실행한다(되돌릴 때 paru -S orca-ide-bin)."; false; }
else
  # 링크면 실제 파일을 복사한다(캐시를 지워도 백업만으로 되돌릴 수 있게). 백업 사본이 같은 패키지인지 다시 본다.
  cp -L --preserve=timestamps "$found" "$BK/$file"
  [ ! -L "$BK/$file" ] && cmp -s "$found" "$BK/$file" &&
    [ "$(LC_ALL=C pacman -Qip "$BK/$file" 2>/dev/null | awk -F': ' '/^(Name|Version|Architecture) /{printf "%s ", $2}')" = "$name $ver $arch " ] ||
    { echo "되돌리기 패키지 백업이 원본과 다르다: $BK/$file"; false; }
  echo "$BK/$file" >"$BK/rollback-package.txt"
fi
# 되돌린 뒤 떠야 할 버전 = 그 패키지 안의 앱 버전(시험용 직접 교체를 거쳤으면 지금 실행 파일과 다를 수 있다).
if [ -n "$found" ]; then
  bsdtar -xOf "$BK/$file" usr/lib/orca-ide/app.asar.unpacked/out/package.json | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).version' >"$BK/version-before.txt"
  now=$(/usr/lib/orca-ide/bin/orca-ide --version | tail -n 1)
  [ "$now" = "$(cat "$BK/version-before.txt")" ] || echo "알림: 지금 실행 파일은 $now, pacman에 기록된 패키지는 $(cat "$BK/version-before.txt") (직접 교체한 시험판?)"
fi

# 2) 패키지를 먼저 만든다(서버를 멈추기 전에 실패할 일은 끝낸다). 이번 PKGBUILD의 파일 하나만 쓴다.
# -s: 필요한 의존성(예: 새 Electron 메이저의 electronNN)을 먼저 설치한다(sudo를 물을 수 있다).
makepkg -sf </dev/tty
mapfile -t pkgs < <(makepkg --packagelist)
[ "${#pkgs[@]}" = 1 ] && [ -f "${pkgs[0]}" ] || { echo "만든 패키지 파일이 하나가 아니다: ${pkgs[*]}"; false; }

# 3) 서버를 멈춘다(봇·워커 세션이 끊긴다). 따로 띄운 창은 먼저 닫는다. PTY 데몬(열린 터미널)은 살아 있다.
stop_orca

# 4) 프로필 백업(서버를 멈춘 상태에서; PTY 데몬이 쓰는 daemon/·terminal-history/는 뺀다). 다 끝나야 완료 표식.
backup_profile "$BK/config-orca"
touch "$BK/.complete"

# 5) 설치. pacman이 "orca-ide-bin을 제거할까요?"를 물으면 y(충돌 패키지 대체). 질문은 터미널로 받는다.
sudo pacman -U "${pkgs[0]}" </dev/tty

# 6) 다시 띄우고 준비·버전 확인
systemctl --user start orca-serve.service
wait_ready "$VERSION"
echo "끝. $(pacman -Q orca-ide-fork-bin). 백업 폴더: $BK"
INSTALL
```

## 2. 확인

- `/usr/lib/orca-ide/bin/orca-ide --version`, `pacman -Q orca-ide-fork-bin` (`orca`라는 이름은 다른 프로그램(GNOME 화면 읽기)일 수 있어 절대 경로로 부른다)
- 봇 설정 → 커넥터 → Slack에 "직접 만든 Slack 앱" 선택지와 "깨우기 전에 확인" 카드가 보이는지, 기존 봇이 평소처럼 답하는지.
- `/usr/lib/orca-ide/bin/orca-ide status --json`의 `result.runtime.remoteUpdateSupport.reason`이 `updater-unavailable`(포크는 자체 업데이트를 끔).

## 3. 되돌리기

`BK`에는 설치 때 출력된 백업 폴더를 넣는다.

```bash
BK=~/orca-backup/<설치 때 출력된 폴더> bash -euo pipefail <<'ROLLBACK'
test -f "$BK/.complete"                    # 백업이 끝까지 됐다는 표식 (없으면 여기서 멈춘다)
pkg=$(cat "$BK/rollback-package.txt")      # 백업한 이전 패키지 파일 (없으면 아래 '패키지 파일이 없을 때')
test -f "$pkg"
before=$(cat "$BK/version-before.txt")     # 그 패키지의 앱 버전 (되돌린 뒤 이 버전이 떠야 한다)
source "$BK/orca-service-checks.sh"
trap 'echo "되돌리기 중에 멈췄다. 원인을 고친 뒤 이 블록을 다시 돌린다."' ERR
stop_orca
sudo pacman -U "$pkg" </dev/tty                # 포크 패키지를 대체할지 물으면 y
# 프로필까지 되돌리려면(포크에서 바꾼 봇 설정은 사라진다; 열린 터미널도 닫힌다. 터미널 기록은 지금 것을 옮겨 온다)
# 다음 줄의 주석을 푼다. 중간에 멈춰도 이 블록을 다시 돌리면 멈춘 곳부터 잇는다:
# restore_profile "$BK"
systemctl --user start orca-serve.service
wait_ready "$before"
echo "되돌리기 끝: $(pacman -Q "$(LC_ALL=C pacman -Qoq /usr/lib/orca-ide/app.asar)")"
ROLLBACK
```

- 패키지 파일이 없을 때: 서버를 멈추고 `paru -S orca-ide-bin`으로 AUR 최신판을 설치한다(설치 전과 버전이 다를 수 있다). 프로필 복원은 위 네 줄과 같다.
