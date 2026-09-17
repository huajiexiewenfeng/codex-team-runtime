# Compact communication evidence

Use this optional diagnostic when communication evidence is missing/conflicting
or an approval failure needs investigation. Normal authorized assignments and
reports do not require this step, a formatter input file or a separate approval.
When diagnosing, present the evidence as one **separate, short tool result**. Do not
combine it with Skill text, briefs, logs or a full roster in the same exec output.
Load long references first; keep exact native identity observations separate too.
This reduces avoidable output truncation, not host transcript clipping in general.

Use the checked current caller and exact recipient hostId/threadId; select only
those endpoints from the original Team Context result. Preserve source references,
team revision, lifecycle/onboarding, `identityAssurance: caller-declared` and
`dispatchAllowed: false`. Native task observations prove what the host returned,
not complete caller authentication, ownership, membership or disclosure permission.
Keep original authorized evidence available for independent review. Do not scan
other private conversations to reconstruct it.

The optional read-only formatter accepts a UTF-8 JSON envelope:

```text
node <skill-directory>/scripts/communication-evidence.mjs --input <evidence.json>
```

Run it alone and print its single JSON result without other content. The envelope
contains the original parsed capsule (not the MCP content wrapper), plus narrowly
selected observations and provenance:

```json
{
  "caller": {"hostId": "local", "threadId": "exact-caller"},
  "recipient": {"hostId": "local", "threadId": "exact-recipient"},
  "contextRef": "reference-to-original-team-context-result",
  "context": null,
  "native": {
    "caller": {"hostId": "local", "threadId": "exact-caller", "ref": "current-host-identity-and-native-result", "observedAt": "UTC-observation-time"},
    "recipient": {"hostId": "local", "threadId": "exact-recipient", "ref": "exact-native-task-result", "observedAt": "UTC-observation-time"}
  },
  "authorization": {
    "sourceRef": "actual-user-instruction-reference",
    "scope": "this-assignment-and-communication-scope",
    "dataCategories": "actual-authorized-data-categories"
  },
  "history": {
    "status": "unknown",
    "scope": "logical-disclosure-scope-reviewed",
    "ref": "original-attempt-results-or-authorized-history-evidence"
  }
}
```

Replace placeholders only from real evidence. `context: null` represents an actual
unregistered read and produces an explicit incomplete result; do not invent a team
to make the formatter pass. A nonmember's separately user-authorized communication
needs independent review, not implicit membership. For Manager capsules, the exact
recipient must be unique in `teamMembers` including memberId binding uniqueness.
For Worker capsules, the exact recipient is `leader`; a full roster is not required.

`history.status` is `not-attempted`, `delivered`, `denied` or `unknown`; retain the
relevant logical disclosure's original denial/unknown outcome and references even
if its title, stage or notice ID changes. If prior scope overlaps or is unclear,
do not replace it with `not-attempted`. Multiple relevant attempts/restrictions must
remain in the referenced history and its concise scope; any unresolved denial or
uncertainty remains visible. This formatter does not inspect history, verify refs,
resolve contradictory evidence, redact secrets or assess the user's authorization.
Never label a source reference `user_authorization=high` or a host grant.

The unchanged user grant may be reused within its verified scope; no new form or
per-report approval is introduced. Supplied observations remain declared evidence.
Every result says `grantsPermission: false`; even `status: formatted` means only that
the selected evidence fits and passes structural checks, not permission to send.
Existing busy-admission, submission/claim, denial and unknown-result gates still apply.
Do not change a claimed hostRequest to append this evidence: present it separately.

The formatter reads one file (maximum 16 MiB), writes nothing and invokes no host
tool. Output is limited to 6,144 UTF-8 bytes, with no silent clipping of essential
fields. Missing/conflicting evidence is explicit; malformed or oversized essential
data produces a bounded failure with `detailsOmitted: true`, not usable substitute
evidence. The input remains available locally. `denied`/`unknown` labels survive
essential-output overflow. Fix the evidence source or reduce unrelated input, not
unfavorable facts. Exit 0 means formatted; exit 1 means incomplete/invalid/too-large.
After a host denial preserve the exact result and stop; formatting is neither an
alternative transport nor a mechanism to retry an old denied action.
