# Security Policy

## Supported versions

Only the latest release gets security fixes. Sinawi updates itself from GitHub Releases, so keep auto-update on.

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

- Use GitHub's **[private vulnerability reporting](https://github.com/Rakmlabs/sinawi/security/advisories/new)**, or
- email **[1rrock@rakm.co.kr](mailto:1rrock@rakm.co.kr)** with "Sinawi security" in the subject.

Include the Sinawi version, macOS version, what an attacker can do, and steps to reproduce. Remove real tokens and private paths. We aim to reply within a few days and will credit you in the release notes unless you prefer otherwise.

## Scope

Of most interest: the local HTTP/WebSocket server (`127.0.0.1` only), MCP token handling and approval cards, the external MCP bridge (`@rakmlabs/sinawi`), the updater and signing, and file or command access beyond the chosen permission mode. Sinawi is not a sandbox: what a CLI agent can do in *Full access* mode is by design (see [README › FAQ](README.md#faq)).

---

## 보안 취약점 신고 (한국어)

보안 문제는 공개 이슈로 올리지 마세요. GitHub의 [비공개 취약점 신고](https://github.com/Rakmlabs/sinawi/security/advisories/new)를 쓰거나, 제목에 "Sinawi security"를 넣어 [1rrock@rakm.co.kr](mailto:1rrock@rakm.co.kr)로 보내 주세요. 시나위 버전, macOS 버전, 영향, 재현 방법을 적어 주시고 실제 토큰과 개인 경로는 지워 주세요. 보안 수정은 최신 릴리즈에만 들어갑니다.
