# 포크 패치를 릴리즈 위에 올리기

이 폴더는 포크(vbalien/orca) 전용이다. 업스트림(stablyai/orca)에는 올리지 않는다.

## 구조

- 업스트림은 main에서 `release/vX.Y.Z` 브랜치를 따서 cherry-pick·되돌림을 얹고, `Cut Release` 워크플로가 그 위에 `release: vX.Y.Z` 커밋과 태그를 단다. 그래서 **릴리즈 태그는 main 위에 있지 않다**. 거의 하루에 한 번 나온다. 태그 → GitHub Release 게시 → AUR `orca-ide-bin` 갱신 순이다(게시되지 않는 태그도 있다).
- 릴리즈마다 브랜치 `fork/vX.Y.Z` 하나를 둔다. 업스트림 태그 `vX.Y.Z` 위에 패치 묶음을 얹은 것이다.
  - 패치 묶음 = `git log --oneline vX.Y.Z..fork/vX.Y.Z`.
  - 새 업스트림 버전으로 옮길 때의 순서: 첫 커밋 `fork: tooling, docs and release workflow`(이 폴더와 `.github/workflows/fork-release.yml`), `fork: disable self-update`, 기능 패치(PR 하나에 커밋 하나), 맨 위 `fork: regenerate generated files`.
  - 재생성 커밋은 생성 파일만 담는다(`src/renderer/src/i18n/en-runtime-required.json`, `src/shared/rpc-contract/rpc-params-catalog.generated.ts`, `src/shared/plugins/languages/protected-copy-keys.json`). 새 기반으로 옮길 때는 묶음 안의 재생성 커밋을 모두 빼고 맨 위에 새로 만든다. 기능 패치도 생성 파일을 바꿀 수 있다(그 변경은 맨 위 재생성 커밋이 최종값으로 덮는다).
  - **이미 origin에 올라간 `fork/vX.Y.Z`를 같은 버전으로 다시 낼 때**(`--release N+1`)는 브랜치를 다시 쓰지 않는다: 재정렬·amend 없이 그 위에 쌓으므로, 중간에 예전 재생성 커밋이 남고 맨 위에 새 재생성 커밋이 하나 더 생길 수 있다. 정상이다(다음 업스트림 버전으로 옮길 때 정리된다).
- 포크 릴리즈는 태그 `fork-vX.Y.Z-N`(같은 기준으로 다시 내면 N을 올린다). 앱 버전은 업스트림과 같은 `X.Y.Z`다.
- 포크 빌드는 앱 자체 업데이트를 끈다(업스트림 새 버전으로 올라가 패치가 사라지지 않게). 업스트림의 원격 정책 데이터는 계속 받는다. 새 버전은 이 절차로 다시 만든다.

## 새 릴리즈가 나왔을 때

```bash
fork/rebase-onto-release.sh v1.4.276 --release 1
```

1. 기본 출발점은 origin/main이다(= 게시된 최신 포크 릴리즈 + 그 뒤 main에 병합된 패치). origin의 main을 명시적으로 가져오고, vbalien/orca의 Latest 릴리즈 태그 커밋이 main에 들어 있어야 한다(아니면 멈춘다: `fork/sync-main.sh <그 태그>`로 main을 맞추거나 `--from <브랜치>`). 옛 기반은 출발점에서 가장 가까운 업스트림 릴리즈 태그로 찾는다. 이미 origin에 `fork/<새태그>`가 있으면 그것을 이어서 한다(재정렬·amend 없이, push는 fast-forward만).
2. `~/orca-fork-build/src/v1.4.276`에 작업 공간(git worktree)을 만들고 `fork/v1.4.276`으로 패치를 옮긴다.
3. 충돌이 나면 멈추고 커밋과 파일을 알려 준다(종료 코드 2). 그 작업 공간에서 풀고 `git add` → `git rebase --continue`를 끝낸 뒤 같은 명령을 다시 실행하면 이어서 한다. 릴리즈에 없는 main 코드에 기대는 부분은 릴리즈 쪽 코드에 맞춘다. 기능을 바꾸거나 줄여야 하면 거기서 멈춘다.
4. 생성 파일 재생성 → `pnpm check:changed --base=v1.4.276` → `pnpm build:unpack` → 리눅스용 원격 서버 템플릿 → 이 컴퓨터용 시험 포장(`~/orca-fork-build/v1.4.276-<SHA>/`).
5. `--release 1`이면 이어서 `fork/v1.4.276`을 origin에 올리고 태그 `fork-v1.4.276-1`을 push한다. 태그가 `.github/workflows/fork-release.yml`을 돌려 맥·리눅스·윈도우 설치 파일을 만들고 **초안** 릴리즈를 만든다. 스크립트는 그 실행을 기다렸다가 초안 주소를 알려 준다. 중간에 끊기면 같은 명령을 다시 실행하면 이어서 한다.
6. 초안을 확인한 뒤(아래) 게시한다: `fork/publish-release.sh fork-v1.4.276-1 --screens-checked`(화면 확인을 마쳤다는 뜻이다). 게시 스크립트는:
   - 검증 때 기록한 자산과 지금 초안이 같을 때만 게시한다.
   - 업스트림의 게시된 최신 릴리즈가 기준보다 새것이면, 또 포크의 지금 Latest보다 오래된 태그면 게시하지 않는다.
   - 같은 컴퓨터에서 게시·main 동기화는 잠금(`~/orca-fork-build/publish.lock`)으로 하나씩만 돈다(다른 컴퓨터에서 동시에 게시하는 경우는 다루지 않는다 — 혼자 쓰는 포크).
   - 게시 요청 전에 `~/orca-fork-build/publish-pending`을 남기고 게시가 확인되면 지운다. 결과가 미확정이면(종료 2) 그 파일이 남아 다음 게시·동기화를 막는다: `gh release view <태그> --repo github.com/vbalien/orca --json isDraft`로 확인해, 게시됐으면 `fork/sync-main.sh <태그>`, 아직 초안이면 파일을 지우고 다시.
   - 게시가 확인되면 `fork/sync-main.sh`로 main을 그 릴리즈로 맞춘다(아래 "포크 main"). 이 단계가 멈추면 릴리즈는 게시된 채로 종료 1(이유를 보고 `fork/sync-main.sh <태그> …`), 결과가 미확정이면 종료 2.
7. 수동 실행: 태그를 다시 밀지 않고 처음부터 다시 빌드하려면 `gh workflow run fork-release.yml --repo github.com/vbalien/orca --ref fork-vX.Y.Z-N`. GitHub은 기본 브랜치(main)에 워크플로 파일이 있어야 받고, 실행은 그 태그의 워크플로로 돈다 — 이 기능이 들어간 커밋 이후의 태그부터 쓸 수 있다(fork-v1.4.277-1은 안 된다). 이미 게시된 태그면 빌드 전에 멈춘다.

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
  - `--keep`이면 앱을 띄운 채 두고 CDP 포트를 알려 준다. 거기서 `fork/screen-checks.txt`의 화면 확인(Slack 연결 방식·"깨우기 전에 확인" 카드, OpenAI Decisions JSON 편집의 기본값·오류 표시·저장·다시 열기, 업데이트 안내)을 하고, 출력된 `fork/verify-linux-release.sh --stop <작업 폴더>`로 끝낸다(정리에 실패한 실행도 같은 명령). `--stop`은 작업 폴더를 통째로 지운다: 남길 화면 캡처는 그 전에 밖으로 복사한다.
  - 화면 확인 5)(페어링 클라이언트의 게이트 API 키)는 서버와 클라이언트를 따로 띄워야 한다. 저장소 밖 도구 `~/orca-fork-build/gate-key-from-paired/e2e/pkg-paired-check.sh <작업 폴더> start|stop`이 `--keep` 작업 폴더의 Arch 패키지로 격리 서버(버리는 키링)와 페어링한 격리 데스크톱을 띄우고 CDP 포트를 알려 준다. `stop`을 먼저 한 뒤 `--stop`한다(그 도구가 띄운 데몬이 작업 폴더를 쓰고 있으면 `--stop`이 지우지 않는다).
- 맥·윈도우·리눅스 arm64는 여기서 실행해 볼 수 없다. 워크플로 안의 CLI `--version`·서명 검사까지만 한다(릴리즈 노트에 "실행 미확인").
- 실패하면: 일시적인 러너 오류면 `gh run rerun <id> -R vbalien/orca --failed` 뒤 같은 스크립트 명령으로 다시 기다린다(하루 안에). 코드·설정·워크플로를 고쳐야 하거나 하루가 지났으면 다음 번호(`--release 2`)로 다시 낸다. 실패한 초안·태그는 남겨 두고 정리 여부를 따로 정한다.

## 이 컴퓨터에 설치

공개된 포크 릴리즈의 deb를 AUR `orca-ide-bin`과 같은 방식(그 릴리즈의 Electron 메이저에 맞는 시스템 `electronNN`으로 재포장)으로 설치한다. 순서(되돌릴 패키지 백업, `makepkg -sf`로 패키지 만들기, 서버 멈춤, 프로필 백업, `sudo pacman -U`, 서버 준비·버전 확인, 되돌리기)는 **`fork/aur/INSTALL.md`를 처음부터 따른다**. 거기 말고 다른 곳에서 바로 설치하지 않는다.

- 시험 포장(위 4번)은 릴리즈 없이 이 컴퓨터에서 먼저 써 볼 때만 쓴다. 그 안의 `README-설치순서.md`는 pacman 관리 파일을 직접 덮어쓰는 시험용 절차다.

## 새 패치 더하기

1. origin/main(= 게시된 최신 포크 릴리즈)에서 작업 브랜치를 딴다. PR은 `--repo vbalien/orca --base main`.
2. **squash로 병합한다**(merge 커밋 금지: 패치 묶음은 선형이어야 하고, sync-main.sh는 main에 merge 커밋이 있으면 멈춘다). 생성 파일(`en-runtime-required.json`, `rpc-params-catalog.generated.ts`, `protected-copy-keys.json`)은 바꿔도 된다 — 다음 릴리즈 때 스크립트가 새 기반 쪽으로 풀고 맨 위 재생성 커밋에서 다시 만든다.
3. 다음 릴리즈에 들어가는 방법:
   - **새 업스트림 버전**: `fork/rebase-onto-release.sh v<새 버전> --release 1`이 origin/main에서 출발하므로 병합된 패치가 그대로 새 스택에 들어간다.
   - **같은 업스트림 버전으로 다시**(예: fork-v1.4.277-2): `fork/v1.4.277`은 이미 있어 스크립트가 그 브랜치를 이어서 쓴다(main에서 출발하지 않음). 그 작업 공간에서 병합 커밋을 옮기고, 새 기능을 릴리즈 노트(`fork/release-notes.template.md`의 주요 기능·알려진 한계)와 화면 확인(`fork/screen-checks.txt`)에 적어야 하면 같은 작업 공간에서 `fork:` 커밋으로 더한 뒤(태그가 그 커밋에서 렌더링된다) 다음 번호로 낸다:
     `git -C ~/orca-fork-build/src/v1.4.277 fetch origin main && git -C ~/orca-fork-build/src/v1.4.277 cherry-pick <main의 squash 커밋>` → `fork/rebase-onto-release.sh v1.4.277 --release 2`(생성 파일이 바뀌었을 때만 재생성 커밋을 새로 쌓고, 브랜치는 fast-forward로 올린다). 스크립트는 저장소의 어느 작업 트리에서 실행해도 된다(작업 공간 `src/<태그>`를 쓴다).
4. 게시 뒤 main은 새 릴리즈로 바뀐다. 그 릴리즈에 없는 main 커밋(예: 릴리즈를 만든 뒤 병합한 PR)이 있으면 sync-main.sh가 멈추고 목록을 보여 준다 — 그 커밋을 다음 릴리즈에 넣은 뒤 다시 맞춘다. 이식하면서 충돌로 내용이 바뀐 커밋은 자동 통과하지 않는다: 안내된 `git range-diff`·`git diff`로 확인한 뒤 `fork/sync-main.sh <태그> --confirm-ported <SHA>`(업스트림에 흡수된 경우 `--confirm-upstream <포크SHA>=<업스트림SHA>`).

## OpenAI 게이트 임계값 맞추기

`fork/gate-tune/tune.ts`는 정답이 붙은 글 묶음(JSONL, 예: `fork/gate-tune/cases.example.jsonl` — 지어낸 글)으로 "깨우기 전에 확인"의 OpenAI Decisions 규칙을 시험한다. 게이트의 실제 요청 생성기·답 읽기·규칙 판정을 그대로 쓴다.

```bash
node fork/gate-tune/fake-decisions.mjs 18911 &   # 먼저 가짜 서버로
node --import tsx fork/gate-tune/tune.ts --cases fork/gate-tune/cases.example.jsonl --max-input-tokens 50000 --endpoint http://127.0.0.1:18911
node --import tsx fork/gate-tune/tune.ts --cases <글.jsonl> --max-input-tokens 50000 [--config <규칙.json>] --live --out <결과.json>
```

- `--live` 없이(그리고 `--endpoint` 없이) 돌리면 요청 수와 예상 토큰만 센다. `--endpoint`는 loopback만 받는다.
- 실제 키는 `~/.config/orca-fork/openai-key`(권한 600; `--key-file`로 바꿈)에서만 읽는다. 출력·결과 파일에 키와 글 원문을 쓰지 않는다(결과는 id·정답·값만).
- 실제 실행(`--live`)은 장부 `~/.config/orca-fork/calibration/spend.jsonl`에 실행마다 예약·정산을 남기고, 장부 합계 + 이번 예산이 `--total-usd-cap`(기본 20달러)을 넘으면 시작하지 않는다. 한 번에 하나만(잠금 `spend.jsonl.lock`; 죽은 실행이 남긴 잠금은 도는 실행이 없을 때 손으로 지운다).
- `--max-input-tokens`는 추정 예산이다(요청마다 본문 바이트 + 256을 미리 잡고 응답의 usage로 정산; 바이트 단위 토크나이저라는 가정). 넘길 요청은 보내지 않고 멈춘다. 끝에 질문별 값 분포, 임계값별 놓침(깨워야 하는데 막음)·헛깨움 수, 놓침 0인 가장 높은 `atLeast`로 바꾼 규칙 전체(`unsureFrom` 없이) 제안(모든 사례가 끝까지 답했을 때만), 지금 설정의 결과, 쓴 토큰과 비용($0.10/1M 입력, 출력 무료)을 낸다.

지금 기본값(`src/shared/bots/slack-gate-default-rules.ts`)은 2026-11-26에 이렇게 골랐다(원문은 저장소 밖 보정 폴더에만 있다).

- 글: 봇이 끼어든 실제 스레드 11개의 그 뒤 사람 글 143개(깨워야 함 9 — 그중 멘션 4, 아님 126, 애매 8) + 지어낸 예시 30개(깨워야 함 16, 아님 14). 맞추기(스레드 4개)·확인(스레드 7개)은 스레드 단위로 나눴다. 애매 8개 중 하나는 결과를 본 뒤 옮겼다(봇이 올린 결과물에 "이대로 진행"이라고 답한 글: 봇을 부르지 않았지만 일을 허락하는 말이라 판단이 갈림).
- 질문 문구 9가지 × 앞 글 개수(10·5·0)를 비교했다. 앞 글을 안 보내면 놓침이 크게 는다. 고른 문구는 "멘션이면 참 / 본문에 남은 `<@…>`는 다른 사람·앱" 설명을 더한 것이다. 확인 묶음의 헛깨움(다른 봇과의 대화)을 보고 문구 두 개를 더 시험했지만 나아지지 않아 채택하지 않았다.
- 고른 값(atLeast 0.5, unsureFrom 0.25, whenUnsure wake → 실질 기준 0.25)에서: 맞추기 묶음 놓침 0/3·헛깨움 9/111, 확인 묶음 놓침 0/2·헛깨움 7/15(옛 문구는 합쳐 28/126), 지어낸 예시 놓침 0/16·헛깨움 0/14. 실제 깨워야 할 글의 가장 낮은 값 0.63, 지어낸 예시 0.54.
- 표본이 작다(실제 깨워야 할 답글 5개). 확인 묶음의 헛깨움은 대부분 "이 봇이 부탁한 일을 받은 사람이 자기 봇에게 넘기는 대화" 같은 다른 봇과의 대화다. 짧은 멘션(본문에서 봇 멘션이 지워져 두세 글자만 남는 글)은 `mentioned: true`여도 낮게 나온다 — 기본값은 멘션을 확인하지 않으므로 괜찮지만, 멘션까지 확인하게 바꾸거나 Orca Cloud 경로(멘션인지 모르는 스레드 글)에서는 놓칠 수 있다.
- 지연 p50 235ms, p95 454ms. 글 하나에 입력 약 1,150토큰(약 0.00012달러). refusal은 관측되지 않았다.

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

- **main = 게시된 최신 포크 릴리즈**(그 태그 커밋; 태그 뒤 브랜치 커밋이 도구 경로 `fork/**`·`.github/workflows/fork-release.yml`만 바꿨으면 브랜치 끝). 게시 스크립트가 게시 확인 뒤 `fork/sync-main.sh <태그>`로 `--force-with-lease`(맨 --force 없음, `--no-follow-tags`) 푸시한다. 단독으로도 돌릴 수 있지만 그 태그가 지금 Latest일 때만 움직인다.
- 안전장치: 지금 main의 포크 커밋(main의 기반 릴리즈 태그 위의 커밋) 중 새 대상에 없는 것은 다음일 때만 통과한다 — 재생성 커밋, 새 스택이나 새 업스트림 기반에 patch-id가 같은 커밋이 있고 그 커밋이 바꾼 모든 경로의 내용이 새 대상과 똑같음, 또는 사람이 `--confirm-ported`/`--confirm-upstream`으로 확인함. 아니면 멈춘다. main에 merge 커밋이 있거나, main의 기반이 더 새 릴리즈거나, 원격 주소(insteadOf까지 펼친 실제 fetch·push 주소)가 vbalien/orca·stablyai/orca가 아니면 멈춘다.
- 기록: `~/orca-fork-build/main-history.log`에 시도(attempt: 이전·새 SHA, 사라지는 커밋마다 `원본:판정 방식:대응 커밋` 전체 SHA)와 결과(confirmed·unchanged·unknown, 관측 SHA)를 남긴다. 되돌리는 명령은 성공 때 출력된다: `git push --no-follow-tags --force-with-lease=refs/heads/main:<새> origin <이전>:refs/heads/main`.
- main을 처음 이렇게 바꾸기 전의 main(업스트림 main + PR #1~#4)은 `archive/main-before-release-base`(4384f615d)에 남아 있다.
- 주인 클론 맞추기(작업 트리가 깨끗하고 로컬 main에 원격 어디에도 없는 커밋이 없을 때만): `git -C ~/workspaces/orca fetch origin && git -C ~/workspaces/orca status --short && git -C ~/workspaces/orca log --oneline main --not origin/main origin/archive/main-before-release-base` 가 둘 다 비어 있으면(예전 main의 커밋은 보존 브랜치에 있으므로 빼고 본다) `git -C ~/workspaces/orca checkout main && git -C ~/workspaces/orca reset --hard origin/main`. 로컬 전용 커밋이 있으면 먼저 브랜치로 남긴다(`git -C ~/workspaces/orca branch keep-main-<날짜> main`).

## 한계

- 서명이 없다: 맥은 ad-hoc 서명·공증 없음, 윈도우는 서명 없음. 첫 실행 안내는 릴리즈 노트에 있다.
- 포크 Actions: 업스트림 워크플로 66개는 설정으로 껐다(파일은 그대로, 업스트림과 충돌을 늘리지 않게). 켜 둔 것은 Fork Release와 Qualified server template(workflow_call 전용 — Fork Release가 부름)뿐이다. Headless Node server(node-server-tests.yml)는 템플릿이 부르지만 예약·PR 트리거가 있어 껐다 — 끈 워크플로도 다른 워크플로가 부르면 돈다는 GitHub 동작(커뮤니티 확인, 공식 문서 없음)에 기댄다. 릴리즈 실행에서 템플릿 단계가 "workflow is disabled" 등으로 실패하면 그것 하나만 다시 켠다: `gh workflow enable node-server-tests.yml --repo github.com/vbalien/orca`.
