# 격리 E2E: 내 Slack 앱 봇의 채널 글 게이트

실제 Slack·OpenAI·Anthropic에 닿지 않고, 빌드한 앱(`pnpm build:unpack`)으로 채널 글 확인을 끝까지 돌려 본다.
가짜 Slack(Web API + Socket Mode), 가짜 OpenAI Decisions, 가짜 Anthropic API가 모두 127.0.0.1에서 돌고,
앱은 바깥 경로가 없는 네트워크 네임스페이스 안에서 임시 HOME·프로필·버리는 키링으로 뜬다. 주인 프로필·키링은 건드리지 않는다.

```sh
pnpm build:unpack
E2E_RUN=/tmp/$USER-gcm-e2e E2E_DIST=$PWD/dist/linux-unpacked \
  E2E_OLD_DIST=<직전 릴리즈의 linux-unpacked> fork/e2e-slack-local/run-all.sh
```

- `E2E_RUN`은 짧게(40자 이하): 버리는 키링의 제어 소켓이 그 아래에 생기고, 유닉스 소켓 경로는 108바이트까지다.
  길면 서버를 다시 띄운 뒤 키링이 열리지 않아 토큰·키를 못 읽는다.
- 필요한 것: Node 24, `unshare`(사용자 네임스페이스), Xvfb, `dbus-run-session`, `gnome-keyring-daemon`, PATH의 `claude` CLI
  (봇 에이전트로 쓰며 `ANTHROPIC_BASE_URL`로 가짜 Anthropic에만 붙는다. 다른 것을 쓰려면 `E2E_CLAUDE`).
- `E2E_OLD_DIST`(선택): 채널 글을 모르는 옛 빌드. 주면 같은 프로필을 옛 빌드로 바꿔 띄웠다가 되돌리는 시나리오(`scenarios-old.sh`)도 돈다.
- 결과는 표준 출력으로, 스크린샷은 `shots/`에 남는다. 원문 대화는 쓰지 않는다(모든 메시지는 지어낸 짧은 영어 문장).

## 구성

| 파일                                                                                                                                                                 | 하는 일                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `boot.sh`                                                                                                                                                            | 실행 폴더·네임스페이스·가짜들·격리 서버를 띄우고, 페어링한 사람으로 봇 `chanbot`(내 Slack 앱, 주인 U0OWNER1, 질문 가능 U0ASKER1)과 OpenAI 키(가짜)를 설정                                                                                                              |
| `gates.mts`                                                                                                                                                          | 저장소의 채널 기본 규칙·banter 예시로 시나리오용 게이트 JSON을 만든다                                                                                                                                                                                                  |
| `scenarios-channel.sh`                                                                                                                                               | 채널 글 통과/차단, 허용 밖 채널, 질문 권한 없는 사람, unsure/503, 사람끼리 스레드 답글, 에이전트 NO_REPLY, 한도(하루·간격·재시작 후 유지), OpenAI 답을 잡아 둔 사이 채널을 끈 경우, NO_REPLY 뒤 재시작(같은 대화로 이어짐), 채널을 뺀 뒤 봇이 답했던 스레드(참여 복구) |
| `scenarios-script.sh`                                                                                                                                                | 서버 컴퓨터의 Orca 화면에서 규칙 스크립트(`fork/gate-rules-script/channel-rules.mjs`)를 넣고: 이름 부름, 역할 질문, 잡담, 스크립트 실패                                                                                                                                |
| `scenarios-old.sh`                                                                                                                                                   | 같은 프로필을 옛 빌드로 띄워(채널 글 무시, 대체 규칙으로 막힘, `:c` 대화는 이어지지 않고 멘션은 새 보통 대화) 다시 새 빌드로 되돌린다                                                                                                                                  |
| `set-script.sh`, `server-desktop.sh`                                                                                                                                 | 서버를 멈추고 같은 프로필을 창으로 열어 "Rules from a script" 칸을 채워 저장한 뒤 서버를 다시 띄운다(규칙 스크립트는 그 컴퓨터의 Orca 화면에서만 바꿀 수 있다)                                                                                                         |
| `fake-slack.mjs`                                                                                                                                                     | Slack Web API·Socket Mode·`POST /v1/decisions`. 질문별 답은 메시지의 태그로: `[wake]` `[banter]` `[chat]` `[unsure]` `[refuse]` `[slow]` `[hold]`(`POST /release`까지 대기) `[5xx]`                                                                                    |
| `fake-anthropic.mjs`                                                                                                                                                 | 봇 에이전트의 Messages API. `[quiet]`이면 `NO_REPLY`, `[fail]`이면 500                                                                                                                                                                                                 |
| `inject.mjs`                                                                                                                                                         | `--inspect-brk`로 멈춘 서버 main에 붙어 slack.com/api·OpenAI Decisions만 가짜로 돌리고 나머지 slack.com/openai.com은 막는다                                                                                                                                            |
| `ns.sh`, `setup.sh`, `start-server.sh`, `server-inner.sh`, `app-wrapper.sh`, `call.sh`, `paired.mjs`, `ui.cjs`, `start-client.sh`, `stop-all.sh`, `env.sh`, `lib.sh` | 네임스페이스·서버·페어링 호출·화면 조작·정리 도우미                                                                                                                                                                                                                    |

## 보는 것

각 단계는 그 사이 늘어난 Decisions 호출 수, 에이전트 턴 수(가짜 Anthropic 요청), Slack 글 수와 글이 간 스레드를 찍는다.
끝에 가짜 키·토큰 표식이 파일에 남았는지, 메시지 원문이 서버 로그·한도/참여 파일에 남았는지, `[slack-gate]` 로그 줄(본문 없음)을 찍는다.
결과 기록은 `RESULTS.md`.
