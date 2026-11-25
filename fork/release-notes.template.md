> **비공식 개인 포크 빌드입니다.** [stablyai/orca](https://github.com/stablyai/orca)의 공식 릴리즈가 아니며, Stably와 관련이 없습니다. 공식 Orca는 업스트림 저장소에서 받으세요.

- 기준: 업스트림 `v@VERSION@` (@PUBLISHED@)
- 포크 릴리즈: `@TAG@`, 커밋 `@SHA@`
- 앱 버전: `@VERSION@` (업스트림과 같음)

## 들어간 패치

@PATCHES@

주요 기능:

- **Slack 깨우기 게이트**: 봇의 Slack 커넥터 설정의 "깨우기 전에 확인". 멘션·DM·스레드 답글·자동화 이벤트가 봇을 깨우기 전에 직접 지정한 명령(또는 TypeSafe Jev)으로 통과 여부를 정합니다.
- **Jev 게이트 규칙을 JSON으로 편집**: "깨우기 전에 확인"의 TypeSafe Jev 설정을 JSON 하나로 씁니다. 질문 여러 개와 각 질문의 판단 기준, Jev에 보낼 정보, 질문 답을 묶어 깨우는 규칙·막는 규칙을 정하고, 저장 전에 형식 오류를 보여 줍니다.
- **내 Slack 앱 연결(1단계)**: Orca Cloud의 Slack 앱 대신, 직접 만든 Slack 앱을 이 컴퓨터에서 Socket Mode로 연결합니다. Slack 메시지가 Orca Cloud를 거치지 않습니다. 설정 방법: [docs/slack-local-connector.md](https://github.com/vbalien/orca/blob/@TAG@/docs/slack-local-connector.md).

## 알려진 한계

- **서명 없음.** 맥은 ad-hoc 서명·공증 없음, 윈도우는 서명 없음.
- **자동 업데이트 꺼짐.** 업스트림 새 버전으로 스스로 올라가 패치가 사라지지 않도록 앱 자체 업데이트를 껐습니다. 새 버전은 이 포크의 다음 릴리즈를 직접 받아 설치하세요. (업스트림이 내려 주는 원격 정책 데이터는 그대로 받습니다.)
- **윈도우에서 명령형 게이트는 쓸 수 없습니다.** 윈도우 호스트의 봇은 "깨우기 전에 확인"에서 TypeSafe Jev만 쓸 수 있습니다(명령 실행은 거부됩니다).
- **실제 Slack 시험 전.** 게이트와 내 Slack 앱 연결은 단위·통합 테스트만 통과했고, 실제 Slack 워크스페이스에서는 아직 시험하지 않았습니다.
- **실행 확인 범위.** 리눅스(x64)는 이 컴퓨터에서 격리된 임시 프로필로 두 방식을 띄웠습니다: AppImage(추출해 AppRun으로; FUSE 마운트 외피는 거치지 않음)와 Arch용 패키지(설치하지 않고 풀어서 시스템 Electron으로). 두 방식 모두 창·서버 준비·자체 업데이트 꺼짐을 확인했고, Slack 설정 화면(연결 방식 선택, "깨우기 전에 확인" 카드, Jev JSON 편집의 오류 표시·저장·다시 열기)과 업데이트 안내 화면은 Arch 방식에서 확인했습니다. 맥은 두 아키텍처를 각자의 네이티브 러너(Intel·Apple Silicon)에서 빌드해 ad-hoc 서명 검사, 패키징 때의 터미널 호스트 PTY 기동 검사, 포함된 CLI `--version` 검사를 통과했습니다. 윈도우·리눅스 arm64는 빌드와 CLI `--version` 검사만 통과했습니다. 맥·윈도우·리눅스 arm64의 앱 실행은 확인하지 못했습니다.
- 맥에서 가능한 차이(확인 못 함): 빌드마다 서명 신원이 달라 키체인 항목과 화면 기록·접근성·폴더 접근 권한을 새 빌드마다 다시 물을 수 있습니다. 터미널 데몬이 다른 방식으로 뜰 수 있습니다.

## 처음 열 때

서명이 없으므로 경고를 넘기기 전에 받은 파일을 아래 "파일 확인"의 `SHA256SUMS.txt`로 먼저 확인하세요(전송 중 손상·바꿔치기 확인용이며, 서명을 대신하지는 않습니다).

- **맥**: dmg를 열어 Orca를 응용 프로그램으로 옮긴 뒤, 처음 한 번 "확인되지 않은 개발자"로 막히면 시스템 설정 → 개인정보 보호 및 보안 → "그래도 열기"를 누르거나, 터미널에서 `xattr -dr com.apple.quarantine /Applications/Orca.app` 후 엽니다. Apple Silicon은 `orca-macos-arm64.dmg`, Intel은 `orca-macos-x64.dmg`.
- **윈도우**: `orca-windows-setup.exe` 실행 때 SmartScreen "Windows의 PC 보호"가 뜨면 "추가 정보" → "실행".
- **리눅스**: AppImage는 실행 권한을 주고 실행, 또는 deb·rpm 설치. Arch 계열은 [fork/aur/INSTALL.md](https://github.com/vbalien/orca/blob/@TAG@/fork/aur/INSTALL.md).

## 파일 확인

`SHA256SUMS.txt`의 그 파일 줄과 값이 같아야 합니다.

- 리눅스: `sha256sum -c --ignore-missing SHA256SUMS.txt`
- 맥: `shasum -a 256 orca-macos-arm64.dmg` (받은 파일 이름으로)
- 윈도우(PowerShell): `Get-FileHash .\orca-windows-setup.exe -Algorithm SHA256`
