# shellcheck shell=bash
# 포크 main 동기화·게시·재이식 스크립트가 같이 쓰는 판정 함수(source해서 쓴다). gh는 부르는 쪽이 쓰고,
# 네트워크를 쓰는 것은 아래 "원격 릴리즈 브랜치" 함수(origin, timeout)뿐이다. MS_REPO(저장소 경로)를 먼저 정한다.
# 시험: fork/test-main-sync.sh.

MS_REGEN_SUBJECT='fork: regenerate generated files'
MS_GENERATED=(
  src/renderer/src/i18n/en-runtime-required.json
  src/shared/rpc-contract/rpc-params-catalog.generated.ts
  src/shared/plugins/languages/protected-copy-keys.json
)
# 게시된 태그 뒤에 main으로 따라가도 되는 커밋이 바꿀 수 있는 경로(도구·문서·포크 워크플로만).
MS_TOOLING_RE='^(fork/.*|\.github/workflows/fork-release\.yml)$'

ms_git() { git -C "$MS_REPO" "$@"; }
ms_die() {
  printf '오류: %s\n' "$*" >&2
  return 1
}

# https·ssh 둘 다 받는다. $1: URL, $2: owner/repo
ms_is_github_repo() { [[ "$1" =~ ^(https://github\.com/|git@github\.com:|ssh://git@github\.com/)$2(\.git)?/?$ ]]; }

# 실제 통신 대상(insteadOf·pushInsteadOf를 펼친 값)으로 원격을 확인한다. 모든 fetch·push URL이 맞아야 한다.
# 세 질의(origin fetch·origin push·upstream)를 따로 받아, 각각 조회 성공·비어 있지 않음·모든 줄 일치여야 한다.
ms_check_remotes() { # <포크 owner/repo> <업스트림 owner/repo>
  local what name want args urls url
  for what in "origin fetch:$1:--all origin" "origin push:$1:--push --all origin" "upstream:$2:--all upstream"; do
    IFS=: read -r name want args <<<"$what"
    # shellcheck disable=SC2086 # args는 위에서 정한 고정 단어들
    urls=$(ms_git remote get-url $args) || ms_die "$name 주소를 읽지 못했다" || return 1
    [[ -n "$urls" ]] || ms_die "$name 주소가 없다" || return 1
    while IFS= read -r url; do
      ms_is_github_repo "$url" "$want" || ms_die "$name 주소가 github.com/$want가 아니다: $url" || return 1
    done <<<"$urls"
  done
}

# fork-vX.Y.Z-N 비교: $1이 $2보다 오래되면 참(버전 sort -V, 같으면 번호).
ms_tag_older() { # <태그1> <태그2>
  local a=${1#fork-v} b=${2#fork-v}
  local av=${a%-*} an=${a##*-} bv=${b%-*} bn=${b##*-}
  if [[ "$av" != "$bv" ]]; then
    [[ "$(printf '%s\n' "$av" "$bv" | sort -V | head -n 1)" == "$av" ]]
  else
    ((10#$an < 10#$bn)) # 앞자리 0(예: 08)을 8진수로 읽지 않는다
  fi
}

# 재생성 커밋인가: merge가 아니고, 제목이 재생성 제목이고, 부모와의 차이가 생성 파일 3개 안이다.
ms_is_regen() { # <sha>
  [[ "$(ms_git log -1 --format=%s "$1")" == "$MS_REGEN_SUBJECT" ]] || return 1
  [[ "$(ms_git rev-list --no-walk --count --min-parents=2 "$1")" == 0 ]] || return 1
  local files
  # --no-renames: 이름 바꾸기의 원래 경로(지운 쪽)도 목록에 넣는다.
  files=$(ms_git diff --name-only --no-renames "$1^" "$1") || return 1
  [[ -n "$files" ]] || return 1
  ! grep -qvxF -f <(printf '%s\n' "${MS_GENERATED[@]}") <<<"$files"
}

# rebase 할 일 목록에서 재생성 커밋을 모두 drop으로 바꾸는 편집기(GIT_SEQUENCE_EDITOR 값).
# 새 git은 "pick <해시> # <제목>"으로 쓰고, 옛 git은 "# " 없이 쓴다.
ms_regen_drop_editor() {
  printf "%s" "sed -i 's/^pick \\([0-9a-f]*\\) \\(# \\)\\{0,1\\}${MS_REGEN_SUBJECT}\$/drop \\1 \\2${MS_REGEN_SUBJECT}/'"
}

# 커밋 C가 바꾼 모든 경로에서 T의 항목(블롭·모드, 지운 것은 없음)이 C의 것과 같은가.
# 경로는 끝까지 NUL 구분으로 다룬다(개행이 든 파일명도 한 경로). 경로는 글자 그대로(pathspec 해석 없이) 찾는다.
# 조회가 실패하면 "남아 있지 않음"(1)으로 본다(통과시키지 않는다).
ms_effect_kept() { # <C> <T>
  local c=$1 t=$2 path a b list n=0 rc=0
  list=$(mktemp) || return 1
  ms_git diff -z --name-only --no-renames "$c^" "$c" >"$list" || { rm -f "$list"; return 1; }
  while IFS= read -r -d '' path; do
    n=$((n + 1))
    a=$(GIT_LITERAL_PATHSPECS=1 ms_git ls-tree --format='%(objectmode) %(objectname)' "$c" -- "$path") || { rc=1; break; }
    b=$(GIT_LITERAL_PATHSPECS=1 ms_git ls-tree --format='%(objectmode) %(objectname)' "$t" -- "$path") || { rc=1; break; }
    [[ "$a" == "$b" ]] || { rc=1; break; }
  done <"$list"
  rm -f "$list"
  ((rc == 0 && n > 0))
}

# 게시된 태그 커밋 뒤 브랜치 끝까지가 도구 경로만 바꾸는 비 merge 커밋이면 그 끝, 아니면 태그 커밋.
# 출력: "<대상 SHA> <tip|tag> <이유>"
ms_pick_target() { # <태그 커밋> <브랜치 끝>
  local tag=$1 tip=$2 files
  if [[ "$tag" == "$tip" ]]; then echo "$tag tag 브랜치 끝이 태그와 같다"; return; fi
  ms_git merge-base --is-ancestor "$tag" "$tip" || { echo "$tag tag 브랜치 끝이 태그 커밋의 자손이 아니다"; return; }
  local merges
  merges=$(ms_git rev-list --merges "$tag..$tip") || { echo "$tag tag 태그 뒤 merge 여부를 읽지 못했다"; return; }
  if [[ -n "$merges" ]]; then
    echo "$tag tag 태그 뒤에 merge 커밋이 있다"
    return
  fi
  # 커밋마다(부모 대비) 본다: 중간에 앱 코드를 바꿨다 되돌린 경우도 막는다.
  local c list
  list=$(ms_git rev-list "$tag..$tip") || { echo "$tag tag 태그 뒤 커밋을 읽지 못했다"; return; }
  for c in $list; do
    files=$(ms_git diff --name-only --no-renames "$c^" "$c") || { echo "$tag tag 커밋 ${c:0:10}을 읽지 못했다"; return; }
    if [[ -z "$files" ]] || grep -qvE "$MS_TOOLING_RE" <<<"$files"; then
      echo "$tag tag 태그 뒤 커밋(${c:0:10})이 도구 경로 밖도 바꾼다(main에 넣지 않음)"
      return
    fi
  done
  echo "$tip tip 태그 뒤 커밋이 모두 도구 경로만 바꾼다"
}

# 사람이 셸에 그대로 붙여 넣을 수 있게 인용한, C가 바꾼 경로들(앞에 공백). 조회 실패면 빈 값(경로 제한 없음).
ms_paths_q() { # <C>
  local p out='' list
  list=$(mktemp) || return 0
  if ms_git diff -z --name-only --no-renames "$1^" "$1" >"$list"; then
    while IFS= read -r -d '' p; do out+=" $(printf '%q' "$p")"; done <"$list"
  fi
  rm -f "$list"
  printf '%s' "$out"
}

# main M을 T로 옮길 때 사라질 수 있는 포크 커밋 판정. B = M의 기반 태그, base = T의 기반 태그.
# 확인 목록: MS_CONFIRM_PORTED(공백 구분 SHA), MS_CONFIRM_UPSTREAM("C=U" 공백 구분).
# 출력: 줄마다 "ok <C> <방법> <대응 SHA 또는 ->", "need <C> <이유>", 또는 사람 확인 근거를 다시 보는 명령
# "check <C> <명령>". 합격 = need가 없고 종료 0.
# 커밋 목록을 읽지 못하면 종료 1(통과로 보지 않는다).
ms_classify_main() { # <M> <T> <B> <base>
  local m=$1 t=$2 b=$3 base=$4 c line sha subj cand up ok pid
  local -A stack_pid=() stack_subj=() up_pid=()
  local commits
  commits=$(ms_git rev-list --reverse "$b..$m" --not "$t") || { ms_die "사라질 커밋 목록($b..$m)을 읽지 못했다"; return 1; }
  [[ -n "$commits" ]] || return 0 # 사라질 커밋이 없으면 patch-id 표도 만들지 않는다
  # 대상 스택(base..T)의 patch-id와 제목
  while read -r pid sha; do [[ -n "$pid" ]] && stack_pid[$pid]=$sha; done < <(
    ms_git log --format=%H --no-merges "$base..$t" | while read -r s; do ms_git show "$s" | ms_git patch-id --stable; done)
  while IFS=$'\t' read -r sha subj; do [[ -n "$sha" ]] && stack_subj[$subj]+="$sha "; done < <(
    ms_git log --format='%H%x09%s' --no-merges "$base..$t")
  # 새 기반에 새로 들어온 업스트림 커밋(B..base)의 patch-id
  while read -r pid sha; do [[ -n "$pid" ]] && up_pid[$pid]=$sha; done < <(
    ms_git log --format=%H --no-merges "$b..$base" | while read -r s; do ms_git show "$s" | ms_git patch-id --stable; done)
  for c in $commits; do
    subj=$(ms_git log -1 --format=%s "$c")
    if [[ "$(ms_git rev-list --no-walk --count --min-parents=2 "$c")" != 0 ]]; then
      echo "need $c merge 커밋"
      continue
    fi
    if ms_is_regen "$c"; then echo "ok $c 재생성 -"; continue; fi
    line=$(ms_git show "$c" | ms_git patch-id --stable)
    pid=${line%% *}
    ok=''
    if [[ -n "$pid" && -n "${stack_pid[$pid]:-}" ]] && ms_effect_kept "$c" "$t"; then
      ok="스택에-같은-패치 ${stack_pid[$pid]}"
    elif [[ -n "$pid" && -n "${up_pid[$pid]:-}" ]] && ms_effect_kept "$c" "$t"; then
      ok="업스트림에-같은-패치 ${up_pid[$pid]}"
    elif [[ " ${MS_CONFIRM_PORTED:-} " == *" $c "* ]] && [[ -n "${stack_subj[$subj]:-}" ]]; then
      ok="사람이-이식-확인 ${stack_subj[$subj]%% *}"
    else
      for up in ${MS_CONFIRM_UPSTREAM:-}; do
        [[ "${up%%=*}" == "$c" ]] || continue
        cand=${up#*=}
        if ms_git merge-base --is-ancestor "$cand" "$base" 2>/dev/null &&
          ! ms_git merge-base --is-ancestor "$cand" "$b" 2>/dev/null; then
          ok="사람이-업스트림-흡수-확인 $cand"
        fi
      done
    fi
    # 사람이 볼 비교: 대응 커밋과의 range-diff, C가 바꾼 경로에서 C와 새 대상의 차이.
    local rq diff_cmd
    rq=$(printf '%q' "$MS_REPO")
    diff_cmd="GIT_LITERAL_PATHSPECS=1 git -C $rq diff $c $t --$(ms_paths_q "$c")"
    if [[ -n "$ok" ]]; then
      echo "ok $c $ok"
      if [[ "$ok" == 사람이-* ]]; then
        cand=${ok##* }
        echo "check $c git -C $rq range-diff $c^! $cand^!"
        echo "check $c $diff_cmd"
      fi
    elif [[ -n "${stack_subj[$subj]:-}" ]]; then
      cand=${stack_subj[$subj]%% *}
      echo "need $c 같은 제목의 대응 ${cand:0:10}이 있지만 내용·효과가 다르다 — git -C $rq range-diff $c^! $cand^! 와 $diff_cmd 로 확인한 뒤 --confirm-ported $c"
    else
      echo "need $c 새 릴리즈 스택에 대응 커밋이 없다($subj) — 업스트림에 흡수됐다면 대응 커밋 U를 GIT_LITERAL_PATHSPECS=1 git -C $rq log --oneline $b..$base --$(ms_paths_q "$c") 로 찾아 git -C $rq range-diff $c^! U^! 와 $diff_cmd 로 확인한 뒤 --confirm-upstream $c=<U 전체 SHA>; 아니면 다음 릴리즈에 넣는다"
    fi
  done
}

# 게시된 최신 포크 릴리즈 태그 커밋이 <출발 후보>의 조상인가(rebase 기본 출발점).
ms_start_ok() { # <최신 게시 태그 커밋> <origin/main>
  ms_git merge-base --is-ancestor "$1" "$2"
}

# 원격 끝이 HEAD의 조상인가(릴리즈 브랜치 push는 fast-forward만).
ms_ff_ok() { # <원격 SHA(없으면 빈 값)> <HEAD>
  [[ -z "$1" ]] || ms_git merge-base --is-ancestor "$1" "$2"
}

# ---- 원격 릴리즈 브랜치(재이식 스크립트): 이미 올라간 브랜치는 덮어쓰지 않는다 ----
ms_net_git() { timeout -k 10 300 git -C "$MS_REPO" "$@"; }
# 원격 끝 SHA(없으면 빈 줄). 추적 ref 설정과 무관하게 원격에 직접 묻고, 있으면 refs/remotes/origin/<브랜치>로 가져온다.
ms_remote_branch() { # <브랜치>
  local out sha
  out=$(ms_net_git ls-remote origin "refs/heads/$1") || return 1
  sha=$(cut -f1 <<<"$out")
  if [[ -n "$sha" ]]; then
    ms_net_git fetch --quiet --no-tags origin "+refs/heads/$1:refs/remotes/origin/$1" || return 1
  fi
  echo "$sha"
}
# 원격에 올라간 브랜치는 재생성 커밋 재정렬(rebase)을 하지 않는다.
ms_reorder_allowed() { [[ -z "$1" ]]; } # <원격 끝|빈 값>
# 맨 위 재생성 커밋을 amend해도 되는가: 제목이 재생성 제목이고, 그 커밋이 아직 원격 브랜치에 없을 때만.
ms_may_amend() { # <원격 끝|빈 값> <HEAD SHA> <브랜치>
  [[ "$(ms_git log -1 --format=%s "$2")" == "$MS_REGEN_SUBJECT" ]] || return 1
  [[ -z "$1" ]] || ! ms_git merge-base --is-ancestor "$2" "refs/remotes/origin/$3"
}
# 릴리즈 브랜치 push: 없던 브랜치면 "없음" lease로 만들고, 있던 브랜치면 fast-forward일 때만 그 끝 lease로 올린다.
# 종료: 0 올림(또는 이미 같음), 3 fast-forward 아님(push 안 함), 1 push 거부·실패.
ms_push_release_branch() { # <시작 때 원격 끝|빈 값> <HEAD SHA> <브랜치>
  local remote=$1 head=$2 branch=$3
  [[ "$remote" != "$head" ]] || return 0
  ms_ff_ok "$remote" "$head" || return 3
  ms_net_git push --no-follow-tags --force-with-lease="refs/heads/$branch:$remote" origin "$head:refs/heads/$branch" || return 1
}

# ---- 게시 잠금·미확정 게시 기록 (~/orca-fork-build) ----
MS_STATE_DIR=${MS_STATE_DIR:-$HOME/orca-fork-build}
ms_lock() { # 잠금을 잡는다. 게시 스크립트가 넘긴 fd(FORK_PUBLISH_LOCK_FD)가 있으면 그것에 다시 flock -n.
  local fd=${FORK_PUBLISH_LOCK_FD:-} want
  mkdir -p "$MS_STATE_DIR"
  want=$(realpath -m "$MS_STATE_DIR/publish.lock")
  if [[ "$fd" =~ ^[0-9]+$ ]] && [[ "$(readlink "/proc/$$/fd/$fd" 2>/dev/null)" == "$want" ]]; then
    flock -n "$fd" || ms_die "게시·동기화가 이미 돌고 있다(잠금 $want)" || return 1
    return 0
  fi
  exec {MS_LOCK_FD}>>"$want"
  flock -n "$MS_LOCK_FD" || ms_die "게시·동기화가 이미 돌고 있다(잠금 $want)" || return 1
  export FORK_PUBLISH_LOCK_FD=$MS_LOCK_FD
}
ms_pending_file() { echo "$MS_STATE_DIR/publish-pending"; }
ms_pending_set() { # <태그>
  local f tmp
  f=$(ms_pending_file)
  tmp=$(mktemp "$f.XXXX") || return 1
  printf '%s %s\n' "$1" "$(date -u +%FT%TZ)" >"$tmp" && mv -f "$tmp" "$f"
}
ms_pending_clear() { rm -f "$(ms_pending_file)"; }
# 남은 미확정 게시가 있으면 그 상태를 본다. $1: 상태 조회 함수(태그 → published|draft|error 출력).
# 반환: 0 기록 없음, 3 게시 확인돼 기록 지움(그 태그 sync부터), 1 아직 초안·조회 실패(멈춤).
ms_pending_check() { # <조회 함수>
  local f tag state
  f=$(ms_pending_file)
  [[ -f "$f" ]] || return 0
  read -r tag _ <"$f" || true
  state=$("$1" "$tag" 2>/dev/null || echo error)
  if [[ "$state" == published ]]; then
    ms_pending_clear
    echo "미확정이던 게시 $tag는 게시됐다(기록을 지움). main 동기화부터: fork/sync-main.sh $tag" >&2
    return 3
  fi
  echo "미확정 게시 $tag가 남아 있다(상태: $state). 게시 여부를 확인한 뒤 $f를 지우고 다시." >&2
  return 1
}
