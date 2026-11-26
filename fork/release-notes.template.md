> **비공식 개인 포크 빌드입니다.** [stablyai/orca](https://github.com/stablyai/orca)의 공식 릴리즈가 아니며, Stably와 관련이 없습니다. 공식 Orca는 업스트림 저장소에서 받으세요.

- 기준: 업스트림 `v@VERSION@` (@PUBLISHED@)
- 포크 릴리즈: `@TAG@`, 커밋 `@SHA@`
- 앱 버전: `@VERSION@` (업스트림과 같음)

## 들어간 패치

@PATCHES@

주요 기능:

- **Slack 깨우기 게이트**: 봇의 Slack 커넥터 설정의 "깨우기 전에 확인". 멘션·DM·스레드 답글·자동화 이벤트가 봇을 깨우기 전에 OpenAI Decisions(또는 직접 지정한 명령)로 통과 여부를 정합니다.
- **OpenAI Decisions 게이트 규칙을 JSON으로 편집**: 질문은 OpenAI 형식 그대로(predicate·choice·score), OpenAI에 보낼 글 정보, 질문 답을 묶어 깨우는 규칙·막는 규칙을 JSON 하나로 쓰고, 저장 전에 형식 오류를 보여 줍니다. 기본값은 "봇이 있는 스레드에서 봇에게 한 말이 아닌 답글에는 깨지 않기"(영어 질문, 스레드 답글만 확인, 애매하거나 확인이 실패하면 깨움)입니다. OpenAI API 키는 명령용 키와 따로, 봇이 도는 컴퓨터의 OS 키링에 봉인됩니다.
- **TypeSafe Jev 방식은 빠졌습니다.** 저장돼 있던 Jev 게이트는 처음 실행할 때 지워지고(봇은 그대로, 게이트 없음 = 확인 없이 깨움) 카드에 한 줄 안내가 남습니다. 다른 방식으로 바뀌지 않으므로 Slack 글이 OpenAI로 가지 않습니다.
- **페어링한 컴퓨터에서 게이트 API 키 저장**: 서버(`orca serve`)에서 도는 봇의 "깨우기 전에 확인" API 키를, 그 서버에 페어링한 다른 컴퓨터의 Orca에서 저장·지울 수 있습니다. 키는 봇이 도는 컴퓨터의 OS 키링에 봉인됩니다. 에이전트 CLI는 여전히 키를 바꿀 수 없고, 명령형 게이트의 명령은 봇이 도는 컴퓨터에서만 바꿉니다.
- **내 Slack 앱 연결(1단계)**: Orca Cloud의 Slack 앱 대신, 직접 만든 Slack 앱을 이 컴퓨터에서 Socket Mode로 연결합니다. Slack 메시지가 Orca Cloud를 거치지 않습니다. 설정 방법: [docs/slack-local-connector.md](https://github.com/vbalien/orca/blob/@TAG@/docs/slack-local-connector.md).

## 알려진 한계

- **서명 없음.** 맥은 ad-hoc 서명·공증 없음, 윈도우는 서명 없음.
- **자동 업데이트 꺼짐.** 업스트림 새 버전으로 스스로 올라가 패치가 사라지지 않도록 앱 자체 업데이트를 껐습니다. 새 버전은 이 포크의 다음 릴리즈를 직접 받아 설치하세요. (업스트림이 내려 주는 원격 정책 데이터는 그대로 받습니다.)
- **내 Slack 앱 연결은 데스크톱 앱에서 도는 봇만.** `orca serve` 서버에서 도는 봇은 아직 내 Slack 앱으로 연결할 수 없습니다(서버에서는 Orca Cloud의 Slack 앱만).
- **게이트 API 키는 봇이 도는 컴퓨터의 OS 키링이 있어야 저장됩니다.** 리눅스 서버라면 로그인 세션의 키링(gnome-keyring 등)이 열려 있어야 합니다.
- **윈도우에서 명령형 게이트는 쓸 수 없습니다.** 윈도우 호스트의 봇은 "깨우기 전에 확인"에서 OpenAI Decisions만 쓸 수 있습니다(명령 실행은 거부됩니다).
- **이전 포크 릴리즈로 되돌리면 OpenAI 게이트는 꺼집니다.** fork-v1.4.277-2 이하는 OpenAI Decisions를 몰라 그 게이트를 "게이트 없음"으로 읽습니다(봇은 확인 없이 깨어남, 막히지 않음). 그 빌드가 봇 목록을 한 번 저장하면 모든 봇의 OpenAI 게이트 설정이 사라지므로, 다시 올라온 뒤 다시 넣어야 합니다. OpenAI 키 파일(`bot-slack-gate-keys/openai/`)은 옛 빌드가 읽지도 지우지도 않습니다.
- **OpenAI 기본값은 작은 표본으로 맞췄습니다.** 실제 스레드 11개(깨워야 할 글 5개)와 지어낸 예시 30개로 골랐습니다(놓침 0, 실제 헛깨움 16/126). 쓰면서 놓치거나 헛깨는 글이 보이면 `fork/gate-tune`으로 다시 맞춥니다.
- **기본 설정에서 멘션은 확인 없이 깨웁니다(Orca Cloud의 스레드 안 멘션 포함).** Orca Cloud는 봇이 아직 대화하지 않는 스레드의 첫 글이 멘션인지 알려 주지 않습니다(멘션만 있는 글은 예외). 그래서 그 글은 멘션과 답글을 둘 다 확인하게 켰을 때만 확인하고, 그 밖에는 멘션이 아니어도 확인 없이 깨웁니다. 멘션 여부를 알려 주지 않는 옛 Orca Cloud에서는 연결된 스레드의 답글도 같은 이유로 확인 없이 깨웁니다. 명령형 게이트도 같습니다. 멘션까지 확인하게 켜면 두세 글자짜리 멘션은 봇에게 한 말이 아닌 것으로 판정될 수 있습니다.
- **실제 Slack 시험 전.** 게이트와 내 Slack 앱 연결은 단위·통합 테스트만 통과했고, 실제 Slack 워크스페이스에서는 아직 시험하지 않았습니다.
- **실행 확인 범위.** 리눅스(x64)는 이 컴퓨터에서 격리된 임시 프로필로 두 방식을 띄웠습니다: AppImage(추출해 AppRun으로; FUSE 마운트 외피는 거치지 않음)와 Arch용 패키지(설치하지 않고 풀어서 시스템 Electron으로). 두 방식 모두 창·서버 준비·자체 업데이트 꺼짐을 확인했고, Arch 방식의 서버(`orca serve`)에 페어링한 같은 빌드의 데스크톱에서 게이트 API 키 저장·지우기를 확인했으며, Slack 설정 화면(연결 방식 선택, "깨우기 전에 확인" 카드, OpenAI Decisions JSON 편집의 기본값·오류 표시·저장·다시 열기)과 업데이트 안내 화면은 Arch 방식에서 확인했습니다. 맥은 두 아키텍처를 각자의 네이티브 러너(Intel·Apple Silicon)에서 빌드해 ad-hoc 서명 검사, 패키징 때의 터미널 호스트 PTY 기동 검사, 포함된 CLI `--version` 검사를 통과했습니다. 윈도우·리눅스 arm64는 빌드와 CLI `--version` 검사만 통과했습니다. 맥·윈도우·리눅스 arm64의 앱 실행은 확인하지 못했습니다.
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
