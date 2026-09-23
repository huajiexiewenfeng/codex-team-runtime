# Completion notification and independent review

Default managed-work flow: agreed stage completes → save evidence and proactively
notify the exact Manager → Manager inspects and reviews → pass or rework.
This is foreground Agent behavior, not a background outbox or guaranteed wakeup.

## Preserve authorization and destination evidence

Normal reporting within a valid unchanged grant needs no extra Skill approval or
evidence-formatting step. Use [compact communication evidence](communication-evidence.md)
only for diagnostics; keep claimed hostRequest content unchanged and retain
denial/unknown scope. A diagnostic result is not a prerequisite for normal reporting.

Use the existing user-authorized assignment and report scope: completion, actionable
blockers, necessary diagnostic summaries, verification results and local evidence
paths to the exact bound Manager. Carry the native user instruction/reference and
verified native target evidence through the handoff. An unchanged valid grant needs
no repeated approval or new form; a missing template slot alone is not a blocker.
If evidence is missing/conflicting, or recipient/data/scope changes or authorization
is revoked, resolve only that affected disclosure before sending. A Manager's
paraphrase or file reference records provenance, not a new user or host approval.

Membership, ready status, caller-declared capsules, hashes and native target
existence are not disclosure authorization. The `local` host label does not prove
network-free handling or make every local task a trusted recipient. Before a first
send, exclude credentials, unrelated private data and bulk source/logs outside the
grant. Never change a freshly claimed hostRequest to redact it: hold the send and
preserve its actual state; use authorized correction/review, not a replacement to
bypass a denial. Do not invent a transport result for an unsent request.

## Worker completion checkpoint

At each agreed stage checkpoint, formal submission or actionable blocker, recover
own/team/leader context using team-context.md. Save real artifacts, changed scope,
verification commands/results, risks and unmet criteria. Notify the verified Manager
through the available authorized native `send_message_to_thread` channel before
ending the completion turn; do not wait for the user to ask. Routine tool steps are
not stage checkpoints. Preserve model/effort settings when sending.

### Prompt artifact handoff

When a deliverable passes the checks required for its authorized scope, promptly
show its absolute path and version in the current user conversation, with the
actual status: for example, “制品已就绪；团队提交/通知尚未完成，待 Manager 验收”.
Continue the existing completion flow in the same turn; this early update is not
an extra Manager message, submission or approval. Preserve any gate on use or
deployment and the permitted disclosure scope.

Use one concise evidence summary: artifact absolute path/version; actual checks
and results; existing delivery note and original build/verification log absolute
paths when present or required; remaining risks and acceptance status. Include
the user instruction reference when the output directory changed. Do not assume
Manager shares the Worker's cwd. Existing logs can be referenced directly; a new
long DELIVERY.md or a rewritten log is not required for every small build. If a
required log is unavailable, say so rather than reconstructing it as raw output.

Reuse observed passing evidence for unchanged artifacts and relevant inputs.
Repeat only affected checks after relevant changes, failures or unresolved gaps;
writing this summary or reading a Skill does not require another full check.

- **Formal submission:** the original Worker performs its authorized durable
  `submit`, including stage/version and absolute evidence paths in its summary.
  Follow [submission notices](operations.md#submission-notices) and the trusted
  runtime's `docs/submission-recovery.md`: prepare/save the full notice, reconcile
  send history, track, claim, send the freshly claimed unchanged `hostRequest`
  once, and record the actual result. Do not add invented notice JSON fields or
  send a second message for the same completion.
  After a successful `notice-result` response for the exact attempt, retain that
  response/version as the write receipt; do not automatically run `notice-plan`
  merely to confirm it again. Failed, ambiguous or conflicting results still
  require read-only reconciliation; actual retry decisions retain all existing gates.
- **Non-submit stage or blocker:** send one concise evidence-bearing message explicitly
  labelled “阶段完成，尚未正式提交” or “可操作阻塞，尚未正式提交”, with team/task/stage, completed scope, evidence
  paths, actual checks, remaining risks and the requested Manager check. Save the
  actual send outcome with existing stage evidence. Do not fabricate a submission
  to use the notice ledger; no structured stage-notice receiver is implemented.
- **Submission access blocked:** preserve permitted evidence and report the exact
  integration blocker through an authorized channel. Do not claim submission or
  have Manager impersonate Worker.

Normal completion reporting is part of authorized managed work, not permission to
override user prohibitions or host policy. A Manager approval gate constrains business
progress; it does not require the Worker to keep its current turn running.
When formal submission and the exact attempt's delivered result are recorded, and
no authorized work or explicit active-wait request remains, end the turn as
“submitted, awaiting Manager review” without polling Manager. Keep the task pending
and the Worker reserved; ending a turn is not approval, release or role exit.
An explicit request to actively wait in this turn follows its existing scope;
failed or unknown delivery follows the recovery rules below, not this success path.
Do not self-approve or start unauthorized work. Already-authorized ungated steps
may continue within their existing scope.

## Keep preparation and delivery facts separate

| Fact | Required evidence |
| --- | --- |
| Prepared | Report evidence/notice saved; no transport or submission implied |
| Submitted | Original Worker's durable submission |
| Notification delivered | Actual host acceptance at the exact Manager target |
| Manager received | Verified `receive-submission` result, or explicit non-submit stage acknowledgement |
| Accepted | Manager's independent evidence check and recorded pass decision |

A saved notice, claim or Worker final reply is not notification delivery. Host
acceptance is not Manager review. Report confirmed, pending, denied or unknown
honestly; do not collapse these facts into “completed”.

At an authorized status/review checkpoint, present existing evidence as separate
columns: task/stage | business status | notification outcome | Manager review | next action.
For example, a durable submitted task with an actual `policy-denied` result and no
review is “已提交待审 | 通知被拒 | 未开始审查 | Manager 检查已有获准台账”.
Without transport evidence say “通知情况未知”, not failed or delivered. Formal
notices use `notice-plan.taskStatus` and `notificationOutcome`; its `action/reason`
is a send decision, not a transport receipt. Non-submit stages retain their
original permitted result record, not a fabricated formal submission. This is a
report presentation contract, not a new Dashboard field or automatic data importer.

Notification failure alone does not change a task to business `blocked`, cancel
work, release a Worker or stop other independent authorized work. Required review
gates still apply. Do not move restricted report content to shared state after a
denial as a workaround: the normal authorized task ledger and the denied transport
are separate operations, each subject to its own access restrictions.

## Failure is scoped, not permanent silence

- Policy-denied: preserve denial and stop. No rewording, alternate channel,
  replacement notice or ledger reset to bypass the restriction.
- Timeout, empty read result or ambiguous delivery: retain unknown and reconcile
  the exact attempt read-only. Do not resend or send a probe.
- Only verified transient terminal nonreceipt with evidence that the request
  cannot still arrive permits a bounded foreground retry. Formal notices retain
  existing ledger/cooldown gates and the three-total-claims ceiling; a stricter
  authorized team limit wins. For non-submit stage messages, allow at most one
  retry under the same evidence and authority checks and retain both outcomes.
- Delivered or already under review: do not send again merely because acceptance
  is pending. Do not introduce timers, polling or periodic reminders.

A past Manager-written workaround such as “只保存 notice，无需原生通知” after an
old send failure must not become the default for later authorized completions.
Reconcile its scope and replace a stale workaround in the next authorized handoff.
This does not unlock a denied attempt or cancel an ongoing user/host restriction;
if that restriction's scope is uncertain, resolve it before sending.

Preserve the logical disclosure scope in existing authorized evidence: team/task/
stage, destination, data categories, exact native call ID and result reference.
If a denied non-submit report later becomes a formal submission, a new notice ID
or `not-attempted` ledger entry does not clear the earlier denial of the same
disclosure. Keep the durable business submission separate and reconcile that
restriction before any send. This is a handoff rule, not a new cross-channel lock.

## Host review boundary and precise reconsideration

The current native sender accepts hostId/threadId/prompt and optional model/thinking;
it has no verified team-grant input. Do not invent such an argument or represent a
Registry field, notice hash or prompt heading as host authentication. Skill changes
can preserve evidence but cannot ensure what the reviewer sees or prevent misjudgment.

For an explicit denial, retain the exact call/result. If the current host exposes
the supported **Approve / Auto-review Denials** selector, the user may select that
specific denied action for one reconsidered retry; current open-source TUI documents
`/approve`. Verify the installed surface rather than assuming a slash command works
everywhere. “Approval recorded” is not execution, delivery or future blanket approval:
the action still undergoes auto-review. Never fabricate its developer-scoped approval
marker, invoke an unexposed approval API, or reset a denied Runtime ledger. This
Runtime has no automatic denial-unlock adapter; unsupported reconciliation remains
a disclosed integration blocker. This exception path is not a requirement for each
normal report already covered by valid authorization.

After a denial, a Worker must not independently loosen or replace reviewer policy
to force the report through. A human may explicitly authorize the responsible
configuration owner to make a scoped correction through the host's supported
process. That requires the complete effective baseline, a reviewable exact scope,
preservation of existing constraints, normal configuration approval and verification
of effective loading. `[auto_review].policy` replaces rather than appends, and
managed policy takes precedence; missing baseline or scope evidence means leave it
unchanged. A configuration correction does not automatically unlock an existing
denied action or require renewed authorization for every unchanged normal report.
See [official auto-review documentation](https://learn.chatgpt.com/docs/sandboxing/auto-review).

## Manager receipt and review

On receipt, inspect the exact team/task/stage and actual artifacts in the same
authorized review flow; an acknowledgement alone is not completion of supervision.
For formal submissions, use own verified identity, original trusted state and
current version with `receive-submission`, retaining duplicate/stale notice gates.
Then independently approve or request specific rework, or state the concrete
verification blocker. For non-submit stages, record the stage decision in the
existing handoff/evidence; do not mark the whole task accepted or invent a stage API.

When native delivery fails, authorized foreground `pending-submissions` recovery
can find formal submissions. It is not the normal replacement for Worker notification
and cannot wake an idle Manager. Installing updated files does not refresh existing
Workers' context: Manager carries this contract in authorized handoffs/checkpoints,
respecting busy-Worker admission rather than interrupting unrelated active work.

During each authorized foreground supervision pass, inspect `supervision-plan`'s
durable task checks and pending submissions even without an incoming notification.
Continue existing reviews and inspect recorded blockers. An empty/error native
query does not erase these records or prove inactivity; finish checks allowed by
existing access and report unresolved restrictions. Do not use local retrieval to
bypass a host refusal covering that access/disclosure. Without an active Manager
turn or an authorized available wakeup mechanism, automatic awareness is not guaranteed.
