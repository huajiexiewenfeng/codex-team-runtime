# Manager activation and initialization routing

Use when the user explicitly designates the current independent session as
Manager or authorizes a new team. Status, a Skill mention, a title change and
ordinary continuation do not create a team. This routing is a foreground Skill
procedure backed by the startup receipt API, not an automatic hook or atomic
initialize-team operation.

## 1. Establish intent and inspect without mutation

Explicit Manager activation requests the default minimum team: the current
Manager window plus one independent Liaison and one independent Worker window.
Reuse valid existing members; three is a minimum, not a reason to remove extra
members or create another Manager. A specific user composition overrides this
default. Separate setup from development: activation alone leaves the Worker
available without an invented business assignment. An already approved plan may
proceed after admission without asking for its authorization again. Installation
and timers are not included. Keep the user's Manager model/effort unchanged.

Verify the current caller as described in operations.md. When designating another
session, that session must perform its own identity-dependent activation; the
current caller must not impersonate it. Read its own `team_context.read` result
and inspect already-known team/state/operation references. Do not scan private
logs or all projects to prove absence. A null lookup means this caller is not
registered, not that every possible previous team is absent.

Explicitly designating this session as Manager, with a verified null lookup and
no known previous team, conflicting ownership or unfinished activation evidence,
is sufficient to choose first-time initialization. The user need not also say
"new team" or provide a nonexistent state. If known evidence makes new versus
recovery materially ambiguous, ask only that choice while completing safe
runtime checks.

## 2. Select one route

| Observation | Route and next action |
| --- | --- |
| Null + explicit Manager activation + no prior/conflicting known evidence | First-time initialization needed. Locate the trusted runtime and check execution capability before creating records. Do not demand an old state path or ask whether this is a new team again. |
| Null + known previous team/state or unfinished activation attempt | Recovery/reconciliation. Inspect that exact original reference and operation; no replacement team or fresh operation ID. |
| Active Manager + connected | Reuse the same team and state, refresh readiness as needed. On explicit activation, reconcile missing minimum-team roles through supported MCP membership operations; never initialize again or replace an existing/busy member. Ordinary continuation does not automatically add members. |
| Active Manager + not-connected | Already registered, execution connection missing. Preserve its IDs and check supported linking; never bootstrap another team. |
| Active + migration-pending | Continue the original verified recovery protocol with its original operation/request. No business dispatch, new team or old-state overwrite. |
| Active Worker/Liaison, wrong leader/owner, or inactive | Role conflict or explicit exit. Explain the conflict; no self-promotion, silent rebinding or resurrection. |
| Error/unavailable, malformed result, unknown integration state, or identity conflict | Diagnose the specific failure. Never convert it to null, initialize an empty Registry or use legacy as a bypass. |

## 3. Locate the installed runtime before asking the user

Use in order: verified explicit paths; current linked context; the user's already
configured Team Context MCP service metadata. If configuration is the only source,
read only that known service's executable/arguments or operator installation
record. Extract its `--runtime-root`, `--node-executable` and Python command when
present; do not dump unrelated settings, environment values or secrets, change
configuration, or search guessed installation trees. Configured paths are locator
evidence, not proof that every live connection has loaded that version.

Validate the referenced companion identity, `src/cli.mjs`, required runtime
versions and the selected runtime's `docs/team-context.md` and
`docs/runtime-usage.md`. A source checkout found nearby is not automatically the
installed runtime. If no trusted locator can be recovered, ask for the missing
runtime location once; request an original state only on a recovery route.

## 4. Preflight the requested outcome, not just registration

For a new executable team, check that the installed version documents a supported
fresh-team initialization/connection path, including original state creation,
conflict/overwrite rejection and recovery after an uncertain result, before any
Registry or state mutation. Follow only that version's documented API. Choose a
fresh state location within the authorized project scope, explain it, and retain
the same operation/request for reconciliation; a local path choice is not a new
development approval. Existing files are inspected, never overwritten or skipped
by picking another path after an uncertain attempt.

### Fresh executable minimum team

The supported composition is `start -> real attach/register -> adopt_legacy ->
own reads/confirm_ready`. Read the installed runtime's **New minimum-team
activation** section in `docs/runtime-usage.md` and its cutover protocol first.
This uses the actual newly created state, not a fabricated migration fixture.

1. Record the activation reference, chosen team/member IDs and original state
   location in the authorized project before side effects. Use globally unique
   member IDs, for example `<teamId>-manager`, `<teamId>-liaison`,
   `<teamId>-worker-1`; set `managerMemberId` and `liaisonMemberId` in `start`.
   Do not reuse IDs from example JSON or change IDs after a conflicting result.
2. Run `start` once as the verified current Manager. It creates records only.
   Before new native creation, read `<runtime-root>/docs/startup-recovery.md` and
   verify `team_context.startup` is available in the configured service. Prepare
   all missing intended member slots with immutable operation IDs; retain them
   in the original activation reference. For each slot, `claim` immediately before
   native creation. Only this call's `claimed:true` permits that one authorized
   create; a lost response or `claimed:false` requires reconciliation.
   With host permission to create independent tasks, create the missing Liaison
   and Worker using native tools, the model/naming policy in operations.md and
   the correct project environment. They are not temporary collaboration
   helpers. If the host requires an additional explicit creation request, obtain
   that permission; never bypass it with another tool. Retain each creation
   result before the next side effect and use `record_creation` for its native
   identity. Resolve pending client IDs using the original slot's own receipts
   and independent native verification; never bind client IDs or retry creation
   while the outcome is unknown. If this API is unavailable, report the installed
   capability gap before creating new windows; do not self-install.
3. Initial prompts are onboarding-only: exact Manager/team identity, original
   state and shared contract paths, **startup operationId, memberId and role**,
   own identity verification, and no business work yet. Require the new member
   to publish its own `team_context.startup` `receipt` before formal registration;
   null context is expected. Manager reads `plan`, independently checks the exact
   candidate with native `read_thread`, then `verify`. A startup receipt is neither
   registration nor consent. Manager issues the real Liaison invite; that Liaison
   confirms from its own independent context. Manager registers the verified Worker. Respect
   each task's file permissions; never confirm on behalf of a member.
4. Inspect the original state and native results: exactly the intended bound
   minimum members, confirmed pairing, no open rounds/tasks/reports. Use
   `adopt_legacy` on this very state with its current version/SHA, complete roster,
   activation authorization and real consent evidence. Preserve the original
   operation ID/request on uncertain results. Follow the cutover recovery rules.
5. Each of the three members performs its own context read and returns its own
   receipt. Manager verifies and confirms each readiness; re-read the latest
   roster and connected runtime. Registered members are not automatically ready.

No API here creates native windows or authenticates a caller on its own. This is
a foreground, multi-step Skill workflow, not an atomic initialize-team MCP tool.
The default minimum team is complete only with three resolved native windows,
correct bindings, connected runtime and all three ready. If interrupted, report
the exact partial stage and resume that same attempt; do not delete or rebuild.
On recovery, `team_context.startup` with `{"action":"plan"}` finds recorded
operations for the verified current Manager even when task lists or final reply
reads are empty. Query during foreground continuation, not a polling loop. Errors
are not absence; lost ledger data needs original evidence, not a replacement
operation. Older attempts without startup records use saved creation evidence
and known formal IDs, not a fabricated claim.

`bootstrap` creates identity-only registration (`not-connected`); do not run it
first for this executable setup, because adoption rejects an existing Registry
team/identity. It remains available for explicitly requested identity-only setup.
Do not fabricate pairing, invent members, or change IDs to evade an existing
ownership conflict. New unique IDs are chosen only before a genuinely new team.

When the requested executable initialization/connection is unsupported, report
that exact capability gap before leaving partial records or creating Workers.
Do not ask the user to supply an old state that does not exist, repeat the
development authorization question, invent `initialize_team`/`connect_team`, or
claim that changing this reference implements the missing runtime capability.
For an already context-only team, preserve it; do not exit/delete/recreate it to
make a migration operation accept the same identity.

## 5. Finish activation, then delegate within the existing grant

After a supported initialization/recovery, re-read from the original authoritative
location. Verify the same Manager/team, connected integration and current own
readiness, and every minimum-team member's own readiness. Keep
`dispatchAllowed: false`: context read itself never grants work. For identity-only
setup, explicitly report not-connected instead of claiming ready-to-dispatch.

If member creation and development are already authorized and business admission
is possible, continue to create or reuse formal Workers using native host rules,
register each, pass the shared contract, obtain each member's own read receipt,
confirm readiness and apply queue/round/delivery admission. The workflow must not
stop at an acknowledgment of the Manager title when authorized work can proceed.
If only activation was requested, finish the minimum team and await work; do not
open a round or invent a development task to demonstrate readiness. The Liaison
can answer user-triggered status questions, but has no periodic reporting timer.
Timers stay OFF. A busy existing Worker is retained; new work queues instead of
interrupting it or creating another Worker merely to make the team look idle.

Report: selected route, observed registration and execution state, what actually
completed, and the next authorized action or precise missing capability. Separate
"user designated Manager", "registered", "ready", "connected" and "dispatched".
