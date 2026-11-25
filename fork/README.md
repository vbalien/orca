# 포크 패치를 릴리즈 위에 올리기

이 폴더는 포크(vbalien/orca) 전용이다. 업스트림(stablyai/orca)에는 올리지 않는다.

## 구조

- 업스트림은 main에서 `release/vX.Y.Z` 브랜치를 따서 cherry-pick·되돌림을 얹고, `Cut Release` 워크플로가 그 위에 `release: vX.Y.Z` 커밋과 태그를 단다. 그래서 **릴리즈 태그는 main 위에 있지 않다**. 거의 하루에 한 번 나온다. 태그 → GitHub Release 게시 → AUR `orca-ide-bin` 갱신 순이다(게시되지 않는 태그도 있다).
- 릴리즈마다 브랜치 `fork/vX.Y.Z` 하나를 둔다. 업스트림 태그 `vX.Y.Z` 위에 패치 묶음을 얹은 것이다.
  - 패치 묶음 = `git log --oneline vX.Y.Z..fork/vX.Y.Z`. 순서는 고정이다.
  - 첫 커밋 `fork: tooling, docs and release workflow`(이 폴더와 `.github/workflows/fork-release.yml`), `fork: disable self-update`, 기능 패치(PR 하나에 커밋 하나), 맨 위 `fork: regenerate generated files`.
  - 맨 위 커밋은 생성 파일만 담는다(`src/renderer/src/i18n/en-runtime-required.json`, `src/shared/rpc-contract/rpc-params-catalog.generated.ts`, `src/shared/plugins/languages/protected-copy-keys.json`). 스크립트가 다시 만든다(맨 위가 아니거나 내용이 달라지면 빼고 새로 만들고, 맨 위에 있고 내용이 같으면 그대로 둔다). 기능 패치는 생성 파일을 커밋하지 않는다.
- 포크 릴리즈는 태그 `fork-vX.Y.Z-N`(같은 기준으로 다시 내면 N을 올린다). 앱 버전은 업스트림과 같은 `X.Y.Z`다.
- 포크 빌드는 앱 자체 업데이트를 끈다(업스트림 새 버전으로 올라가 패치가 사라지지 않게). 업스트림의 원격 정책 데이터는 계속 받는다. 새 버전은 이 절차로 다시 만든다.

## 새 릴리즈가 나왔을 때

```bash
fork/rebase-onto-release.sh v1.4.276 --release 1
```

1. 기본 출발점은 origin의 `fork/v*` 중 가장 높은 버전이다. 다른 것은 `--from <브랜치>`. 옛 기반은 출발점에서 가장 가까운 업스트림 릴리즈 태그로 찾는다.
2. `~/orca-fork-build/src/v1.4.276`에 작업 공간(git worktree)을 만들고 `fork/v1.4.276`으로 패치를 옮긴다.
3. 충돌이 나면 멈추고 커밋과 파일을 알려 준다(종료 코드 2). 그 작업 공간에서 풀고 `git add` → `git rebase --continue`를 끝낸 뒤 같은 명령을 다시 실행하면 이어서 한다. 릴리즈에 없는 main 코드에 기대는 부분은 릴리즈 쪽 코드에 맞춘다. 기능을 바꾸거나 줄여야 하면 거기서 멈춘다.
4. 생성 파일 재생성 → `pnpm check:changed --base=v1.4.276` → `pnpm build:unpack` → 리눅스용 원격 서버 템플릿 → 이 컴퓨터용 시험 포장(`~/orca-fork-build/v1.4.276-<SHA>/`).
5. `--release 1`이면 이어서 `fork/v1.4.276`을 origin에 올리고 태그 `fork-v1.4.276-1`을 push한다. 태그가 `.github/workflows/fork-release.yml`을 돌려 맥·리눅스·윈도우 설치 파일을 만들고 **초안** 릴리즈를 만든다. 스크립트는 그 실행을 기다렸다가 초안 주소를 알려 준다. 중간에 끊기면 같은 명령을 다시 실행하면 이어서 한다.
6. 초안을 확인한 뒤(아래) 게시한다: `fork/publish-release.sh fork-v1.4.276-1 --screens-checked`(화면 확인을 마쳤다는 뜻이다. 검증 때 기록한 자산과 지금 초안이 같을 때만 게시한다).

필요한 것:

- 항상: git 2.38 이상, Node 24(nvm에 있으면 스크립트가 쓴다), corepack, gh(로그인; `--release`·확인 때).
- 이 컴퓨터용 시험 포장(선택; 조건이 안 맞으면 건너뛰고 나머지는 계속한다): 설치본 `/usr/lib/orca-ide`(AUR `orca-ide-bin` 또는 이 포크 패키지; 설치 전용 파일 4개를 읽기만 한다), 대상 릴리즈와 같은 메이저의 `/usr/lib/electronNN`(설치본 실행기도 그 메이저여야 한다), docker(sudo 없이; glibc217 서버 슬롯).
- 게시 전 확인: Xvfb, dbus-run-session, bsdtar, makepkg, 대상 릴리즈 메이저의 electronNN.

### 게시 전 확인

- 워크플로의 모든 잡이 통과했는지(맥·리눅스·윈도우, 원격 서버 템플릿, 초안).
- 리눅스: `fork/verify-linux-release.sh fork-v1.4.276-1 --keep`. 저장소 밖 임시 폴더에서 다음을 하고, 하나라도 틀리면 멈춘다(설치·sudo 없음, 주인 프로필·설치본·키링을 쓰지 않음):
  1. 초안 자산(`gh`로 받음)의 해시가 `SHA256SUMS.txt`와 같다.
  2. 이 컴퓨터 설치 방식 그대로 Arch 패키지를 만들어 푼다(`fork/aur`를 복사해서; 저장소는 그대로).
  3. 원격 서버 템플릿이 전체 대상으로 온전하다. app.asar에 업데이트 꺼짐 플래그가 치환돼 있고 포크 안내 문구가 있다.
  4. 시스템 electron으로 node-pty·koffi PTY와 CLI `--version`이 버전과 같다. AppImage를 풀어 번들 Electron으로도 CLI 버전이 같다.
  5. 별도 Xvfb 화면·독립 D-Bus·빈 HOME/XDG로 앱을 띄워 창이 뜨고(화면 캡처 저장), 그 격리 런타임의 `status --json`이 준비·같은 버전·`updater-unavailable`이다.
  - `--keep`이면 앱을 띄운 채 두고 CDP 포트를 알려 준다. 거기서 `fork/screen-checks.txt`의 화면 확인(Slack 연결 방식·"깨우기 전에 확인" 카드, Jev JSON 편집의 오류 표시·저장·다시 열기, 업데이트 안내)을 하고, 출력된 `fork/verify-linux-release.sh --stop <작업 폴더>`로 끝낸다(정리에 실패한 실행도 같은 명령).
- 맥·윈도우·리눅스 arm64는 여기서 실행해 볼 수 없다. 워크플로 안의 CLI `--version`·서명 검사까지만 한다(릴리즈 노트에 "실행 미확인").
- 실패하면: 일시적인 러너 오류면 `gh run rerun <id> -R vbalien/orca --failed` 뒤 같은 스크립트 명령으로 다시 기다린다(하루 안에). 코드·설정·워크플로를 고쳐야 하거나 하루가 지났으면 다음 번호(`--release 2`)로 다시 낸다. 실패한 초안·태그는 남겨 두고 정리 여부를 따로 정한다.

## 이 컴퓨터에 설치

공개된 포크 릴리즈의 deb를 AUR `orca-ide-bin`과 같은 방식(그 릴리즈의 Electron 메이저에 맞는 시스템 `electronNN`으로 재포장)으로 설치한다. 순서(되돌릴 패키지 백업, `makepkg -sf`로 패키지 만들기, 서버 멈춤, 프로필 백업, `sudo pacman -U`, 서버 준비·버전 확인, 되돌리기)는 **`fork/aur/INSTALL.md`를 처음부터 따른다**. 거기 말고 다른 곳에서 바로 설치하지 않는다.

- 시험 포장(위 4번)은 릴리즈 없이 이 컴퓨터에서 먼저 써 볼 때만 쓴다. 그 안의 `README-설치순서.md`는 pacman 관리 파일을 직접 덮어쓰는 시험용 절차다.

## 새 패치 더하기

1. 지금 쓰는 `fork/vX.Y.Z`를 기준으로 작업 브랜치를 만들고 PR을 그 브랜치로 연다.
2. 생성 파일 변경은 커밋하지 않는다(커밋해도 스크립트가 다시 만든다).
3. squash로 합친 뒤 로컬 `fork/vX.Y.Z`를 origin에 맞추고 같은 태그로 스크립트를 다시 돌린다: `fork/rebase-onto-release.sh vX.Y.Z --release <다음 N>`. 재생성 커밋이 맨 위로 정리되고 검사·빌드·릴리즈를 한다.

## 정리

거의 매일 릴리즈하므로 `~/orca-fork-build`가 쌓인다(작업 공간 하나에 의존성·빌드 산출물로 수 GB, 시험 포장 하나에 약 400MB). 가끔 다음만 남기고 지운다. 브랜치·태그는 지우지 않는다.

- 남길 것: 가장 최근 릴리즈의 작업 공간(`src/<태그>`), 충돌을 푸는 중인 작업 공간, 지금 설치한 릴리즈와 그 직전 릴리즈의 AUR 빌드 폴더(`aur-<태그>-*` — 안의 `*.pkg.tar.*`가 되돌리기 후보), `aur-current`, `verified-*.json`, `~/orca-backup`의 최근 백업.
- 지울 것:
  ```bash
  git -C <저장소> worktree list                     # 오래된 ~/orca-fork-build/src/<태그>를 고른다
  git -C <저장소> worktree remove ~/orca-fork-build/src/v1.4.270
  ls -d ~/orca-fork-build/*/ ~/orca-fork-build/.partial-*/  # 남길 것을 빼고 지울 폴더를 하나씩 고른다(.partial-*는 끊긴 시험 포장)
  # 지우기는 하나씩, 정확한 이름으로. 그 폴더를 쓰는 프로세스(검증의 앱·데몬은 끈다, 그 밖의 것 — 열린 편집기·셸 — 은
  # 끄지 않는다)가 남아 있거나 조회에 실패하면 지우지 않는다:
  fork/verify-linux-release.sh --stop ~/orca-fork-build/v1.4.270-0123456789      # 오래된 검사 기록·시험 포장
  fork/verify-linux-release.sh --stop ~/orca-fork-build/aur-fork-v1.4.270-1-abcd # 지금·직전 설치가 아닌 AUR 빌드 폴더
  fork/verify-linux-release.sh --stop ~/orca-fork-build/verify-fork-v1.4.270-1-abcd # 끊긴 검증·--keep으로 남긴 앱
  fork/verify-linux-release.sh --stop ~/orca-fork-build/.partial-v1.4.270-0123456789-abcd # 끊긴 시험 포장
  ```

## 포크 main

아직 정하지 않았다(지금은 업스트림 main + 패치). 제안은 "main = 최신 `fork/vX.Y.Z`"(릴리즈마다 `--force-with-lease`로 갱신)다. 릴리즈 워크플로는 태그로 돌아서 main과 상관없다.

## 한계

- 서명이 없다: 맥은 ad-hoc 서명·공증 없음, 윈도우는 서명 없음. 첫 실행 안내는 릴리즈 노트에 있다.
- 포크 Actions에는 업스트림 워크플로도 등록돼 있다. 예약 실행·PR 트리거가 있는 것은 Actions 설정에서 끄는 것을 권한다(fork-release.yml만 필요).
