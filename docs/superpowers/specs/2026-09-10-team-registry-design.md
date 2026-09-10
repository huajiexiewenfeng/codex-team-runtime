# Team Registry and all-member recall

## Approved design and delivery boundary

Every formal team member recovers the same framework, its role, team and exact
leader. Manager owns registration and maintenance. The optional MCP is deterministic
Python in this repository: no AGC dependency, hook, global prompt changes, timer or
host messaging. Host/thread IDs remain caller-declared, not host-authenticated.

The design has two independently testable increments:

1. **This increment: registry foundation.** Explicit schema-v2 JSON registry owns
   its teams' identities, onboarding declarations and explicit exits. Context-only;
   capsules always say `executionIntegration: not-connected`, `dispatchAllowed: false`.
2. **Separate cutover:** make Node current members a checked registry projection,
   preserve historical round/task identity, gate identity-dependent mutations,
   support safe open-round recruitment, and explicitly adopt existing teams with
   cross-store crash recovery. Do not remove current Node guards in increment 1.

Do not run both identity authorities for one live team. No existing team is adopted
now. Legacy schema-v1 locator recovery remains a separate read-only MCP mode; its
earlier self-registration mutation is no longer exposed. The disconnected barrier
does not cancel existing work under the legacy runtime. No global install, live
team changes, commit or push is authorized by this increment.

## Persistent records and trust

One JSON transaction owns registry identity, teams, members and durable operation
receipts. Exclusive lock, bounded waits and atomic replacement; reads never write.
Initialization is explicit, refuses overwrite and does not create parent folders.

Schema version is 2, with a generated stable `registryId`. Each team has stable
id/name, monotonic revision, exactly one leader with role Manager, and members.
Each member has stable id/name/role, exact host/thread binding, binding revision,
lifecycle and onboarding receipt. Manager-only teams are valid; at most one Liaison.
An exact identity cannot occur in two records, even across teams or after exit.
No rebind, role switch, leader election, hard removal or idle-time expiry in v2.
Completion does not exit membership. Pending native client IDs are not thread IDs.

The service verifies declared Manager/target separation, not caller authenticity.
Authorization, consent and evidence references record externally checked facts;
nonempty strings are not proof of user permission. First-Manager bootstrap requires
explicit user authorization in the host workflow and takes its identity from the
actor. It cannot nominate a different target Manager.

## Core API and two-tool transport

`initialize_registry(path)` creates a new registry.
`TeamRegistry(registry_path=...).read(host_id, thread_id)` returns a capsule or null.
`TeamRegistry(...).manage(actor_host_id, actor_thread_id, request)` returns a mutation
receipt. Errors use existing `ContextError(code, message)`.

V2 exposes only `team_context.read` and `team_context.manage`, no server instructions.
Manage has destructiveHint true because it includes irreversible exit under this
API; this is a conservative hint, not authorization. Successful results and known
core ContextError failures use JSON TextContent; top-level schema/connection errors
can be SDK-native failures and must not be interpreted as null or successful recall.
Management validates exact request shapes (all listed fields are required):

| action | Other request fields |
| --- | --- |
| bootstrap | operation_id, team_id, team_name, member_id, name, authorization_ref |
| register_member | operation_id, team_id, expected_revision, member_id, name, role, target_host_id, target_thread_id, authorization_ref; consent_ref additionally for Liaison |
| confirm_ready | operation_id, team_id, expected_revision, member_id, receipt, evidence_ref |
| exit_member | operation_id, team_id, expected_revision, member_id, authorization_ref |

Only the exact team's active Manager may make non-bootstrap writes. Other roles
cannot self-register, choose leaders, or write readiness. New members are pending.
Manager can confirm its own onboarding after read. Registration permits Worker or
Liaison only, and Liaison requires a target consent reference; it does not replace
the existing live-runtime two-sided pairing protocol.

Durable operation ids bind the exact actor and full request. Identical retry returns
the original historical result, before stale-version checks; changed payload
conflicts. Results contain `operationId`, `teamId`, `teamRevision`, `memberId`,
`outcome`, not a current role/dispatch grant. Always re-read after a retry. Concurrent
same-revision writes yield one commit and a conflict, never a lost update. New
operation ids cannot overwrite an existing member/team or resurrect exited members.

## Capsule and onboarding

Active reads use `member.role`, `team.revision`, and `policyRevision` (the v1 locator
used `policyVersion`). They include own member/binding, team id/name, exact leader
and lifecycle, registry/team/binding/policy revisions, shared rules, role duties,
onboarding status and `onboardingReceipt`. This receipt is `v2:` plus a SHA-256 hex
digest of canonical context fields, not a JSON object. The deterministic receipt binds registry,
team, member, role, binding revision, leader and policy version. It is not a secret
or authenticator. Manager confirmation compares the entire receipt and records a
nonempty external evidence reference. Foreign/stale member, registry, leader,
binding or policy receipts fail. Adding unrelated members does not stale receipts.
Recognized older policy records remain readable but need fresh confirmation under
current rules; an old valid declaration is not file corruption or current readiness.

Active Manager capsules additionally contain `teamMembers`, a compact team roster
with memberId/name/role/lifecycle/hostId/threadId and effective onboardingStatus,
including exited records. This recovers coordination targets after context loss.
Other roles and inactive Manager capsules do not include that roster.

Members return the receipt through an already-authorized native conversation.
Manager verifies that reply, then records readiness. This is an onboarding
declaration, not proof of model comprehension or future recall. Readiness never
grants work authorization, releases a busy Worker, or substitutes for runtime gates.

All roles recall at first onboarding, foreground continuation/context loss, before
role-dependent coordination when context is absent/stale, before delivery/receipt/
acceptance, and when membership/leader/rules conflict. Manager delegates and reviews
independently. Worker durably submits its own authorized work then uses the existing
submission-notice flow to notify the exact Manager. Liaison explains, does not
dispatch, and does not continue progress reporting after work closes. No timer.

Unknown exact identity returns null without writes. Invalid identity, corrupt or
missing registry and conflicts are errors, not null. Exited members return inactive
without operational rules. An exited/unavailable leader does not erase members or
block reads; preserve evidence and ask the user for direction, never elect a leader.

## Recovery and acceptance

Native creation remains outside MCP. Retain original creation receipt, resolve the
formal identity, register idempotently, verify onboarding, then use a connected
runtime's dispatch gates. Uncertain creation does not authorize recreation/resend.
The MCP cannot recover a native task it was never told about.

Verify all-role identity/leader recovery, authority/target separation, consent,
exact uniqueness, lifecycle, foreign/stale receipt denial, restart, idempotency,
concurrent CAS and byte-stable reads. Run real SDK stdio initialize/list/read/manage
tests and legacy read-only compatibility. Distinguish deterministic protocol tests
from guided model samples; neither establishes natural or month-long recall rate.
