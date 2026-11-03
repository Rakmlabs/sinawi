# 릴리스와 자동 업데이트

Sinawi는 Tauri updater 플러그인으로 스스로 업데이트한다. 앱은
`https://github.com/<owner>/<repo>/releases/latest/download/latest.json` 을 읽고, 그 안의
서명된 `.app.tar.gz` 를 받아 설치한다. 이 문서는 릴리스를 내는 방법, 필요한 비밀값, 서명 방식별
사용자 경험을 정리한다.

## 한눈에 보기

지금은 Developer ID 인증서가 메인테이너 Mac 키체인에만 있으므로, 서명·공증 릴리스는 **로컬에서** 만든다.

```
node scripts/release.mjs minor --tag --notes notes.md   # 버전 올림 + 커밋 + 주석 태그
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/sinawi.key)" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat ~/.tauri/sinawi.key.password)" \
  bash scripts/bundle-macos.sh                           # 서명 + 공증 → release-assets/
node scripts/latest-json.mjs --repo Rakmlabs/sinawi --tag v1.3.0 --assets release-assets --notes notes.md
git push && git push origin v1.3.0
gh release create v1.3.0 --verify-tag --title "Sinawi 1.3.0" --notes-file notes.md release-assets/*
```

태그 push 로 Release 워크플로도 돌지만, 그 태그의 릴리스가 이미 publish 돼 있으면 `guard` 잡이 빌드를 건너뛴다.
워크플로가 먼저 시작해 버렸어도 publish 된 릴리스의 파일은 덮어쓰지 않는다.

서명 없이 CI 로만 낼 때(옛 방식)는 태그만 push 하면 draft 릴리스가 생기고, 확인 후 Publish 한다.
Publish 하기 전까지 사용자 앱은 새 버전을 보지 못한다(`releases/latest` 는 draft와 pre-release를 건너뛴다).

## 버전: 기준은 하나

`package.json` 의 `version` 이 유일한 기준이다.

| 파일 | 따라가는 방식 |
|---|---|
| `src-tauri/tauri.conf.json` | `"version": "../package.json"` — Tauri가 빌드할 때 직접 읽는다 |
| `src-tauri/Cargo.toml`, `Cargo.lock` | `scripts/release.mjs` 가 맞춘다 (`env!("CARGO_PKG_VERSION")` 이 서버 버전 해시에 들어간다) |
| `package-lock.json` | `scripts/release.mjs` 가 맞춘다 |
| updater endpoint | `package.json` 의 `repository.url` 에서 owner/repo 를 읽어 `tauri.conf.json` 에 쓴다 |

명령:

- `node scripts/release.mjs patch|minor|major|1.4.0` — 버전을 올리고 파생 파일을 맞춘다. 커밋/태그는 하지 않는다.
  - `--commit` 은 릴리스 커밋까지, `--tag` 는 커밋 + 주석 태그(`vX.Y.Z`)까지 만든다. `--notes 파일` 은 태그 메시지(=릴리스 노트).
  - push 는 절대 하지 않는다.
- `node scripts/release.mjs sync` — `package.json` 을 손으로 고쳤을 때 파생 파일만 다시 맞춘다.
- `node scripts/release.mjs check [--tag-name vX.Y.Z] [--repo owner/name]` — 어긋나면 실패한다. CI와 Release 워크플로가 실행한다.
  Release 워크플로는 `--repo $GITHUB_REPOSITORY` 를 넘기므로, `repository.url` 이 실제 저장소와 다르면(예: 아직 `OWNER`) 빌드 전에 멈춘다.

**저장소 이름을 바꾸거나 포크할 때는** `package.json` 의 `repository.url` 한 곳만 고치고 `node scripts/release.mjs sync` 를 실행한다.

## 릴리스 노트

앱의 업데이트 배너는 `latest.json` 의 `notes` 를 보여준다. 노트는 이렇게 정해진다.

1. 태그가 주석 태그면 그 메시지(`git tag -a v1.3.0 -F notes.md`, 또는 `release.mjs --tag --notes notes.md`).
2. 아니면 GitHub 자동 생성 노트(이전 태그 이후 PR 목록).
3. draft 를 **Publish 하는 순간** `refresh-notes` 잡이 릴리스 본문을 `latest.json` 에 다시 써 넣는다.
   그러니 draft 단계에서 GitHub 화면으로 본문을 고쳐도 앱에 그대로 반영된다.

pre-release 로 publish 하면 `latest` 가 그 릴리스를 가리키지 않으므로 사용자에게 배포되지 않는다(베타용으로 쓸 수 있다).

## 워크플로

- `.github/workflows/ci.yml` — PR 과 main push: `release.mjs check`, `typecheck`, `test`, `build`, `cargo check/test`.
- `.github/workflows/release.yml`
  - `v*` 태그 push → macOS(universal: arm64+x64) 빌드 → `scripts/bundle-macos.sh` → `latest.json` → **draft** 릴리스 업로드.
    올라가는 파일: `Sinawi_<v>_universal.dmg`, `Sinawi_<v>_universal.app.tar.gz`, `.sig`, `latest.json`.
    같은 태그로 다시 돌리면 파일을 덮어쓴다(`--clobber`).
  - 릴리스 publish → `latest.json` 의 노트를 본문과 맞춘다.

로컬에서 번들만 만들어 보려면(업로드 없음):

```
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/sinawi.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat ~/.tauri/sinawi.key.password)"
rustup target add aarch64-apple-darwin x86_64-apple-darwin
bash scripts/bundle-macos.sh        # → release-assets/
```

## 비밀값 (GitHub → Settings → Secrets and variables → Actions)

### 필수: updater 서명 키

| Secret | 값 |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | `~/.tauri/sinawi.key` 파일 **내용 전체** |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | `~/.tauri/sinawi.key.password` 파일 내용 |

```
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/sinawi.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD < ~/.tauri/sinawi.key.password
```

공개키는 `tauri.conf.json` 의 `plugins.updater.pubkey` 에 들어 있다(커밋해도 된다). `requireSignedVersion: true`
라서 서명에 묶인 버전과 `latest.json` 의 버전이 다르면 앱이 설치를 거부한다(옛 릴리스를 새 버전 번호로 둔갑시키는 공격 차단).

> **키 백업 경고.** `~/.tauri/sinawi.key` 와 비밀번호를 잃으면 **이미 설치된 모든 앱이 다시는 자동 업데이트를 받을 수 없다.**
> 새 키로 서명한 업데이트는 옛 공개키로 검증되지 않기 때문이다. 이 경우 사용자가 DMG 를 직접 받아 다시 설치해야 한다.
> 키 파일과 비밀번호를 비밀번호 관리자(1Password 등)나 오프라인 저장소에 따로 백업해 둔다.
> 반대로 키가 유출되면 누구나 Sinawi 업데이트를 위조할 수 있으니 저장소·이슈·로그에 절대 붙여 넣지 않는다.
> (`.gitignore` 에 `*.key` 가 있지만 그건 마지막 안전장치일 뿐이다.)

키를 새로 만들어야 할 때: `npx tauri signer generate -w ~/.tauri/sinawi.key` → 새 공개키를 `tauri.conf.json` 에 넣고 → 위 두 secret 갱신.
기존 사용자는 그 다음 버전을 수동으로 설치해야 한다.

### Apple Developer ID 서명 + 공증

**로컬 빌드**는 `~/.config/sinawi/release.env`(저장소 밖, 권한 600)에서 `APPLE_*` 값을 읽는다. 환경 변수에 이미 있는 값이 우선한다.

```
APPLE_SIGNING_IDENTITY="Developer ID Application: 이름 (TEAMID)"   # 키체인의 인증서
APPLE_API_KEY=<Key ID>                                              # App Store Connect API 키(공증)
APPLE_API_ISSUER=<Issuer ID>
APPLE_API_KEY_PATH="$HOME/.appstoreconnect/private_keys/AuthKey_<Key ID>.p8"
```

`APPLE_SIGNING_IDENTITY` 가 있으면 `scripts/build-server.mjs` 가 번들에 들어가는 node-pty 의 `pty.node`·`spawn-helper` 도
같은 인증서로 서명한다(Tauri 는 앱 자체 바이너리만 서명하는데, 공증은 서명 안 된 Mach-O 가 하나라도 있으면 거절한다).

**CI** 는 아래 Secrets 가 있으면 `bundle-macos.sh` 가 Tauri 의 서명/공증을 그대로 쓴다. 없으면 ad-hoc 으로 빌드한다.

| Secret | 값 |
|---|---|
| `APPLE_CERTIFICATE` | "Developer ID Application" 인증서 `.p12` 를 base64 로 (`base64 -i cert.p12 \| pbcopy`) |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12` 내보낼 때 정한 비밀번호 |
| `APPLE_SIGNING_IDENTITY` | 예: `Developer ID Application: Your Name (TEAMID)` — **이 값이 있어야 Developer ID 모드가 켜진다** |
| `APPLE_ID` | 공증용 Apple ID 이메일 |
| `APPLE_PASSWORD` | 그 Apple ID 의 앱 암호(appleid.apple.com 에서 발급) |
| `APPLE_TEAM_ID` | 팀 ID |

## 서명 방식과 사용자 경험 (솔직하게)

### Developer ID + 공증 (권장, 연 $99)

- DMG 를 받아 열면 바로 실행된다. 경고 없음.
- 지정 요구사항(designated requirement)이 팀 ID 기반이라 업데이트 후에도 화면 기록·손쉬운 사용·알림 권한이 유지된다.

### Ad-hoc (인증서 없이 빌드할 때)

- 브라우저로 받은 DMG 에는 quarantine 속성이 붙는다. 처음 열 때 macOS 가 **"손상되었기 때문에 열 수 없습니다"** 또는
  "확인되지 않은 개발자" 경고를 띄운다. 사용자가 직접 우회해야 한다:
  - 시스템 설정 → 개인정보 보호 및 보안 → "그래도 열기", 또는
  - `xattr -dr com.apple.quarantine /Applications/Sinawi.app`
  README 의 설치 안내에 이 단계를 반드시 적는다. 처음 설치하는 사람 상당수가 여기서 이탈한다는 점이 실제 비용이다.
- **그 다음부터의 자동 업데이트는 문제없다.** updater 가 직접 받은 파일에는 quarantine 이 붙지 않으므로 경고 없이 교체된다.
- `scripts/sign-app.sh` 로 `identifier "dev.sinawi.app"` 지정 요구사항을 넣어 서명하므로(`bundle-macos.sh` 가 자동 적용),
  업데이트해도 macOS 개인정보 권한이 초기화되지 않는다. 다만 이 요구사항은 같은 identifier 로 ad-hoc 서명한 다른 앱도
  만족한다 — 보안상 Developer ID 보다 약하다.
- 나중에 Developer ID 로 바꾸면 지정 요구사항이 달라지므로, 그 첫 업데이트 후 한 번은 권한을 다시 허용해야 한다.

## 앱이 업데이트를 다루는 방식

- 시작 10초 뒤, 그리고 6시간마다 확인(설정 "자동으로 업데이트 확인", 기본 켜짐, 끄면 수동 "업데이트 확인"만).
- 새 버전은 백그라운드에서 받아 두고 작은 배너("업데이트 있음 vX.Y.Z · 지금 재시작")만 띄운다. 설치는 사용자가 누를 때만.
- 누를 때 `/api/health` 의 `running` 이 0 보다 크면 "작업 n개 진행 중 — 끝나면 업데이트" 를 보여주고
  "끝나면 재시작"(15초마다 확인해서 0 이 되면 설치·재시작) / "그래도 지금 재시작" / "취소" 중에 고르게 한다.
  세션은 launchd 서버에서 돌기 때문에 앱만 재시작해도 끊기지 않지만, 서버 교체는 작업이 끝난 뒤로 미뤄진다.

### 서버 교체 (server_agent.rs)

새 앱이 뜨면 번들 서버 버전 해시(앱 버전 + `server.cjs` + `dist/index.html`)가 설치본과 달라진다.

1. 세션이 0 일 때까지 20초마다 대기한다.
2. 기존 서버가 **돌아가는 동안** `server.staging` 에 새 파일을 복사한다. 실패하면 기존 서버는 그대로 둔다.
3. 복사 중에 세션이 시작됐으면 staging 을 버리고 다시 대기한다.
4. bootout → `server` 를 `server.old` 로, staging 을 `server` 로 바꾸고 → plist 갱신 → bootstrap.
5. 45초 안에 `/api/health` 가 새 버전을 보고하면 `server.old` 를 지운다.
   아니면 **롤백**: `server.old` 를 되돌리고, 옛 버전으로 plist 를 다시 써서 띄운다. 다음 앱 실행 때 다시 시도한다.

기록은 `~/Library/Logs/Sinawi/agent.log` 에 남는다. 앱은 `/api/health` 의 `version` 과 앱에 번들된 서버 버전(`server_version_status` 명령)을
비교해서, 아직 교체 전이면 "서버가 아직 이전 버전입니다 — 작업 n개가 끝나면 자동 적용", 유휴 상태에서도 몇 분째 다르면
"서버가 앱과 다른 버전으로 실행 중" 안내를 띄운다.

## 출시 전 점검 목록

- [ ] `node scripts/release.mjs check` 통과, CI 녹색
- [ ] draft 의 DMG 를 받아 깨끗한 계정(또는 다른 Mac)에 설치해 실행
- [ ] Publish 직후, 이전 버전이 설치된 Mac 에서 설정 → "업데이트 확인" → 배너 → 재시작 → 새 버전 확인
      (draft·pre-release 는 앱이 보지 못하므로 이 단계는 publish 뒤에만 가능하다. 문제가 있으면 릴리스를 다시 draft 로 돌리면
      `latest` 가 이전 릴리스로 되돌아간다)
- [ ] 세션 실행 중 재시작 → 세션 유지, 끝난 뒤 `agent.log` 에 `updated server ... -> ...`
- [ ] 릴리스 본문 확인 후 Publish
