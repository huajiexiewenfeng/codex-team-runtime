# MCP team observation events

The MCP server can optionally write one bounded JSON event for each observed
`team_context.read`, `team_context.manage`, or `team_context.startup` call.
Collection is off by default. It is available only in Registry mode and requires
both an absolute output root and at least one exact team allowlist entry:

```powershell
python -m codex_team_context.server serve `
  --registry C:\absolute\registry.json `
  --observation-root C:\absolute\observations `
  --observe-team team-a `
  --runtime-revision operator-declared-revision
```

Repeat `--observe-team` to allow another team. Observation options used with
legacy `--index` mode, a relative output root, or an empty allowlist fail at
startup. Configuration does not create the output directory; the first eligible
event does. `--runtime-revision` is optional but, when present, is an
operator-supplied label rather than a value verified from the running process.

## Identity and reason boundaries

The server projects identity using the caller-supplied `host_id`/`thread_id` (or
actor equivalents) and an exact match in the Registry at call start. This is not
native transport authentication. An unknown identity, a first bootstrap call,
or an identity outside the team allowlist writes nothing.

Callers may declare one of: `onboarding`, `resume`, `post_compaction`,
`before_dispatch`, `before_delivery`, `before_review`, `identity_conflict`,
`manual`, or `unknown`. A declared reason is recorded as `agent-declared`; the
server does not independently infer or verify it. The default `unknown` is
recorded with reason source `unknown`.

Identity metadata remains the Registry projection from call start. In
particular, it does not claim that a capsule returned after a concurrent Registry
change has the same identity. If an initially registered read returns JSON null,
the event outcome is `unmatched`. Other read outcomes are `matched` and
`inactive`; the latter follows the returned capsule status. Registry
`memberStatus` preserves the raw member lifecycle (`active` or `exited`). Manage
and startup calls use `success`, `error`, or `unexpected_error`.

## Event and privacy contract

Each event is an immutable `<UTC-date>/<UUID>.json` file, atomically published
from a same-directory temporary file. It contains only:

- schema/event identifiers and UTC start/completion time plus duration
- tool, Registry/team/member/role and caller host/thread identifiers
- member status, identity source, reason and reason source
- outcome and a bounded safe error code (never an error message)
- the currently executing policy revision
- optional operator-declared runtime revision and its source

Requests, responses, capsule content, prompts, names, duties, and exception
messages are never stored. Observation construction, classification, warning,
and file-write failures are isolated from the MCP operation: the original return
or exception is preserved. A bounded `OBSERVATION_WRITE_FAILED` or
`OBSERVATION_IDENTITY_UNAVAILABLE` code may be written to stderr without paths or
payloads.

These files remain explicit collection inputs. Daily reporting imports only the
regular files listed in `options.json.mcpObservations.files`, resolved relative
to that options file; it never scans the observation directory or expands globs.
The descriptor declares the exact `registryId`, `teamId`, and either `fixture` or
`mcp-server` source kind. A scope mismatch or any invalid selected event rejects
the entire import before export.

The daily view deduplicates identical events by canonical `eventId`, retains
different retry IDs, filters by completion time and the report cutoff, and shows
the server evidence separately from native-log observations. The two sources may
overlap and must not be summed. Zero imported events means only that none were
present in the selected files; coverage remains unverified. Importing files does
not enable collection for a real team, create schedules, or infer complete
coverage, recall effectiveness, or compliant downstream behavior. SDK failures
that never enter the tool handler and unknown identities remain intentional
visibility gaps.
