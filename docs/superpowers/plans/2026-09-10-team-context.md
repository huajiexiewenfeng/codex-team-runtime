# Lightweight team context implementation plan

> **For agentic workers:** Use test-driven-development for the implementation and verification-before-completion for delivery. Implementers own their assigned files; the parent reviews the combined result.

**Goal:** Recover a previously registered task's role through a small deterministic Python MCP without hooks, timers, AGC or automatic host mutations.

**Architecture:** Existing team state remains authoritative for roles, pairing and exit. A separate exact `(hostId, threadId)` index contains only state locators and binding references, not a second editable team database. Python resolves the index and produces a bounded role capsule from current canonical state. MCP is a thin transport; invocation and role adherence remain separately measured model behavior.

**Tech stack:** Existing Node.js 22+ runtime; Python 3.10+ standard-library core and official MCP Python SDK for stdio transport.

## Constraints

- No changes to global configuration, AGENTS.md, live team state, existing task pairing, hooks or automations.
- Use threadId, not an MCP connection ID or Codex tree-root sessionId. Temporary helpers never acquire a parent role from inherited environment.
- Unregistered identity returns null without writes. Exited/detached registration returns inactive. Missing identity, corrupt index/source, conflicting registration and invalid pairing are errors, never null.
- Exact registration checks against the existing state; reads do not activate, register, create tasks, dispatch, accept, refresh timers or resurrect exited roles.
- No role content in global server instructions. Return concise role-specific boundaries, source version and state locator; full task history remains on demand.
- Existing identity is caller-declared, not authenticated by the MCP. Retain host identity verification and existing action authorization.
- No commit, push or global installation in this increment.

## Task 1 — Python recovery and transport

**Ownership:** `python/`, `pyproject.toml`; focused Python tests.

- [x] Write failing tests for exact identity, null/no writes, persisted registration, state change visibility, exit, pairing mismatch, missing/corrupt state, conflict, and no parent/fork inheritance.
- [x] Implement a minimal locator registry and bounded role projection. Preserve one canonical role authority and existing pairing/exit semantics.
- [x] Add stdio MCP with narrowly described registration/read tools; standard structured errors, explicit read-only annotations, no server-wide role instructions.
- [x] Test real SDK initialize/list/call round trips in an isolated local process, including JSON null and tool errors.
- [x] Supply exact command/interface examples and actual test evidence to the parent; do not install into the live host.

## Task 2 — Foreground recall instructions and evidence

**Ownership:** parent; `skills/manager-session/`, `docs/team-context.md`, `README.md`, narrowly scoped integration tests if required.

- [ ] Baseline role-recovery behavior before modifying Skill instructions. Preserve raw decisions and clearly label synthetic tests. **Evidence limitation:** the baseline ran, but only the parent's summary was retained, not its raw transcript; excluded from reproducible baseline/rate claims.
- [x] Document the implemented tool signatures and prerequisites, keeping existing CLI recovery as a compatible fallback.
- [x] Add concise conditional guidance for foreground continuation/context recovery and before role-dependent dispatch/acceptance. Do not claim that MCP invokes itself.
- [ ] Verify null/inactive/error handling and role adherence with independent fresh-context cases; distinguish these from actual Desktop compaction/resume tests. **Partial:** deterministic and real stdio branches pass; one guided fresh-context active-role sample is archived. Broader model-behavior/rate evaluation remains unverified.
- [x] Run relevant existing Node tests, Python tests and Skill format validation; independently review all changed files.

## Acceptance

Persistence/transport success is not recall-rate evidence. Report deterministic checks, fresh-context behavioral samples and untested live-host recovery separately. Only a future explicitly authorized live trial can measure this version's actual Desktop recall and adherence rate.

Implementation slice delivered with 44 Python tests, 23 relevant Node tests and Skill validation passing. No remaining actionable code-review findings. The two incomplete evidence items above are disclosed, not counted as passed behavior experiments; see `docs/team-context-validation.md` and the archived guided sample. No host installation, commit or push was performed.
