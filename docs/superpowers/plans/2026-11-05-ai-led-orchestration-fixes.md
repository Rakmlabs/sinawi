# AI-led orchestration fixes implementation plan

Goal: make tag and tool delegation honor lead choices, reject unavailable auto-added CLIs, and report missing skill/design execution evidence.

Architecture: retain the shared Orchestra worker execution path. Parse optional tag models, apply models per dispatch, reuse install/auth helpers at auto-add, and append best-effort diagnostics to worker reports and warning events. No new dependencies or live app access.

1. Add failing regression tests for tag models/design briefs, worker-ID models, and CLI readiness; implement each in its existing delegation path.
2. Add failing tests for skill/design invocation detection, consent/access failures, and propagation to lead reports; implement a small evidence helper and call it for each completed worker run.
3. Clarify tag prompts and Claude terminal consent requirements. Persist auto-added teams only if existing ownership/storage makes it low-risk.
4. Run targeted tests, full npm test, typecheck and build. Review the diff and commit only task-owned files locally.
