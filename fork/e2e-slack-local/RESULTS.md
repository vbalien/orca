# 격리 E2E 결과: 채널 글 게이트 — 2026-11-27

빌드: 이 브랜치 커밋 fc783f39703의 `pnpm build:unpack`. 옛 빌드: fork-v1.4.278-1(main 0c7981d43ef)의 linux-unpacked.
`E2E_RUN=/tmp/claude-1000/gcm-e2e E2E_OLD_DIST=… run-all.sh`를 빈 실행 폴더에서 처음부터 돌렸다: **모든 검사 통과(종료 코드 0)**.
각 줄은 Decisions 호출 / 에이전트 요청 / Slack 쓰기(읽기 API 말고 모든 Web API 호출) 수. 기대값과 다르면 run-all이 실패한다.
가짜 Decisions는 메시지의 태그로 답한다(`[wake]` 0.95, `[chat]` 0.05, `[unsure]` 0.4, `[banter]` 잡담 질문만 0.95, `[5xx]` 503, `[hold]` 풀 때까지 대기).
에이전트는 실제 claude CLI가 가짜 Anthropic에 붙어 답한다(`[quiet]`이면 NO_REPLY, `[fail]`이면 400). 가짜 Slack은 모든 글에 표식을 붙여 누출을 찾는다.

## 채널 글 (채널 기본 규칙, 채널 C0CHAN01만, 페어링한 사람이 저장)

| #   | 경우                                         | 결과                                                                              |
| --- | -------------------------------------------- | --------------------------------------------------------------------------------- |
| 1   | 허용 채널 맨 위 글 [wake]                    | 1 / 2 / 1 — 그 글의 스레드에 답, 에이전트에 "채널 글" 안내                        |
| 2   | 맨 위 글 [chat]                              | 1 / 0 / 0                                                                         |
| 3   | 목록에 없는 채널 [wake]                      | 0 / 0 / 0 (OpenAI 호출 없음)                                                      |
| 4   | Who can ask에 없는 사람 [wake]               | 0 / 0 / 0                                                                         |
| 5   | [unsure]                                     | 1 / 0 / 0 (애매하면 채널 글은 안 깨움)                                            |
| 6   | OpenAI 503 (onError wake)                    | 1 / 0 / 0 (확인 실패면 채널 글은 안 깨움)                                         |
| 7   | 사람끼리 스레드(봇 없음)에 답글 [wake]       | 1 / 2 / 1 — channel_message로 확인, 그 스레드에 답                                |
| 8   | 맨 위 글 [wake], 에이전트 NO_REPLY           | 1 / 2 / 0                                                                         |
| 8b  | 그 조용한 스레드에 답글 [chat]               | 1 / 0 / 0 — 여전히 channel_message                                                |
| 8f  | 맨 위 글 [wake], 에이전트 요청 실패          | 1 / 24 / 0 — 실패 글("API Error …")도 참여 전이라 Slack 0, 재시도가 끝난 뒤까지 0 |
| 8g  | 그 스레드에 답글 [chat]                      | 1 / 0 / 0 — 여전히 channel_message                                                |
| 9   | 봇이 답한 스레드 1에 답글 [chat]             | 1 / 0 / 0 — thread_reply                                                          |
| 10  | 조용한 스레드 8에 멘션                       | 0 / 2 / 1                                                                         |
| 23  | 멘션, Slack이 첫 게시를 429(Retry-After 3초) | 0 / 2 / 2 — 기다렸다 다시 게시                                                    |

## 빈도 제한

| #   | 경우                                                                                                    | 결과                                                                      |
| --- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 11  | banter 예시(잡담 하루 1번) [banter]                                                                     | 1 / 2 / 1 — 에이전트에 이유 "joinable_banter: banter: join briefly…" 인용 |
| 12  | 다시 [banter]                                                                                           | 1 / 0 / 0 — rate_limited                                                  |
| 13  | 잡담 규칙만, 60분 간격 [banter]                                                                         | 0 / 0 / 0 — 모든 깨움 규칙이 닫혀 OpenAI·Slack 읽기 없음                  |
| 14  | 서버 재시작 뒤 [banter]                                                                                 | 0 / 0 / 0 — 간격 유지                                                     |
| 18h | 하루 1번 규칙: OpenAI 답을 붙잡은 사이 채널을 끄고 답을 풂 → 에이전트 0·쓰기 0, 채널을 다시 켜고 [wake] | 1 / 2 / 1 — 그날 한 번이 돌아와 있음                                      |

## 재시작 · 참여 복구

- 19 맨 위 글 [wake] → NO_REPLY: 1 / 2 / 0. 재시작 뒤 20 그 스레드 답글 [chat]: 1 / 0 / 0, channel_message. 21 그 스레드 멘션: 0 / 2 / 1, 에이전트 요청에 앞서 조용히 끝낸 턴의 글(같은 대화로 이어짐).
- 22 채널 목록을 끈 뒤, 재시작 전 봇이 답했던 스레드 1에 답글 [wake]: 1 / 2 / 1 — thread_reply(참여가 파일에서 복구).

## 규칙 스크립트 (fork/gate-rules-script/channel-rules.mjs, 봇 이름·채널만 바꿔서)

- 페어링한 사람이 넣으려 하면 거부 "Change a Slack gate command in Orca on this computer." 서버 컴퓨터의 Orca 화면(같은 프로필을 창으로)에서는 저장됨("Gate saved.", 실패 시 깨우지 않는다는 안내). 저장 형태: rulesCommand, 채널 목록, 옛 빌드용 onError block, newer.onError wake. 그 뒤 페어링한 사람의 변경은 거부.
- 15 이름 부름 "chanbot, …": 0 / 2 / 1 — OpenAI 없이 깨움, 이유 "called by name" 전달. 16 역할 질문 [wake]: 1 / 2 / 1. 17 [chat]: 1 / 0 / 0. 17b 목록 밖 채널: 0 / 0 / 0. 상태의 마지막 실행: ask(본문 없음).
- 스크립트를 `/usr/bin/false`로: 18 맨 위 글 0 / 0 / 0, 18b 봇이 있는 스레드 답글 0 / 0 / 0(onError wake여도 막음), 18c 멘션(게이트가 멘션을 확인하지 않음) 0 / 2 / 1. 그 뒤 화면에서 스크립트를 비움.

## 옛 빌드 왕복 (같은 프로필)

- 새 빌드: 제한 있는 게이트, 30 맨 위 글 [wake][quiet] → 조용한 `:c` 대화 1 / 2 / 0, 30b 맨 위 멘션 → 보통 대화 0 / 2 / 1.
- 옛 빌드: 31 맨 위 글 0 / 0 / 0(채널 글 모름). 32 조용한 `:c` 스레드 답글 0 / 0 / 0. 33 멘션 스레드 답글 [wake] 1 / 0 / 0, 34 [5xx] 1 / 0 / 0 — 대체 규칙과 옛 빌드용 onError block으로 막힘. 35 조용한 스레드 멘션 0 / 2 / 1 — 보통 키 새 대화로 답. 옛 빌드가 봇을 저장하며 newer·채널 목록이 빠짐.
- 새 빌드로 복귀: Restore 가능. 36 그 스레드 답글 [chat] 1 / 0 / 0 — 보통 대화의 thread_reply(`:c`는 놓음). 37 맨 위 글 0 / 0 / 0(옛 빌드 저장으로 채널 목록이 빠짐). Restore 뒤 38 맨 위 글 [wake] 1 / 2 / 1.

## 누출

- 가짜 키·토큰 표식: 서버·CLI 프로필·로그 파일 어디에도 0.
- 메시지 표식(모든 글): 서버 로그 0, 셈·참여·설정 사본 파일 0.
- `[slack-gate]` 로그 줄: case·verdict·reason·answers·rules·rulesFrom·error만(스크립트 규칙은 answers·score 없음).

## 여기서 안 한 것 (단위·통합 시험으로)

- Who can ask에서 사람을 빼는 동안 답을 붙잡기(같은 재확인 경로를 채널 끄기로 확인; 사람 빼기 RPC가 없음).
- 승인 대기 안내: 이 에이전트는 권한을 묻지 않는 모드라 만들 수 없음 → 실제 inbound·replies를 잇는 시험(slack-local-inbound-channel.test.ts).
- 429 대기 중 연결이 다른 대화로 넘어가는 경우: 내 Slack 앱에서 같은 스레드의 보통 대화가 생기는 길(옛 빌드)과 3초 대기를 맞출 수 없음 → 실제 SlackLocalReplies 시험.
- Orca Cloud 경로(로그인 필요): 실제 dispatch → seam → deliverToChat, runForEvent, bot-automation-launch를 지나는 통합 시험(connector-wake-gate-reasons/limits.test.ts).
