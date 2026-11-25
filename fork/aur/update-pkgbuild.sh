#!/usr/bin/env bash
# fork/aur/PKGBUILD를 포크 릴리즈 하나(fork-vX.Y.Z-N)에 맞춘다: 버전, 내려받을 주소, 해시.
# 해시는 그 릴리즈의 SHA256SUMS.txt에서 읽는다(초안이어도 gh 로그인이면 읽힌다).
set -euo pipefail
TAG=${1:-}
[[ "$TAG" =~ ^fork-v([0-9]+\.[0-9]+\.[0-9]+)-([0-9]+)$ ]] || { echo "사용법: $0 fork-vX.Y.Z-N" >&2; exit 1; }
VERSION=${BASH_REMATCH[1]} REL=${BASH_REMATCH[2]}
cd "$(dirname "${BASH_SOURCE[0]}")"
sums=$(timeout -k 5 120 gh release download "$TAG" -R vbalien/orca -p SHA256SUMS.txt -O -)
sum_of() { # <파일 이름>
  local s
  s=$(printf '%s\n' "$sums" | awk -v f="$1" '$2 == f || $2 == "*" f { print $1 }')
  [[ "$s" =~ ^[0-9a-f]{64}$ ]] || { echo "SHA256SUMS.txt에 $1이 없다" >&2; exit 1; }
  echo "$s"
}
x64=$(sum_of "orca-ide_${VERSION}_amd64.deb")
arm=$(sum_of "orca-ide_${VERSION}_arm64.deb")
license=$(timeout -k 5 60 curl -fsSL "https://raw.githubusercontent.com/stablyai/orca/v${VERSION}/LICENSE" | sha256sum | cut -d' ' -f1)
# 시스템 electron의 메이저는 그 릴리즈의 Electron 메이저와 같아야 한다(네이티브 모듈 ABI).
electron=$(timeout -k 5 60 gh api "repos/vbalien/orca/contents/package.json?ref=$TAG" --jq .content | base64 -d |
  node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).devDependencies.electron.split(".")[0]')
[[ "$electron" =~ ^[0-9]+$ ]] || { echo "릴리즈의 Electron 버전을 읽지 못했다" >&2; exit 1; }
[[ -x "/usr/lib/electron${electron}/electron" ]] || echo "주의: 시스템에 electron${electron}이 없다(pacman -S electron${electron})." >&2
js=$(sha256sum orca-ide.js.in | cut -d' ' -f1)
sh=$(sha256sum orca-ide.sh | cut -d' ' -f1)
sed -i -E \
  -e "s/^_forktag=.*/_forktag=${TAG}/" \
  -e "s/^_electronversion=.*/_electronversion=${electron}/" \
  -e "s/^pkgver=.*/pkgver=${VERSION}/" \
  -e "s/^pkgrel=.*/pkgrel=${REL}/" \
  -e "/^sha256sums=\(/,/\)/c\\sha256sums=('${license}'\\n            '${js}'\\n            '${sh}')" \
  -e "s/^sha256sums_aarch64=.*/sha256sums_aarch64=('${arm}')/" \
  -e "s/^sha256sums_x86_64=.*/sha256sums_x86_64=('${x64}')/" \
  PKGBUILD
grep -nE '^(_forktag|pkgver|pkgrel|sha256sums)' -A2 PKGBUILD | head -12
echo "PKGBUILD를 $TAG에 맞췄다. 설치 순서는 INSTALL.md."
