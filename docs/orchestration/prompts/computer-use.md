# 컴퓨터 조작 (ao-computer)

Sinawi를 통해 macOS 화면을 스크린샷으로 보고, 네이티브 앱을 마우스·키보드·접근성(AX) 트리로 조작한다. 사용자는 화면 위쪽의 "Sinawi가 컴퓨터를 조작 중" 표시와 앱 헤더의 표시로 이를 본다.

코드: `server/computer-bridge.ts`(`CLI_SOURCE`, `parseComputerArgv`, 정책·큐·로그), `server/computer-tokens.ts`(실행별 토큰, 공용 폴더), `src/computer-use.ts`·`src/ComputerUse.tsx`(앱 쪽 중계, 표시), `src-tauri/src/computer/`(네이티브 실행과 **네이티브 허용 창**).

## 언제 쓰나

1. **웹 페이지·localhost 개발 서버는 `ao-browser`** (orchestra-browser). 더 빠르고 DOM을 안다.
2. 파일·셸·CLI·API로 되는 일은 그쪽으로.
3. 그래도 안 되는 **네이티브 앱**(TextEdit, Finder, 시스템 설정, 계산기, 서드파티 앱)만 `ao-computer`.

## 먼저 알아 둘 것

- 작업 공간 설정 **컴퓨터 조작 허용**이 꺼져 있으면 모든 명령이 거부된다(기본값: 꺼짐). `ao-computer status`의 `allowed`로 확인한다. 꺼져 있으면 사용자에게 켜 달라고 하고 멈춘다.
- `ao-computer`는 **Sinawi가 실행한 에이전트 세션 안에서만** 동작한다. 실행마다 받는 `SINAWI_COMPUTER_TOKEN`으로 누가 요청했는지 정해진다(세션 id는 표시용일 뿐 인증에 쓰지 않는다). 토큰이 없거나 실행이 끝났으면 거부된다.
- 세션의 첫 명령 때 Sinawi가 **macOS 확인 창**("‹에이전트›이(가) 컴퓨터를 조작하려고 합니다", 작업 공간·세션·첫 동작 표시)을 띄운다. 사용자가 **거부(Esc) / 이번만 / 이 세션 동안**을 클릭으로 고른다. Return으로는 결정되지 않는다. 최대 2분 기다린다. "이번만"은 그 명령 하나만 허용한다. 거부하면 10분 동안 다시 묻지 않는다.
- 화면 기록·손쉬운 사용 권한이 없으면 오류에 정확한 시스템 설정 주소가 나온다. 사용자에게 그대로 전하고 멈춘다.
- 사용자가 **Esc를 0.7초 이상 누르거나 ⌃⌥⌘.**(또는 앱의 중지 버튼)을 누르면 모든 허용이 취소되고 대기 중 명령이 실패한다. 1분 동안 새 명령도 거부된다. 이 오류가 나오면 즉시 멈추고 보고한다.

## 흐름: 본다 → 한다 → 다시 본다

```sh
ao-computer status                       # 권한, 허용, 화면 목록
ao-computer activate TextEdit            # 대상 앱을 앞으로 (없으면 실행)
ao-computer screenshot --app TextEdit    # 그 앱 창만. JSON의 path PNG를 읽는다
ao-computer ax TextEdit                  # [a7] AXTextArea … 같은 ref 목록
ao-computer ax_set_value a7 "안녕하세요"   # 입력칸 값 바꾸기 (가능하면 이게 가장 정확)
ao-computer ax_click a12                 # 버튼 누르기 (AXPress, 안 되면 요소 가운데 클릭)
ao-computer key cmd+s                    # 단축키
ao-computer screenshot --app TextEdit    # 결과 확인
```

- **ax ref가 좌표보다 우선이다.** ref는 `ax`를 다시 실행하면 바뀐다. 화면이 바뀌었으면 다시 `ax`.
- ref로 안 되는 곳(그림, 캔버스, 커스텀 컨트롤)만 좌표 클릭.
- 매 동작 뒤 `screenshot`이나 `ax`로 결과를 확인하고 나서 다음 동작을 한다.
- **같은 실패가 3번이면 멈추고 막힘으로 보고한다.** 좌표를 조금씩 바꿔 가며 계속 누르지 않는다.

## 좌표계

- 모든 입력 좌표는 **전역 화면 포인트**다. 주 화면 왼쪽 위가 (0, 0), y는 아래로 커진다. 보조 화면은 배치에 따라 음수 좌표일 수 있다. Retina 픽셀이 아니다.
- `screenshot` 결과:
  - `rect`: 찍은 영역(포인트). 창/앱 캡처면 그 창의 위치·크기.
  - `width`, `height`: PNG 픽셀 크기. 기본은 1픽셀 = 1포인트. `--retina`면 화면 배율(보통 2배), `--max N`이면 긴 변이 N 이하로 줄어든다.
  - `scale`: 이미지 픽셀 ÷ 포인트.
  - `displays`: 화면 목록(`index`, `bounds`, `scale`). `--display N`으로 고른다.
- 이미지 픽셀 (px, py) → 클릭 포인트 = (`rect.x + px / scale`, `rect.y + py / scale`).
- `--pixels`를 붙이면 이 계산을 서버가 한다: 이 세션에서 마지막으로 찍은 screenshot 기준.

## 명령

```text
status                         권한·허용 상태, 화면 목록, 맨 앞 앱
screenshot [--display N | --window ID | --app 이름 | --region x,y,w,h] [--retina] [--max 1600]
apps                           실행 중인 앱 (이름, pid, 번들 id, 앞에 있는지)
windows [앱] [--all]           창 목록 (id, 앱, 제목, 위치·크기). --all은 숨은 창 포함
activate <앱 이름|번들 id|pid>  앱을 앞으로 (없으면 실행)
ax [앱] [--window N] [--depth N] [--max N]   접근성 트리 (맨 앞 앱이 기본)
ax_click <ref>                 요소 누르기
ax_set_value <ref> <텍스트>     입력칸 값 설정 (비밀번호 칸은 거부)
click|double_click|right_click|move <x> <y> [--pixels]
drag <x1> <y1> <x2> <y2> [--pixels] [--steps N]
scroll <up|down|left|right> [양(픽셀, 기본 300)] [--at x y]
type <텍스트>                  유니코드 입력. 한글·이모지 가능, 줄바꿈은 Return
key <조합> [--repeat N]        cmd+c, cmd+shift+t, return, escape, tab, left, f5, ctrl+alt+cmd+.
cursor                         포인터 위치
wait <ms>                      최대 30000
```

플래그: `--self`는 Sinawi 자신의 창을 일부러 조작할 때만(허용 창이 떠 있는 동안에는 어떤 동작도 실행되지 않는다). `--` 뒤의 글자는 그대로 입력된다(`ao-computer type -- --literal`).

## 안전 규칙 (앱이 강제한다)

- **비밀번호 칸(AXSecureTextField, 보안 입력 모드)에는 `type`/`ax_set_value`가 거부된다.** `key`는 Tab/Esc만 된다. 비밀번호·결제·인증 코드는 사용자가 직접 입력한다.
- **Sinawi 창은 기본으로 클릭되지 않고, Sinawi가 맨 앞일 때 `type`/`key`는 거부된다.** 먼저 `activate`로 대상 앱을 앞으로 가져온다.
- 화면 밖 좌표는 거부된다.
- 모든 동작은 `~/Library/Logs/Sinawi/computer.log`에 남는다(입력한 글자 내용은 남기지 않고 글자 수만).
- 삭제·전송·결제·구매 같은 되돌릴 수 없는 버튼은 사용자 확인 없이 누르지 않는다.
- 거부·중지 오류가 나오면 osascript, cliclick, screencapture 같은 다른 길로 우회하지 않는다.

## 결과 보고

- 스크린샷 PNG는 사용자 전용 폴더(`<사용자 임시 폴더>/sinawi-computer-<uid>/shots/`, 권한 0700)에 있고 200장까지만 남는다. 사용자에게 보여 줄 그림은 작업 폴더로 복사해서 마크다운 경로로 보고한다.
- 각 동작은 채팅에 "컴퓨터 조작" 항목으로(스크린샷은 미리보기와 함께) 자동으로 표시된다.

## Codex 샌드박스

루프백 네트워크가 막힌 샌드박스에서는 CLI가 `<공용 폴더>/queue/` 파일 큐로 자동 전환한다. 따로 할 일은 없다. 공용 폴더는 서버가 CLI에 `SINAWI_COMPUTER_DIR`로 넘기고(없으면 둘 다 `getconf DARWIN_USER_TEMP_DIR` 기준으로 같은 경로를 계산한다), 권한 0700으로 만든다.

## 신뢰 경계 (유지보수용)

에이전트는 사용자와 같은 macOS 계정으로 돌아서 서버 코드, 앱 창이 불러오는 페이지(`http://127.0.0.1:3001`, 사용자 폴더의 정적 파일), 디스크의 어떤 비밀도 바꾸거나 읽을 수 있다. 그래서 서버와 JS의 검사는 **경계가 아니다**.

- **유일한 경계는 네이티브 허용 창**이다. 허용이 없는 세션의 명령이 오면 Rust(`computer_exec`)가 직접 앱 모달 NSAlert를 띄우고, 사용자의 클릭만 허용을 만든다. 허용을 만드는 IPC 명령은 없다(웹뷰는 실행 요청·취소·중지만 할 수 있다). 허용 창이 떠 있는 동안에는 어떤 컴퓨터 동작도 실행되지 않고, CLI에는 손쉬운 사용 권한이 없어 그 창을 누를 수 없다. 창에 보이는 에이전트·작업 공간·세션 정보는 요청에 담겨 온 것이라 그렇게 표시한다.
- 모든 `computer_*` 명령은 `main` 웹뷰에서 온 것만 받는다. 표시 창(`computer-indicator`)에는 권한(capability)이 없다.
- 작업 공간의 **컴퓨터 조작 허용** 설정은 API로도 켤 수 있다(에이전트도 부를 수 있다). 이것은 경계가 아니라 기본값 스위치이고, 켜져 있어도 세션마다 네이티브 허용 창을 거친다.
- 서버의 실행별 토큰, `/api/computer/result`의 검사(보낸 적 있고 아직 답이 없는 명령 id + 그 연결에만 보낸 nonce), 서버의 "허용된 세션" 목록은 잘못된 귀속과 단순 위조를 막을 뿐, 같은 계정의 악의적 프로그램은 막지 못한다. 서버의 허용 목록은 표시용이다.
- 서버에는 허용(approval) 경로가 없다. 중지·취소 경로는 권한을 줄이기만 하므로 출처를 검사하지 않는다.
