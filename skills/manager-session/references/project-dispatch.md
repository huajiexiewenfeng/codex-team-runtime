# Project-aware task decomposition and Worker selection

Use before selecting a Worker for new business work, especially multiple backend
requirements or cross-project changes. Manager Session remains the single team
scheduler and final acceptance owner. PDC and Base Graph are optional evidence
providers, not runtime dependencies or alternative team control planes.

## 1. Recover project evidence

Choose the evidence path for the current assignment, not for every conversation:

- With available, applicable PDC, read its installed entrypoint and use its
  project query/develop/fix/review stages within the existing Manager handoff.
  For cross-project work, use discoverable Base Graph overview/catalog to locate
  repository identities and roots, then Project Graph cross-refs/edges and, when
  needed, candidates to narrow source reading. Verify direction, freshness,
  contract ownership and consequential assumptions against source. Graph
  adjacency is not proof that a project needs changes or permission to edit it.
- Without PDC or a discoverable Base Graph, use the approved requirements,
  project documentation, API/schema/client code, tests and configuration directly.
  No PDC install, Base Graph initialization or Wiki creation is required by this
  Skill. PDC with no Base Graph can use project-local evidence.
- If an already-selected PDC lifecycle is blocked, retain its records and gates;
  do not silently switch to source-only to evade them. Continue unaffected
  read-only investigation and resolve the specific gate. Missing optional tools
  differ from conflicting evidence, missing write authorization or Registry
  errors; the latter are never bypassed by fallback.

Normalize either path into the same small project context packet: repository
identity/root, supporting source/version, change vs verification-only vs excluded
scope, contract owner/revision, upstream prerequisites, acceptance and unknowns.
Store it in the existing authorized task brief; link existing PDC records instead
of copying a whole Wiki or creating a second task-state manifest. Read-only
cross-project discovery does not grant cross-project writes.

## 2. Split work before choosing a queue

The initial one Worker is a minimum, not a maximum. Split by independently
verifiable outcome, project/file ownership and dependencies, not just labels
such as "backend". One project may have multiple independent Workers; one graph
edge does not require a Worker. Tiny related changes can stay one task.

For each new unit, choose a suitable idle existing Worker first. If none fits,
independent work can use a new formal Worker within the user's member-creation
authorization, host rules and resource limits. Explain material concurrency or
cost tradeoffs; do not create one window per trivial requirement. If work shares
conflicting files/contracts, needs unaccepted upstream output, or cannot get a
safe/authorized Worker, retain it for later with the specific reason.

Do not automatically queue every backend requirement to the original Worker.
Select the Worker before `queue-task`; then follow busy/FIFO and delivery gates.
An existing task already queued or started keeps its recorded owner: this recipe
does not implement queue reassignment, bypass FIFO, cancel/recreate tasks, or
release an unaccepted reservation. Busy Workers keep their original work.
Different worktrees isolate files, not semantic or integration conflicts; inspect
overlap and agree integration ownership before parallel writes.

## 3. Resolve exact native projects and onboard

Borrow the project-resolution pattern, not the control plane, from PDC
`project-task-dispatch`: repository identity/root must corroborate the exact
saved Codex projectId/path/host from `list_projects`. Without Base Graph, use the
verified source-driven repository identity/root for the same comparison. Never
match by title alone or confuse a graph repository with its business repositories.
No exact or unique writable route means hold that unit and request the missing
saved-project choice; do not create it in the Manager/Base Graph project instead.

Create authorized independent Workers in their respective saved projects using
native host environment rules: normally Git worktree, non-Git local; honor an
explicit direct-checkout choice. Do not copy PDC Dispatch's local-only policy.
Record each repository's branch/HEAD/dirty boundary, intended start state and
actual resulting workspace. A worktree path need not equal its saved-project
root: verify their relationship and baseline. Preserve existing changes; do not
invent a branch or reset/rebase/merge to satisfy a planned baseline.

Pass the project context packet with the shared Worker contract. Worker checks
its actual cwd/repository/baseline before writes and reports mismatches. Register
each resolved native identity under the same team/Manager; obtain own recall
receipts and confirm readiness. In a linked open round, explicitly
`admitRegistryMember` before queue/start. Unlinked legacy registration still
requires no open rounds. Pending/uncertain creation is reconciled, not repeated.

## 4. Coordinate dependencies and acceptance

Persist dependency and integration checkpoints in the brief; they are Manager
foreground decisions, not a new runtime DAG or automatic unlock API. Before each
start, check the agreed prerequisite and its Manager-reviewed evidence. A Worker
final or native idle is not approval. Independent work can run concurrently.
For coupled interfaces, first agree a versioned contract; if both sides can use
that accepted contract independently, implementation may run in parallel. If an
actual upstream artifact is required, retain the downstream implementation until
that artifact is accepted. Mock validation is not end-to-end acceptance.

Example: A exposes an API, B consumes it, C only needs compatibility checks.
Manager owns the shared contract checkpoint; A and B get project-scoped work,
C stays verification-only. Manager reviews each delivery and then checks the
declared cross-project integration and C compatibility before overall acceptance.

Workers using PDC keep their local lifecycle/verification/sync gates and return
evidence to Manager. Workers without it return the same delivery essentials from
ordinary project checks. Neither PDC finish nor all individual green tests alone
proves the cross-project outcome. Manager reports remaining integration gaps.

This adapter does not invoke `project-task-dispatch`, create a PDC manifest/lease,
require its dashboard, enforce one Worker per project, change the team's model
policy, or create timers. PDC remains separately installable and unchanged.
