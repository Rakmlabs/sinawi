# 앱 브라우저 (ao-browser)

Sinawi 창 안의 브라우저 탭을 조작한다. 사용자는 같은 탭을 본다. 결과물, 목업, 디자인 시안, UI 확인은 이 브라우저로만 연다.

코드: `server/browser-bridge.ts`의 `CLI_SOURCE`, `BROWSER_ACTIONS`, `server/preview.ts`의 주소 판정, `server/preview-picker.ts`의 페이지 안 동작, `src/BrowserPanel.tsx`의 명령 실행, `src/native-browser.ts`와 `src-tauri/src/native_browser.rs`의 네이티브 탭.

## 두 가지 탭

- **데스크톱 앱(macOS)**: 탭마다 진짜 WKWebView가 패널 위에 놓인다. 프록시 없이 직접 연다. 외부 https 사이트와 localhost 개발 서버 모두 조작된다. 뒤로/앞으로는 그 탭의 실제 기록이고, screenshot은 WebKit이 그린 실제 픽셀이다(canvas, video, WebGL, 다른 도메인 이미지 포함). 페이지에는 앱 명령(IPC)이 전혀 열리지 않는다.
- **일반 브라우저 개발 모드(`npm run dev`)**: 예전처럼 iframe과 localhost 프록시다. localhost http만 조작되고 외부 https는 `controllable: false`로 표시만 된다. screenshot은 DOM을 다시 그린 근사치다.

`ao-browser tabs`의 `controllable`이 그 탭을 조작할 수 있는지 알려 준다.

실행은 `ao-browser`다. PATH에 없으면 `node ~/.local/bin/ao-browser`. `ao-browser --help`는 사용법을 출력하고 종료 코드 2로 끝난다. 인수가 없으면 종료 코드 0으로 같은 사용법을 출력한다.

프롬프트에 들어가는 핵심은 `server/supervision.ts`의 `BROWSER_CORE`다. 이 문서는 그 나머지다.

## 사용법

`ao-browser --help` 출력과 같다.

```text
ao-browser <명령> [인자]
  goto <url|포트>               페이지 열기 (https 외부 사이트도 가능, 탭이 없으면 패널을 염). 로딩과 네트워크 idle을 기다림
  snapshot                      ref가 붙은 접근성 트리
  click <ref|selector>          클릭. 바뀐 snapshot을 돌려줌
  fill <ref|selector> <텍스트>  입력칸 값 바꾸기 (type은 이어서 타이핑)
  press <키> [ref]              예: Enter, Tab, Escape, Control+A
  keyboard <키|글자> [ref]      키 조합 또는 글자 입력
  hover <ref|selector>          가리키기
  select <ref|selector> <값>    드롭다운 선택
  scroll <up|down|top|bottom|ref> [px]
  upload <ref|selector> <파일>  파일 입력
  dialog [accept|dismiss] [문구]
  wait <selector|text:문구|idle> [ms]
  text [ref|selector]           보이는 텍스트
  console                       콘솔 오류/경고와 네트워크 오류
  network [all]                 네트워크 오류 (all은 최근 요청)
  screenshot [ref]              뷰포트 또는 요소 PNG
  viewport <iphone|tablet|desktop|WxH>
  tab <new|select|close> [url|번호]
  back | forward | reload | tabs | status
```

구현에만 있는 별칭이다. 도움말에는 없다.

| 입력 | 실제 명령 |
|---|---|
| `open`, `navigate` | `goto` |
| `shot` | `screenshot` |
| `device` | `viewport` |
| `type` | 입력칸 뒤에 이어 타이핑. `fill`은 값을 바꾼다 |
| `dialog ok`, `dialog cancel` | `dialog accept`, `dialog dismiss` |

`e12`처럼 `e`와 숫자만 있으면 ref다. 그 외 문자열은 CSS selector다. `E12`는 ref가 아니다.

## 열리는 주소

데스크톱 앱에서는 http/https 페이지면 모두 열리고 조작된다(`https://example.com`, `localhost:5173`, `127.0.0.1:8765/index.html`). 개발 모드 iframe에서는 http이고 호스트가 `localhost`, `127.0.0.1`, `::1`, `[::1]`, `0.0.0.0`, `*.localhost`인 페이지만 조작된다.

- `5173`, `:5173/path`는 `http://localhost:5173/`로 정규화된다.
- `localhost:8765/index.html`은 그 경로를 연다.
- `8765/index.html`은 포트로 해석되지 않는다. 호스트를 붙인다.
- `example.com`처럼 점이 있는 글자는 `https://example.com`, 그 밖의 글자는 검색으로 빠진다.
- `file://`, `javascript:`, `data:` 같은 주소는 열지 않는다(데스크톱 앱은 `http/https 주소만 열 수 있습니다`).
- 응답에 `controllable: false`가 있으면(개발 모드의 외부 사이트) 조작되지 않는다. Playwright나 외부 브라우저로 우회하지 않고 그 사실을 보고한다.
- 앱 자신(보통 3001)과 미리보기 프록시 포트는 `Sinawi 자체 주소는 열 수 없습니다`로 거절된다.
- 외부 사이트에서는 로그인·결제·글쓰기처럼 사용자 계정에 남는 동작을 사용자 확인 없이 하지 않는다.

## 정적 파일

`file://`는 열지 않으므로 작업 폴더의 HTML·목업은 로컬 HTTP로 띄운다. 이미 떠 있는 개발 서버가 있으면 그 포트를 `goto` 한다. 포트는 package.json의 dev 스크립트에서 확인한다.

없을 때 명령은 하나다.

```sh
python3 -m http.server 8765 --directory preview
```

`--directory`는 세션 작업 폴더 기준 상대 경로다. `cd`와 `&&`로 잇지 않는다.

Codex와 Claude는 이 명령을 백그라운드로 두고, 다음 도구 호출에서 `ao-browser goto 8765` 또는 `ao-browser goto localhost:8765/index.html`을 실행한다. Grok은 `&`와 `bash -c`가 거절되어 서버 명령이 턴을 붙잡는다. 이미 떠 있는 포트를 쓰고, 없으면 부분 완료로 서버가 필요하다고 보고한다.

앱 서버 포트(보통 3001)와 이미 쓰이는 포트는 쓰지 않는다. 띄운 서버는 kill 하지 않는다. 그 포트가 이미 쓰이고 있으면 다른 1024 이상 포트를 고른다.

개발 서버가 꺼져 있으면 페이지 제목이 연결 실패로 나온다. 다른 도구로 우회하지 말고 막힘으로 보고한다.

## 조작 순서

1. `ao-browser goto <포트, localhost 주소 또는 https 주소>`. 탭이 없으면 패널이 열린다. 로딩이 끝나고 네트워크가 약 0.4초 조용해질 때까지 기다린다. 오래 열리는 요청이 있으면 그 사실을 결과에 적고 계속한다.
2. `ao-browser snapshot`. 여기 나온 ref만 쓴다. goto와 click, fill, press, scroll, hover, select, upload, keyboard, dialog는 바뀐 snapshot을 같이 돌려준다.
3. `ao-browser click e12`, `ao-browser fill e3 "안녕"`, `ao-browser press Enter`.
4. 화면이 바뀌거나 `페이지가 이동했습니다. snapshot 을 다시 찍으세요`가 나오면 다시 snapshot. 새 요소는 새 번호다. 이미 찍힌 요소의 ref는 새로고침 전까지 유지된다.
5. 증거는 `ao-browser screenshot`. 요소만 찍으려면 `ao-browser screenshot e12`. 필요하면 `ao-browser text`, `ao-browser console`, `ao-browser network`.

공백이 있는 텍스트와 selector는 따옴표로 한 인자에 넣는다. `ao-browser fill e3 "홍 길동"`, `ao-browser click "button.primary"`.

selector를 짐작해 여러 개 찍지 않는다. `요소를 찾을 수 없습니다`면 selector를 바꾸지 말고 snapshot부터 다시 한다. 같은 실패가 세 번째면 막힘이다. 앱도 같은 오류 3회, 같은 명령 4회, 같은 도구 계열 6회면 그 워커만 멈춘다.

총괄은 이 순서를 워커 브리프의 검증에 적는다. 총괄이 직접 하는 읽기 전용 확인은 snapshot, text, console, network, screenshot까지다.

## snapshot 출력

접근성 트리다. 조작 가능한 요소, 제목, 랜드마크, 대화상자, 이름 있는 이미지가 들어간다. 최대 300개다. 들여쓰기가 부모다.

```text
# 문서 제목  http://localhost:5173/
[dialog] confirm "삭제할까요?" dismiss (클릭 전에 ao-browser dialog accept)
navigation "메뉴"
  [e4] link "문서" href=/docs
main
  [e1] heading "제목" [level=1]
  [e12] button "저장"
  [e3] textbox "이메일" value="a@b.c"
  [e8] input[file] "첨부" file
  [e5] button "아래" (화면 밖)
… (300개까지만 표시)
```

ref는 `[e12]`다. `e12`만 명령에 넣는다. 랜드마크는 ref가 없다. `(화면 밖)`은 클릭하거나 `scroll e5` 하면 그 요소까지 스크롤된다. 이름표 우선순위는 aria-label, aria-labelledby, title, label, placeholder, 보이는 글자, 이미지 alt다. 랜드마크는 접근 가능한 이름만 쓰고 안의 글을 통째로 넣지 않는다. 80자에서 잘린다. 역할은 button, link, textbox, checkbox, radio, combobox, input[file], heading, navigation, main, dialog, img다. 상태에는 value, checked, disabled, expanded, collapsed, pressed, selected, required, active, href가 붙는다.

## 명령별 동작

- `click <ref|selector>`. 가운데로 스크롤한 뒤 pointer, mouse, click을 보낸다. 반환은 클릭한 ref와 바뀐 snapshot.
- `fill <ref|selector> <텍스트>`. 값을 바꾼다. input, textarea, select, contenteditable. select는 값이나 보이는 글자로 고른다. 없으면 `옵션을 찾을 수 없습니다`와 있는 값. 그 외는 `입력할 수 없는 요소입니다`.
- `type <ref|selector> <텍스트>`. 기존 값 뒤에 잇는다.
- `select <ref|selector> <값>`. combobox만. 예: `ao-browser select e5 서울`.
- `press <키> [ref|selector]`. 대상이 없으면 현재 포커스. `Control+A`, `Shift+Tab`, `Meta+Enter`처럼 `+`로 수식키를 붙인다. Enter는 input이면 폼을 보내고, Tab은 다음 조작 요소로 포커스를 옮긴다.
- `keyboard <키|글자> [ref]`. 이름 있는 키와 조합은 press와 같다. 그 외 글자는 칸에 한 글자씩 넣는다. 예: `ao-browser keyboard e3 "안녕"`.
- `hover <ref|selector>`. 요소 위로 포인터를 옮긴다.
- `scroll up|down|top|bottom [px]`. px가 없으면 화면 높이의 약 80%다. `scroll e7`은 그 요소까지 스크롤한다. `scroll e7 down 200`은 그 요소가 스크롤되면 그 안을, 아니면 페이지를 움직인다.
- `upload <ref|selector> <파일경로>`. snapshot의 `input[file]`에 로컬 파일을 넣는다. 없거나 20MB를 넘으면 그 이유로 실패한다. 파일 입력이 아니면 `파일 입력칸이 아닙니다`.
- `dialog`. 인자 없이 실행하면 마지막 alert/confirm/prompt를 보여 준다. 없으면 `열린 대화상자 없음`. `dialog accept [문구]`와 `dialog dismiss`는 다음 confirm/prompt의 응답이다. 클릭보다 먼저 실행한다. 정하지 않은 confirm/prompt는 거절된다.
- `wait <selector> [ms]`, `wait text:문구 [ms]`, `wait idle [ms]`. 기본 15초, 최대 55초. 없으면 `기다렸지만 나타나지 않았습니다`. idle은 네트워크가 조용해지지 않으면 `네트워크가 조용해지지 않았습니다`.
- `text [ref|selector]`. 없으면 body. 보이는 글자 최대 2만 자. 글자만 출력된다.
- `console`. 모은 error, warn 최근 50줄. 없으면 `콘솔 오류/경고 없음`. 네트워크 오류가 있으면 그 아래에 붙는다. 글자만 출력된다.
- `network`. 실패한 요청. `network all`은 최근 요청. 없으면 `네트워크 오류 없음`.
- `screenshot [ref]`. ref가 없으면 현재 뷰포트, 있으면 그 요소(화면 밖이면 먼저 그 요소로 스크롤). 크기가 없으면 `요소가 화면에 크기가 없습니다`. JSON에 `path`, `url`, `width`, `height`. 데스크톱 앱은 `native: true`이고 화면 배율(레티나는 2배) 픽셀이다. 브라우저 패널이 닫혀 있거나 가려져 있으면 패널을 연 뒤 찍는다.
- `back`, `forward`. 그 탭의 기록만 이동한다(앱 창 기록은 건드리지 않는다). 더 없으면 오류. 이동 뒤 snapshot을 돌려준다.
- `reload`. 새로고침 후 로딩과 네트워크 idle을 기다린다. ref는 초기화된다.
- `tabs`. `{ index, active, url, title, controllable }`. 번호는 1부터다.
- `tab new [url]`, `tab select <번호>`, `tab close <번호>`. 번호가 없으면 `탭 번호가 없습니다`. 마지막 탭을 닫으면 페이지를 비운다.
- `status`. `{ url, title, ready, networkPending }`. `ready`는 문서 readyState다.
- `viewport <iphone|tablet|desktop|WxH>`. 아래 화면 크기 절.

요소를 찾지 못하면 `요소를 찾을 수 없습니다: … — snapshot 을 다시 찍으세요.` 선택자가 문법에 맞지 않으면 `잘못된 선택자`.

`click`, `fill`, `scroll`, `press`, `hover`가 돌아가는 동안 페이지에 점이 잠깐 보인다. 클릭과 입력은 페이지 안 DOM 이벤트다(`isTrusted`가 false). 진짜 마우스 입력만 받는 위젯은 반응하지 않을 수 있다.

`target=_blank` 링크와 `window.open`은 데스크톱 앱에서 새 탭으로 열린다. 페이지가 띄우는 팝업 창 자체(OAuth 팝업 등)는 만들지 않는다.

## 화면 크기

툴바의 웹/iPhone 버튼이 데스크톱(웹)과 마지막 모바일(앱) 화면을 바꾼다. 옆 화살표에서 iPhone 390×844, 태블릿 768×1024, 데스크톱 전체 폭, 사용자 지정 크기를 고른다. 프레임은 패널 가운데에 있고, 패널보다 크면 줄어 들어간다. 마지막 선택은 앱이 기억한다.

같은 일을 명령으로 한다.

```text
ao-browser viewport iphone
ao-browser viewport tablet
ao-browser viewport desktop
ao-browser viewport 390x844
```

`mobile`, `app`, `phone`은 iPhone이다. `pad`, `ipad`는 태블릿이다. `web`, `full`은 데스크톱이다. 사용자 지정은 `가로x세로`이고 한 변은 200–4000이다. 그 밖은 `알 수 없는 뷰포트`다.

iPhone, 태블릿, 너비 500 이하 사용자 지정은 iPhone user-agent와 터치를 켠다. 너비 1100 미만의 그 외 사용자 지정은 iPad user-agent와 터치를 켠다. 데스크톱과 넓은 사용자 지정은 기기의 user-agent로 되돌린다. user-agent가 바뀌면 열린 페이지를 한 번 새로고침해, 다음 문서가 처음부터 그 값을 보게 한다. 터치 에뮬레이션은 `maxTouchPoints`, `ontouchstart`, `pointer: coarse`다.

## screenshot과 뷰어

PNG는 서버 임시 폴더 `sinawi-browser`에 저장된다. 채팅 뷰어는 세션 작업 폴더와 미리보기 첨부 폴더만 연다. 임시 PNG 경로를 마크다운에 적어도 뷰어가 열지 못한다.

사용자에게 보여 줄 그림은 작업 폴더로 옮긴 뒤 마크다운에 적는다. `cp`는 Grok 허용 목록에 없으므로 명령을 나눈다.

```sh
mkdir preview
python3 -c 'import shutil; shutil.copy("screenshot의 path", "preview/home.png")'
```

보고에는 `![화면](preview/home.png)`를 적는다. `open`으로 열지 않는다.

## 사용자가 보낸 요소

`orchestra-attachments` 블록의 필드와 해석은 [app-guide.md](./app-guide.md)의 첨부 절과 같다.

- `메모`가 요청이다.
- `소스`의 `file:line`과 `React 컴포넌트`가 고칠 위치다.
- `selector`는 그 페이지의 CSS다. snapshot의 ref와 섞지 않는다.
- 페이지 주소로 `goto`한 뒤 snapshot에서 같은 글자와 역할을 찾는다. ref가 없으면 `ao-browser text "<첨부 selector>"`를 한 번만 실행한다.
- `요소 캡처`와 `전체 화면 캡처`는 이미지 파일이다. 읽어 현재 화면과 비교한다.
- `outerHTML`은 1500자에서 잘릴 수 있다. 구조의 원본은 소스 파일이다.
- `주요 스타일`은 계산된 CSS 일부다. `background-image: none`처럼 지금 화면에 적용된 값이다.

## 창이 없을 때

명령은 먼저 `127.0.0.1`의 앱 포트(환경 변수 `SINAWI_PORT`, 이전 이름 `AGENT_ORCHESTRA_PORT`도 읽음, 기본 3001)로 전달된다. 연결이 안 되면 임시 폴더 큐로 넘긴다.

- 앱 창의 소켓이 없으면 서버가 앱을 한 번 띄우고 최대 15초 동안 창을 기다린다. 그래도 없으면 `Sinawi 앱 창이 열려 있지 않습니다. 앱을 실행한 뒤 다시 시도하세요.`
- 큐에 요청이 4초 넘게 남아 있으면 `Sinawi 앱이 실행 중이 아닙니다.`
- 큐가 75초를 넘기면 `응답 시간 초과`.
- 창은 연결됐는데 응답이 없으면 `앱 브라우저가 N초 안에 응답하지 않았습니다.` 처음 대기에는 최소화됐거나 화면이 잠겨 있으면 응답하지 못한다는 문장이 붙는다.
- 열린 탭이 없으면 `열린 페이지가 없습니다. 먼저 ao-browser goto …`.
- 데스크톱 앱은 3초마다 health의 `windows`를 본다. 9초 연속 0이면 창을 다시 로드한다.

대처는 한 단계다. `앱 창이 열려 있지 않습니다` 또는 `앱이 실행 중이 아닙니다`면 같은 명령을 한 번만 다시 보낸다. 그 한 번이 서버의 15초 대기다. `최소화됐거나 화면이 잠겨`, `사용자가 AI 조작을 중지했습니다`는 다시 보내지 않는다. 사용자에게 창을 앞으로 달라고 적고 막힘으로 보고한다. 같은 실패가 세 번째면 막힘이다.

중지 버튼이나 페이지의 Esc는 이후 명령을 약 1분 동안 거절한다. 그 분 안에 재시도하지 않는다.

## 건드리지 않는 것

- 외부 Chrome, Playwright, `open`.
- 사용자가 이미 띄워 둔 서버의 포트, 앱 서버 포트, 미리보기 프록시 포트.
- 사용자가 명시하지 않은 프로세스 kill.
- 결제, 삭제, 외부 전송 버튼. 사용자 확인 없이 누르지 않는다.
