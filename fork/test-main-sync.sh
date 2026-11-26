#!/usr/bin/env bash
# fork/sync-main.sh·fork/publish-release.sh·fork/lib-main-sync.sh 회귀 시험. 임시 폴더의 가짜 origin·upstream(bare)과
# 가짜 gh만 쓴다(실제 원격·주인 HOME에 닿지 않는다). 운영 코드의 원격 주소 검사는 약화하지 않고, 시험에서만 PATH 앞의
# 가짜 git이 `remote get-url` 질의에 GitHub 주소로 답하고 나머지 명령은 insteadOf로 로컬 bare에 잇는다.
#   fork/test-main-sync.sh
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REAL_GIT=$(command -v git)
T=$(mktemp -d) || exit 1
[[ -d "$T" ]] || exit 1
trap 'rm -rf "$T"' EXIT
pass=0 fail=0
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); echo "실패: $*"; }
expect() { local d=$1; shift; if "$@"; then ok; else bad "$d"; fi; }

# ---- 가짜 git·gh ----
mkdir -p "$T/bin" "$T/gh"
cat >"$T/bin/git" <<EOF
#!/usr/bin/env bash
args=" \$* "
if [[ "\$args" == *" remote get-url "* ]]; then
  [[ "\$args" == *" upstream "* ]] && echo https://github.com/stablyai/orca || echo https://github.com/vbalien/orca
  exit 0
fi
if [[ "\$args" == *" push "* ]]; then
  case "\$(cat "$T/gh/push-mode" 2>/dev/null)" in
    timeout) exit 124 ;;
    timeout-lsfail) echo fail >"$T/gh/lsremote-mode"; exit 124 ;;
    applied-then-fail) "$REAL_GIT" -c url.$T/origin.git.insteadOf=https://github.com/vbalien/orca "\$@" >/dev/null 2>&1; exit 1 ;;
    race) "$REAL_GIT" --git-dir="$T/origin.git" update-ref refs/heads/main "\$(cat "$T/gh/race-sha")" ;;
    reject) echo " ! [rejected]        x -> main (stale info)"; exit 1 ;;
  esac
fi
if [[ "\$args" == *" rev-list --reverse "* && "\$(cat "$T/gh/revlist-mode" 2>/dev/null)" == fail ]]; then exit 128; fi
if [[ "\$args" == *" rev-list --merges "* && "\$(cat "$T/gh/revlist-mode" 2>/dev/null)" == merges ]]; then exit 128; fi
if [[ "\$args" == *" ls-remote "* && "\$(cat "$T/gh/lsremote-mode" 2>/dev/null)" == fail ]]; then exit 1; fi
exec "$REAL_GIT" -c url.$T/origin.git.insteadOf=https://github.com/vbalien/orca \
  -c url.$T/upstream.git.insteadOf=https://github.com/stablyai/orca "\$@"
EOF
cat >"$T/bin/gh" <<EOF
#!/usr/bin/env bash
# 상태: $T/gh/latest(포크 Latest), up-latest(업스트림 Latest), state-<태그>(draft|published), edit-mode, calls(호출 기록)
D=$T/gh
echo "\$*" >>"\$D/calls"
a=" \$* "
if [[ "\$1 \$2" == "release view" ]]; then
  [[ "\$(cat "\$D/view-mode" 2>/dev/null)" == fail ]] && { echo "HTTP 502" >&2; exit 1; }
  tag=\$3
  [[ -f "\$D/state-\$tag" ]] || { echo "release not found" >&2; exit 1; }
  st=\$(cat "\$D/state-\$tag")
  if [[ "\$a" == *databaseId* ]]; then [[ \$st == draft ]] && echo 1; exit 0; fi
  [[ \$st == published ]] && echo false || echo true
  exit 0
fi
if [[ "\$1 \$2" == "release edit" ]]; then
  tag=\$3
  case "\$(cat "\$D/edit-mode" 2>/dev/null)" in
    fail-published) echo published >"\$D/state-\$tag"; echo "\$tag" >"\$D/latest"; exit 1 ;;
    fail-draft) exit 1 ;;
    kill) kill -9 "\$(ps -o ppid= -p "\$PPID" | tr -d ' ')"; exit 1 ;; # 요청 중 게시 스크립트가 죽음(게시 안 됨)
    ok-viewfail) echo published >"\$D/state-\$tag"; echo "\$tag" >"\$D/latest"; echo fail >"\$D/view-mode"; exit 0 ;;
    *) echo published >"\$D/state-\$tag"; echo "\$tag" >"\$D/latest"; exit 0 ;;
  esac
fi
if [[ "\$1" == api ]]; then
  [[ "\$a" == *" --hostname github.com "* ]] || { echo "호스트 고정 없음: \$*" >&2; exit 9; }
  case "\$a" in
    *repos/vbalien/orca/releases/latest*)
      [[ "\$(cat "\$D/latest-mode" 2>/dev/null)" == fail ]] && { echo "HTTP 502" >&2; exit 1; }
      [[ -s "\$D/latest" ]] && cat "\$D/latest" || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; } ;;
    *repos/stablyai/orca/releases/latest*) cat "\$D/up-latest" ;;
    *repos/vbalien/orca/releases/1*) printf '{"id":1,"tag":"x","commit":"main","assets":[]}\n' ;;
    *repos/vbalien/orca/commits/*) cat "\$D/tag-commit" ;;
    *) exit 1 ;;
  esac
  exit 0
fi
exit 1
EOF
chmod +x "$T/bin/git" "$T/bin/gh"
export PATH="$T/bin:$PATH" HOME="$T/home"
mkdir -p "$HOME/orca-fork-build"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t GIT_CONFIG_GLOBAL=$T/gitconfig
G=$T/work
gw() { "$REAL_GIT" -C "$G" "$@"; }
commit() { # <파일> <내용> <제목>
  mkdir -p "$G/$(dirname "$1")"
  printf '%s\n' "$2" >"$G/$1"
  gw add -A -- "$1" && gw commit -q -m "$3" && gw rev-parse HEAD
}
GEN=src/renderer/src/i18n/en-runtime-required.json

# ---- 세계: upstream main → release 브랜치 v1.0.0, 그 뒤 main에서 잘린 v1.1.0. 포크 스택은 v1.0.0 위.
world() {
  rm -rf "$T/origin.git" "$T/upstream.git" "$G" "$T/gh"/* "$HOME/orca-fork-build"/*
  "$REAL_GIT" init -q --bare "$T/origin.git"
  "$REAL_GIT" init -q --bare "$T/upstream.git"
  "$REAL_GIT" init -q -b main "$G"
  commit src/base.txt "base" "upstream base" >/dev/null
  for i in 1 2 3 4 5; do printf 'ctx\nline%s\nctx\n' "$i" >>"$G/src/app.txt"; done
  gw add -A && gw commit -q -m "upstream app"
  gw checkout -q -b release/v1.0.0
  commit package.json '{"version":"1.0.0"}' "release: v1.0.0" >/dev/null
  gw tag -a v1.0.0 -m v1.0.0
  gw checkout -q main
  commit src/later.txt "later" "upstream later" >/dev/null
  gw push -q "$T/upstream.git" main release/v1.0.0 v1.0.0
  gw remote add upstream https://github.com/stablyai/orca
  gw remote add origin https://github.com/vbalien/orca
  # 포크 스택 v1.0.0 위
  gw checkout -q -b fork/v1.0.0 v1.0.0
  commit fork/tool.txt "tool1" "fork: tooling" >/dev/null
  PATCH_A=$(commit src/a.txt "a" "feat: patch A")
  commit "$GEN" '{"gen":1}' "fork: regenerate generated files" >/dev/null
  gw tag -a fork-v1.0.0-1 -m r
  REL1=$(gw rev-parse HEAD)
  git -C "$G" push -q origin fork/v1.0.0 fork-v1.0.0-1 "$REL1:refs/heads/main"
  echo fork-v1.0.0-1 >"$T/gh/latest"
  echo published >"$T/gh/state-fork-v1.0.0-1"
  echo v1.1.0 >"$T/gh/up-latest"
  mkdir -p "$G/fork" && cp "$HERE/lib-main-sync.sh" "$HERE/sync-main.sh" "$HERE/publish-release.sh" "$HERE/screen-checks.txt" "$G/fork/" 2>/dev/null
  printf 'fork/lib-main-sync.sh\nfork/sync-main.sh\nfork/publish-release.sh\nfork/screen-checks.txt\n' >>"$G/.git/info/exclude"
}
# v1.1.0: upstream main에서 잘림(+선택: 업스트림이 넣은 커밋). 포크 스택을 그 위로 rebase(운영 편집기로 재생성 drop).
cut_v110() { # [업스트림에 더할 명령]
  gw checkout -q main
  [[ -z "${1:-}" ]] || eval "$1"
  gw checkout -q -b release/v1.1.0
  commit package.json '{"version":"1.1.0"}' "release: v1.1.0" >/dev/null
  gw tag -a v1.1.0 -m v1.1.0
  gw push -q "$T/upstream.git" main release/v1.1.0 v1.1.0
  gw checkout -q -b fork/v1.1.0 fork/v1.0.0
  (MS_REPO=$G; source "$HERE/lib-main-sync.sh"
    GIT_SEQUENCE_EDITOR=$(ms_regen_drop_editor) "$REAL_GIT" -C "$G" -c rebase.instructionFormat=%s \
      rebase -q -i --empty=drop --no-update-refs --onto v1.1.0 v1.0.0 >/dev/null 2>&1) || { echo "rebase 실패"; gw rebase --abort; }
}
release_v110() { # 지금 HEAD에 재생성 커밋을 쌓고 fork-v1.1.0-1로 게시(Latest)
  commit "$GEN" '{"gen":2}' "fork: regenerate generated files" >/dev/null
  gw tag -a fork-v1.1.0-1 -m r
  git -C "$G" push -q origin fork/v1.1.0 fork-v1.1.0-1
  echo fork-v1.1.0-1 >"$T/gh/latest"
  echo published >"$T/gh/state-fork-v1.1.0-1"
}
sync() { (cd "$G" && bash fork/sync-main.sh "$@") >"$T/out" 2>&1; echo $?; }
origin_main() { "$REAL_GIT" --git-dir="$T/origin.git" rev-parse refs/heads/main; }

# ① 같은 릴리즈 안: 태그 뒤 도구 경로만 바뀐 커밋 → main = 브랜치 끝, 기록 attempt+confirmed
world
gw checkout -q fork/v1.0.0
TIP=$(commit fork/tool.txt "tool2" "fork: tool fix")
git -C "$G" push -q origin fork/v1.0.0
expect "① 종료 0" [ "$(sync fork-v1.0.0-1)" = 0 ]
expect "① main = 브랜치 끝" [ "$(origin_main)" = "$TIP" ]
expect "① 기록 attempt·confirmed" grep -q 'result .* confirmed' "$HOME/orca-fork-build/main-history.log"
# ⑯' 태그 뒤 앱 코드를 바꿨다 되돌리고 도구만 남긴 경우도 태그 커밋으로(커밋별 검사)
world
gw checkout -q fork/v1.0.0
commit src/app3.txt "x" "feat: tmp" >/dev/null; gw revert --no-edit HEAD >/dev/null
commit fork/tool.txt "tool3" "fork: tool fix" >/dev/null
git -C "$G" push -q origin fork/v1.0.0
"$REAL_GIT" --git-dir="$T/origin.git" update-ref refs/heads/main "$(gw rev-parse "v1.0.0^{commit}")"
expect "⑯' 종료 0" [ "$(sync fork-v1.0.0-1)" = 0 ]
expect "⑯' main = 태그 커밋" [ "$(origin_main)" = "$REL1" ]
# ⑯ 태그 뒤 앱 코드 변경 → main은 태그 커밋으로
world
gw checkout -q fork/v1.0.0
commit src/app2.txt "x" "feat: unreleased" >/dev/null
git -C "$G" push -q origin fork/v1.0.0
"$REAL_GIT" --git-dir="$T/origin.git" update-ref refs/heads/main "$(gw rev-parse "v1.0.0^{commit}")" # main을 기반으로 돌려 둠
expect "⑯ 종료 0" [ "$(sync fork-v1.0.0-1)" = 0 ]
expect "⑯ main = 태그 커밋" [ "$(origin_main)" = "$REL1" ]
# ② 서로 갈라진 두 업스트림 릴리즈 기반 사이 전환("release: v1.0.0"은 검사 밖) ③ patch-id 같은 이식본 통과
world; cut_v110; release_v110
expect "②③ 종료 0" [ "$(sync fork-v1.1.0-1)" = 0 ]
expect "②③ main = fork-v1.1.0-1" [ "$(origin_main)" = "$(gw rev-parse fork-v1.1.0-1^{commit})" ]
# ⑥ main에만 있는 패치(스택에 없음) → 멈춤, main 그대로
world
gw checkout -q -b m "$REL1"; P=$(commit src/p.txt "p" "feat: main-only P"); git -C "$G" push -q origin "$P:refs/heads/main"
gw checkout -q fork/v1.0.0; cut_v110; release_v110
expect "⑥ 종료 1" [ "$(sync fork-v1.1.0-1)" = 1 ]
expect "⑥ main 그대로" [ "$(origin_main)" = "$P" ]
expect "⑥ 이유" grep -q '대응 커밋이 없다' "$T/out"
# ④ 제목만 같고 내용 다른 이식본 → 멈춤 ⑤ --confirm-ported면 통과
world; cut_v110
gw reset -q --hard v1.1.0
commit fork/tool.txt "tool1" "fork: tooling" >/dev/null
commit src/a.txt "a-different" "feat: patch A" >/dev/null
release_v110
expect "④ 종료 1" [ "$(sync fork-v1.1.0-1)" = 1 ]
expect "④ 안내(range-diff)" grep -q 'range-diff' "$T/out"
expect "⑤ --confirm-ported 종료 0" [ "$(sync fork-v1.1.0-1 --confirm-ported "$PATCH_A")" = 0 ]
expect "⑤ 사람 확인 근거 비교 명령 출력" grep -q "check $PATCH_A git -C .* range-diff $PATCH_A^! " "$T/out"
expect "⑤ 사람 확인 경로별 diff 명령" grep -q "check $PATCH_A GIT_LITERAL_PATHSPECS=1 git -C .* diff $PATCH_A [0-9a-f]* -- src/a.txt\$" "$T/out"
expect "⑤ 기록에 확인 방식·대응 SHA" grep -q "$PATCH_A:사람이-이식-확인:$(gw log --format=%H --grep='^feat: patch A$' -1 fork-v1.1.0-1)" "$HOME/orca-fork-build/main-history.log"
# ⑬ 스택에 같은 이식본 + 그 revert → 멈춤
world; cut_v110
gw revert --no-edit "$(gw log --format=%H --grep="^feat: patch A$" v1.1.0..HEAD | head -n 1)" >/dev/null
release_v110
expect "⑬ 종료 1" [ "$(sync fork-v1.1.0-1)" = 1 ]
expect "⑬ main 그대로" [ "$(origin_main)" = "$REL1" ]
# ⑭ 같은 문맥 두 곳 중 원래 위치만 되돌림 → 자동 통과 안 함
world
gw checkout -q -b m2 "$REL1"
sed -i '2s/line1/LINE-X/' "$G/src/app.txt"; Q=$(gw commit -qam "feat: Q" && gw rev-parse HEAD)
git -C "$G" push -q origin "$Q:refs/heads/main"
gw checkout -q fork/v1.0.0; cut_v110
"$REAL_GIT" -C "$G" cherry-pick "$Q" >/dev/null
sed -i '2s/LINE-X/line1/; 5s/line2/LINE-X/' "$G/src/app.txt"; gw commit -qam "chore: move"
release_v110
expect "⑭ 종료 1" [ "$(sync fork-v1.1.0-1)" = 1 ]
expect "⑭ 내용·효과 차이로 판정" grep -q '내용·효과가 다르다' "$T/out"
# ⑪ 업스트림 흡수(patch-id 같음, 효과 그대로) → 통과
world
cut_v110 "\"$REAL_GIT\" -C \"$G\" cherry-pick $PATCH_A >/dev/null"
release_v110
expect "⑪ 흡수 종료 0" [ "$(sync fork-v1.1.0-1)" = 0 ]
expect "⑪ 업스트림 흡수로 판정" grep -q '업스트림에-같은-패치' "$T/out"
# ⑪' 업스트림에 들어갔다 되돌려졌는데 스택에서 빠짐 → 자동 통과 안 함, --confirm-upstream은 U가 새 기반 조상일 때만
world
cut_v110 "\"$REAL_GIT\" -C \"$G\" cherry-pick $PATCH_A >/dev/null; \"$REAL_GIT\" -C \"$G\" revert --no-edit HEAD >/dev/null"
U=$(gw log --format=%H --grep='^feat: patch A$' v1.0.0..v1.1.0 | head -n 1)
# rebase는 이 경우 A를 다시 적용한다(효과가 남아 통과가 맞다). 판정을 시험하려고 A가 빠진 스택을 직접 만든다.
gw reset -q --hard v1.1.0
commit fork/tool.txt "tool1" "fork: tooling" >/dev/null
release_v110
expect "⑪' 되돌림 종료 1" [ "$(sync fork-v1.1.0-1)" = 1 ]
expect "⑪' 엉뚱한 U(기반 아래)는 거부" [ "$(sync fork-v1.1.0-1 --confirm-upstream "$PATCH_A=$(gw rev-parse v1.0.0^{commit})")" = 1 ]
expect "⑪' 확인한 U면 종료 0" [ "$(sync fork-v1.1.0-1 --confirm-upstream "$PATCH_A=$U")" = 0 ]
# ⑱ 사라질 커밋 목록 조회 실패 → 멈춤(통과로 보지 않음), main 그대로, push 없음
world; cut_v110; release_v110; echo fail >"$T/gh/revlist-mode"
expect "⑱ 조회 실패 종료 1" [ "$(sync fork-v1.1.0-1)" = 1 ]
expect "⑱ main 그대로" [ "$(origin_main)" = "$REL1" ]
expect "⑱ 기록 없음" bash -c "! grep -q attempt '$HOME/orca-fork-build/main-history.log' 2>/dev/null"
rm -f "$T/gh/revlist-mode"
# ⑱' merge 검사 조회 실패 → 멈춤(“merge 없음”으로 보지 않음)
world; cut_v110; release_v110; echo merges >"$T/gh/revlist-mode"
expect "⑱' merge 조회 실패 종료 1" [ "$(sync fork-v1.1.0-1)" = 1 ]
expect "⑱' main 그대로" [ "$(origin_main)" = "$REL1" ]
rm -f "$T/gh/revlist-mode"
# ⑦' 일반 파일을 생성 파일 경로로 옮긴(rename) "재생성" 제목 커밋도 멈춤(지운 원래 경로도 본다)
world
gw checkout -q -b m3r "$REL1"; mkdir -p "$G/src/shared/rpc-contract"
gw mv src/a.txt src/shared/rpc-contract/rpc-params-catalog.generated.ts
gw commit -qm "fork: regenerate generated files"; git -C "$G" push -q origin "HEAD:refs/heads/main"; MM=$(gw rev-parse HEAD)
gw checkout -q fork/v1.0.0; cut_v110; release_v110
expect "⑦' rename 종료 1" [ "$(sync fork-v1.1.0-1)" = 1 ]
expect "⑦' main 그대로" [ "$(origin_main)" = "$MM" ]
# ⑦ 생성 파일 밖도 바꾼 "재생성" 제목 커밋은 멈춤
world
gw checkout -q -b m3 "$REL1"; printf 'z\n' >"$G/src/z.txt"; printf '{"gen":9}\n' >"$G/$GEN"; gw add -A
gw commit -qm "fork: regenerate generated files"; git -C "$G" push -q origin "HEAD:refs/heads/main"; MM=$(gw rev-parse HEAD)
gw checkout -q fork/v1.0.0; cut_v110; release_v110
expect "⑦ 종료 1" [ "$(sync fork-v1.1.0-1)" = 1 ]
expect "⑦ main 그대로" [ "$(origin_main)" = "$MM" ]
# ⑫ main 포크 커밋에 merge → 멈춤
world
gw checkout -q -b m4 "$REL1"; commit src/m1.txt 1 "feat: m1" >/dev/null
gw checkout -q -b m5 "$REL1"; commit src/m2.txt 2 "feat: m2" >/dev/null
gw checkout -q m4; gw merge -q --no-edit m5; git -C "$G" push -q origin "HEAD:refs/heads/main"
gw checkout -q fork/v1.0.0; cut_v110; release_v110
expect "⑫ 종료 1" [ "$(sync fork-v1.1.0-1)" = 1 ]
expect "⑫ 이유 merge" grep -q 'merge' "$T/out"
# ⑰ Latest가 아닌 태그 → 멈춤 ⑧ main이 더 새 기반이면 멈춤
world; cut_v110; release_v110
expect "⑰ Latest 아님 종료 1" [ "$(sync fork-v1.0.0-1)" = 1 ]
sync fork-v1.1.0-1 >/dev/null
echo fork-v1.0.0-1 >"$T/gh/latest"
expect "⑧ 뒤로 가기 종료 1" [ "$(sync fork-v1.0.0-1)" = 1 ]
expect "⑧ main 그대로" [ "$(origin_main)" = "$(gw rev-parse fork-v1.1.0-1^{commit})" ]
# ⑨ 대상에 merge → 멈춤
world
gw checkout -q fork/v1.0.0; gw checkout -q -b side v1.0.0; commit src/s.txt s "feat: s" >/dev/null
gw checkout -q fork/v1.0.0; gw merge -q --no-edit side; gw tag -f -a fork-v1.0.0-2 -m r >/dev/null
git -C "$G" push -q -f origin fork/v1.0.0 fork-v1.0.0-2; echo fork-v1.0.0-2 >"$T/gh/latest"; echo published >"$T/gh/state-fork-v1.0.0-2"
expect "⑨ 종료 1" [ "$(sync fork-v1.0.0-2)" = 1 ]
# ⑩ lease 불일치(그사이 main 변경) → 실패, 우리가 덮지 않음
world; cut_v110; release_v110
echo race >"$T/gh/push-mode"; gw rev-parse v1.0.0^{commit} >"$T/gh/race-sha"
rc=$(sync fork-v1.1.0-1); rm -f "$T/gh/push-mode"
expect "⑩ 제3의 SHA 관측 → 2" [ "$rc" = 2 ]
expect "⑩ 기록 unknown" grep -q 'result .* unknown observed='"$(gw rev-parse v1.0.0^{commit})" "$HOME/orca-fork-build/main-history.log"
expect "⑩ main = 경쟁 커밋" [ "$(origin_main)" = "$(gw rev-parse v1.0.0^{commit})" ]
# 명시적 거부 + 원격 M 그대로 → unchanged 1
world; cut_v110; release_v110
echo reject >"$T/gh/push-mode"
rc=$(sync fork-v1.1.0-1); rm -f "$T/gh/push-mode"
expect "거부·M 그대로 → 1" [ "$rc" = 1 ]
expect "거부 기록 unchanged" grep -q 'result .* unchanged observed='"$REL1" "$HOME/orca-fork-build/main-history.log"
expect "거부 → main 그대로" [ "$(origin_main)" = "$REL1" ]
# push 시간 초과 뒤 M 관측 → unknown 2 / 실패했지만 실제 적용 → 0 / 조회 실패 → 2
world; cut_v110; release_v110
echo timeout >"$T/gh/push-mode"
expect "시간 초과 → 2" [ "$(sync fork-v1.1.0-1)" = 2 ]
expect "시간 초과 기록 unknown" grep -q 'result .* unknown' "$HOME/orca-fork-build/main-history.log"
echo applied-then-fail >"$T/gh/push-mode"
expect "적용 후 실패 → 0" [ "$(sync fork-v1.1.0-1)" = 0 ]
world; cut_v110; release_v110
echo timeout-lsfail >"$T/gh/push-mode"
rc=$(sync fork-v1.1.0-1); rm -f "$T/gh/push-mode" "$T/gh/lsremote-mode"
expect "push 뒤 조회 실패 → 2" [ "$rc" = 2 ]
# ㉒ push.followTags여도 미게시 태그는 안 올라감
world; cut_v110; release_v110
gw config push.followTags true; gw tag -a fork-v9.9.9-1 -m x fork-v1.1.0-1^{commit}
sync fork-v1.1.0-1 >/dev/null
expect "㉒ 태그 안 올라감" [ -z "$("$REAL_GIT" --git-dir="$T/origin.git" tag -l fork-v9.9.9-1)" ]
# 실제 git(가짜 없음): origin이 insteadOf로 다른 곳을 가리키면 네트워크 전에 거부
world
mkdir -p "$T/bin2"; ln -sf "$T/bin/gh" "$T/bin2/gh"
gw config "url.$T/origin.git.insteadOf" https://github.com/vbalien/orca
: >"$T/gh/calls"
rc=$( (cd "$G" && PATH="$T/bin2:${PATH#"$T/bin:"}" bash fork/sync-main.sh fork-v1.0.0-1) >/dev/null 2>&1; echo $?)
expect "주소 재작성 → 거부" [ "$rc" = 1 ]
expect "주소 재작성 → gh·네트워크 전" [ ! -s "$T/gh/calls" ]
# ⑱ 미확정 게시 기록: 초안이면 멈춤, 게시됐으면 지우고 진행
world; cut_v110; release_v110
echo "fork-v1.1.0-1 now" >"$HOME/orca-fork-build/publish-pending"; echo draft >"$T/gh/state-fork-v1.1.0-1"
expect "⑱ 초안 미확정 → 1" [ "$(sync fork-v1.1.0-1)" = 1 ]
echo published >"$T/gh/state-fork-v1.1.0-1"
expect "⑱ 게시됨 → 0" [ "$(sync fork-v1.1.0-1)" = 0 ]
expect "⑱ 기록 지움" [ ! -e "$HOME/orca-fork-build/publish-pending" ]
# ⑲·㉑ 잠금: 다른 프로세스가 잡고 있으면 단독 sync 멈춤, 잠금 없는 fd를 넘겨도 멈춤
world; cut_v110; release_v110
( exec 8>>"$HOME/orca-fork-build/publish.lock"; flock 8; sleep 5 ) &
holder=$!; sleep 0.5
expect "⑲ 잠금 중 → 1" [ "$(sync fork-v1.1.0-1)" = 1 ]
rc=$( (cd "$G" && exec 7>>"$HOME/orca-fork-build/publish.lock" && FORK_PUBLISH_LOCK_FD=7 bash fork/sync-main.sh fork-v1.1.0-1) >/dev/null 2>&1; echo $?)
expect "㉑ 잠금 없는 fd → 1" [ "$rc" = 1 ]
kill "$holder" 2>/dev/null; wait "$holder" 2>/dev/null
expect "⑲ 잠금 풀린 뒤 → 0" [ "$(sync fork-v1.1.0-1)" = 0 ]

# ---- 게시 진입점(publish-release.sh) ----
pub() { (cd "$G" && bash fork/publish-release.sh "$1" --screens-checked) >"$T/out" 2>&1; echo $?; }
pub_world() { # fork-v1.1.0-1 초안 + 검증 기록
  world; cut_v110
  commit "$GEN" '{"gen":2}' "fork: regenerate generated files" >/dev/null
  gw tag -a fork-v1.1.0-1 -m r; git -C "$G" push -q origin fork/v1.1.0 fork-v1.1.0-1
  echo draft >"$T/gh/state-fork-v1.1.0-1"
  gw rev-parse fork-v1.1.0-1^{commit} >"$T/gh/tag-commit"
  printf '{"tagCommit":"%s","release":{"id":1,"assets":[]}}\n' "$(cat "$T/gh/tag-commit")" >"$HOME/orca-fork-build/verified-fork-v1.1.0-1.json"
  : >"$T/gh/calls"
}
pub_world
expect "게시 → 0" [ "$(pub fork-v1.1.0-1)" = 0 ]
expect "게시 → main 맞춤" [ "$(origin_main)" = "$(cat "$T/gh/tag-commit")" ]
expect "게시 → 기록 지움" [ ! -e "$HOME/orca-fork-build/publish-pending" ]
# Latest보다 낮은 기반 / 같은 기반 낮은 N / 잠금 중 → 게시·동기화 없음
pub_world; echo fork-v1.2.0-1 >"$T/gh/latest"
expect "낮은 기반 → 1" [ "$(pub fork-v1.1.0-1)" = 1 ]
expect "낮은 기반 → edit 없음" bash -c "! grep -q 'release edit' '$T/gh/calls'"
pub_world; echo fork-v1.1.0-2 >"$T/gh/latest"
expect "낮은 N → 1" [ "$(pub fork-v1.1.0-1)" = 1 ]
expect "낮은 N → edit 없음" bash -c "! grep -q 'release edit' '$T/gh/calls'"
# Latest 조회 실패 → 게시 없음 / Latest가 아직 없음(404) → 게시
pub_world; echo fail >"$T/gh/latest-mode"
expect "Latest 조회 실패 → 1" [ "$(pub fork-v1.1.0-1)" = 1 ]
expect "Latest 조회 실패 → edit 없음" bash -c "! grep -q 'release edit' '$T/gh/calls'"
pub_world; rm -f "$T/gh/latest" "$T/gh/latest-mode"
expect "첫 게시(404) → 0" [ "$(pub fork-v1.1.0-1)" = 0 ]
pub_world
( exec 8>>"$HOME/orca-fork-build/publish.lock"; flock 8; sleep 5 ) &
holder=$!; sleep 0.5
expect "잠금 중 → 1" [ "$(pub fork-v1.1.0-1)" = 1 ]
expect "잠금 중 → edit 없음" bash -c "! grep -q 'release edit' '$T/gh/calls'"
kill "$holder" 2>/dev/null; wait "$holder" 2>/dev/null
# 게시 명령 실패지만 실제 게시됨 → 동기화 진행 / 초안 그대로 → 2, 기록 남음, 동기화 없음
pub_world; echo fail-published >"$T/gh/edit-mode"
expect "실패·실제 게시 → 0" [ "$(pub fork-v1.1.0-1)" = 0 ]
pub_world; echo fail-draft >"$T/gh/edit-mode"; M0=$(origin_main)
expect "실패·초안 → 2" [ "$(pub fork-v1.1.0-1)" = 2 ]
expect "실패·초안 → 기록 남음" [ -e "$HOME/orca-fork-build/publish-pending" ]
expect "실패·초안 → main 그대로" [ "$(origin_main)" = "$M0" ]
expect "기록이 남으면 다음 게시 멈춤" [ "$(pub fork-v1.1.0-1)" = 1 ]
# 게시 요청 중 게시 스크립트가 죽음 → 기록 남음·동기화 없음; 다음 sync는 그 태그부터(초안이면 멈춤, 게시되면 진행)
pub_world; echo kill >"$T/gh/edit-mode"; M1=$(origin_main)
{ pub fork-v1.1.0-1 >/dev/null; } 2>/dev/null; rm -f "$T/gh/edit-mode"
expect "요청 중 죽음 → 기록 남음" grep -q '^fork-v1.1.0-1 ' "$HOME/orca-fork-build/publish-pending"
expect "요청 중 죽음 → main 그대로" [ "$(origin_main)" = "$M1" ]
expect "요청 중 죽음 → 다음 게시 멈춤" [ "$(pub fork-v1.1.0-1)" = 1 ]
echo fork-v1.1.0-1 >"$T/gh/latest"
expect "요청 중 죽음 → 다음 sync(초안) 멈춤" [ "$(sync fork-v1.1.0-1)" = 1 ]
echo published >"$T/gh/state-fork-v1.1.0-1"
expect "요청 중 죽음 → 게시 확인 뒤 sync 0" [ "$(sync fork-v1.1.0-1)" = 0 ]
# 게시 뒤 상태 조회 실패 → 2, 기록 남음, 동기화 없음
pub_world; echo ok-viewfail >"$T/gh/edit-mode"; M2=$(origin_main)
expect "게시 뒤 조회 실패 → 2" [ "$(pub fork-v1.1.0-1)" = 2 ]
rm -f "$T/gh/edit-mode" "$T/gh/view-mode"
expect "게시 뒤 조회 실패 → 기록 남음" [ -e "$HOME/orca-fork-build/publish-pending" ]
expect "게시 뒤 조회 실패 → main 그대로" [ "$(origin_main)" = "$M2" ]
# ⑳ 기록을 쓴 뒤 요청 전에 끊긴 경우와 같다(기록만 남음) → 다음 게시·sync가 그 태그부터
pub_world; echo "fork-v1.1.0-1 now" >"$HOME/orca-fork-build/publish-pending"
expect "⑳ 남은 기록·초안 → 게시 멈춤" [ "$(pub fork-v1.1.0-1)" = 1 ]
# 동기화 종료 2를 게시 스크립트가 그대로 전달
pub_world; rm -f "$T/gh/edit-mode"; echo timeout >"$T/gh/push-mode"
expect "동기화 미확정 → 게시 2" [ "$(pub fork-v1.1.0-1)" = 2 ]
expect "동기화 미확정 안내" grep -q 'main 갱신 결과는 미확정' "$T/out"
rm -f "$T/gh/push-mode"

# ---- 재이식 판정(lib) ----
world
(
  MS_REPO=$G
  source "$HERE/lib-main-sync.sh"
  # 기본 출발점: 최신 게시 태그 커밋이 origin/main의 조상
  "$REAL_GIT" -C "$G" fetch -q "$T/origin.git" "+refs/heads/main:refs/remotes/origin/main"
  ms_start_ok "$("$REAL_GIT" -C "$G" rev-parse fork-v1.0.0-1^{commit})" refs/remotes/origin/main && echo start-ok
  ms_start_ok "$("$REAL_GIT" -C "$G" rev-parse v1.0.0^{commit})" "$("$REAL_GIT" -C "$G" rev-parse release/v1.0.0~1)" || echo start-refused
  ms_ff_ok "" HEAD && echo ff-new
  ms_ff_ok "$("$REAL_GIT" -C "$G" rev-parse v1.0.0^{commit})" HEAD && echo ff-ok
  ms_ff_ok "$("$REAL_GIT" -C "$G" rev-parse main)" HEAD || echo ff-refused
) >"$T/lib.out" 2>&1
for w in start-ok start-refused ff-new ff-ok ff-refused; do expect "lib $w" grep -qx "$w" "$T/lib.out"; done
# ㉓ 좁은 fetch 설정(fork/v*만)에서도 명시 refspec으로 main을 가져오고, main 전용 squash 패치가 새 기반으로 옮겨진다
world
gw checkout -q -b m6 "$REL1"; P=$(commit src/p.txt "p" "feat: merged PR P"); git -C "$G" push -q origin "$P:refs/heads/main"
gw config remote.origin.fetch '+refs/heads/fork/*:refs/remotes/origin/fork/*'
git -C "$G" fetch -q origin "+refs/heads/main:refs/remotes/origin/main"
gw checkout -q main; cut_v110 >/dev/null 2>&1; gw checkout -q -b fork/v1.1.0b refs/remotes/origin/main
(MS_REPO=$G; source "$HERE/lib-main-sync.sh"
  GIT_SEQUENCE_EDITOR=$(ms_regen_drop_editor) "$REAL_GIT" -C "$G" -c rebase.instructionFormat=%s \
    rebase -q -i --empty=drop --no-update-refs --onto v1.1.0 v1.0.0 >/dev/null 2>&1)
expect "㉓ main 전용 패치 유지" bash -c "'$REAL_GIT' -C '$G' log --format=%s v1.1.0..HEAD | grep -qx 'feat: merged PR P'"
expect "㉓ 중간 재생성 커밋 drop" bash -c "! '$REAL_GIT' -C '$G' log --format=%s v1.1.0..HEAD | grep -qx 'fork: regenerate generated files'"
# 효과 확인: 개행·pathspec 문자가 든 파일명도 한 경로로 본다
world
(
  MS_REPO=$G
  source "$HERE/lib-main-sync.sh"
  gw checkout -q -b nl v1.0.0
  C=$(commit $'src/a\nb.txt' x "feat: nl") # 이 커밋은 개행 든 파일 하나만 바꾼다
  gw checkout -q -b nl-rev v1.0.0; gw cherry-pick "$C" >/dev/null; gw revert --no-edit HEAD >/dev/null
  ms_effect_kept "$C" "$(gw rev-parse HEAD)" || echo nl-revert-refused
  gw checkout -q -b nl-keep v1.0.0; gw cherry-pick "$C" >/dev/null
  ms_effect_kept "$C" "$(gw rev-parse HEAD)" && echo nl-kept
  gw checkout -q -b star v1.0.0; CS=$(commit 'src/*' y "feat: star") # pathspec 문자가 든 파일명
  gw checkout -q -b star-chg v1.0.0; gw cherry-pick "$CS" >/dev/null; commit src/zz.txt q "feat: other" >/dev/null
  ms_effect_kept "$CS" "$(gw rev-parse HEAD)" && echo star-kept
  printf 'z\n' >"$G/src/*"; gw commit -qam star2
  ms_effect_kept "$CS" "$(gw rev-parse HEAD)" || echo star-changed-refused
  # 사람 확인 명령의 경로 인용: 공백·개행·glob 문자 파일명이 셸에서 그대로 한 인자씩
  gw checkout -q -b q v1.0.0
  printf 1 >"$G/src/a b.txt"; printf 2 >"$G/src/n"$'\n'"l"; printf 3 >"$G/src/*"; gw add -A; gw commit -qm q
  eval "set --$(ms_paths_q "$(gw rev-parse HEAD)")"
  [[ $# == 3 && " $1|$2|$3 " == *"src/*"* && "$*" == *"src/a b.txt"* && "$*" == *"src/n"$'\n'"l"* ]] && echo paths-quoted
  ms_tag_older fork-v1.1.0-08 fork-v1.1.0-9 && echo older-08
  ms_tag_older fork-v1.1.0-10 fork-v1.1.0-9 || echo newer-10
  # 원격 확인: 세 질의를 따로 본다(origin URL이 여러 개여도 upstream 조회 실패를 가리지 않음)
  ms_git() {
    case "$*" in
      "remote get-url --all origin") printf '%s\n' https://github.com/vbalien/orca https://github.com/vbalien/orca ;;
      "remote get-url --push --all origin") echo https://github.com/vbalien/orca ;;
      "remote get-url --all upstream") [[ -n "${UP:-}" ]] && echo "$UP" || return 2 ;;
    esac
  }
  ms_check_remotes vbalien/orca stablyai/orca 2>/dev/null || echo remotes-upfail
  UP=https://github.com/stablyai/orca ms_check_remotes vbalien/orca stablyai/orca && echo remotes-ok
) >"$T/lib3.out" 2>&1
for w in paths-quoted nl-revert-refused nl-kept star-kept star-changed-refused older-08 newer-10 remotes-upfail remotes-ok; do expect "lib $w" grep -qx "$w" "$T/lib3.out"; done

# 원격 릴리즈 브랜치 보호(재이식 스크립트가 쓰는 lib 함수, 로컬 bare origin)
world
gw config remote.origin.fetch '+refs/heads/main:refs/remotes/origin/main' # 좁은 fetch 설정
(
  MS_REPO=$G
  source "$HERE/lib-main-sync.sh"
  ob() { "$REAL_GIT" --git-dir="$T/origin.git" rev-parse "refs/heads/$1" 2>/dev/null; }
  r=$(ms_remote_branch fork/v1.0.0) && [[ "$r" == "$REL1" && "$(gw rev-parse refs/remotes/origin/fork/v1.0.0)" == "$REL1" ]] && echo rb-found
  r=$(ms_remote_branch fork/v9.9.9) && [[ -z "$r" ]] && echo rb-none
  ms_reorder_allowed "$REL1" || echo reorder-refused
  ms_reorder_allowed "" && echo reorder-new
  ms_may_amend "$REL1" "$REL1" fork/v1.0.0 || echo amend-pushed-refused
  gw checkout -q fork/v1.0.0
  X=$(commit "$GEN" '{"gen":5}' "fork: regenerate generated files")
  ms_may_amend "$REL1" "$X" fork/v1.0.0 && echo amend-local-ok
  ms_push_release_branch "$REL1" "$X" fork/v1.0.0 2>/dev/null && [[ "$(ob fork/v1.0.0)" == "$X" ]] && echo push-ff
  Y=$(commit src/y.txt y "feat: y")
  rc=0; ms_push_release_branch "$REL1" "$Y" fork/v1.0.0 2>/dev/null || rc=$?
  [[ $rc == 1 && "$(ob fork/v1.0.0)" == "$X" ]] && echo push-race-refused
  gw checkout -q -b other "$REL1"; Z=$(commit src/z.txt z "feat: z")
  rc=0; ms_push_release_branch "$X" "$Z" fork/v1.0.0 2>/dev/null || rc=$?
  [[ $rc == 3 && "$(ob fork/v1.0.0)" == "$X" ]] && echo push-nonff-refused
  ms_push_release_branch "" "$Z" fork/v2.0.0 2>/dev/null && [[ "$(ob fork/v2.0.0)" == "$Z" ]] && echo push-new
  rc=0; ms_push_release_branch "" "$Y" fork/v2.0.0 2>/dev/null || rc=$?
  [[ $rc == 1 && "$(ob fork/v2.0.0)" == "$Z" ]] && echo push-new-exists-refused
) >"$T/lib4.out" 2>&1
for w in rb-found rb-none reorder-refused reorder-new amend-pushed-refused amend-local-ok push-ff push-race-refused push-nonff-refused push-new push-new-exists-refused; do
  expect "lib $w" grep -qx "$w" "$T/lib4.out"
done

echo "통과 $pass, 실패 $fail"
[[ $fail == 0 ]]
