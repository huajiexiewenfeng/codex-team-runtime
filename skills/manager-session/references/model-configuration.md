# Model configuration and queries

Use this reference when querying/changing defaults or preparing authorized member/helper creation.
`../config/model-policy.json` is the single source for this Skill installation's defaults.
Do not copy model defaults into other prompts, MCP capsules or business state.

## Query

Run the script from the same Skill directory whose instructions are being used:

```text
node <skill-directory>/scripts/model-policy.mjs show
node <skill-directory>/scripts/model-policy.mjs resolve worker
node <skill-directory>/scripts/model-policy.mjs resolve subagent --parent-model <verified-model-id>
```

These are read-only: no runtime, registry, session logs, network, role activation or
LLM call is needed. `show` validates the whole config; `resolve` returns configured
and selected settings plus native request fields. Output always includes the
absolute `configPath` and `effectiveModelVerified: false`. It is not a query of
existing sessions' actual models. Querying does not authorize creating a task.

The optional `--config <path>` selects a complete alternative file for inspection
or a user-selected policy; it does not persist a global override or merge files.
An alternative used for a team must be explicitly selected and passed in its
handoffs. Normal creation uses this installation's bundled file, not cwd guesses.
Missing or invalid configuration is an error, never silent inheritance.

## Change through the Skill

Natural requests such as “查询模型配置” or “将 subagent 默认模型改成 X，强度 medium”
route here without activating Manager. First show the current config and identify
the scope: this installed Skill's defaults, not existing sessions or global Codex.
On an explicit change request, edit only the requested role's `model`/`effort` in
the JSON using the host's file-editing mechanism, retaining a recoverable diff or
backup. Re-run `show` and the affected `resolve` query. There is no `set` command;
the Skill edits the JSON and the deterministic script validates/queries it.

If maintaining a repository source as well, distinguish source from installed
files; synchronize only the intended change within authorization, preserving local
customizations. Future installations must compare/back up a customized config
instead of silently overwriting it with bundled defaults.

- `schemaVersion` is `1`.
- `defaults` has exactly `manager`, `worker`, `liaison`, `subagent`, each with
  `model` and `effort`. Manager's two values remain `null`: user-selected, not an
  instruction to change or clear the current model.
- `modelOrder` is explicit highest-to-lowest scheduling rank, not a benchmark or
  supported-model catalog. A new ID requires an explicit user-approved placement;
  do not infer its rank from a product name. Preserve existing mappings by default.
- Non-Manager defaults must reference that order. The script accepts effort labels
  `low`, `medium`, `high`, `xhigh`, `max`, `ultra`; host support must still be checked.

## Application and precedence

Preserve existing sessions' settings. For new sessions, an explicit user selection
takes precedence over configured defaults, subject to the existing model-ceiling
exception rule and host constraints. Otherwise resolve the configured role.
For subagents, first verify the direct parent's actual model: a lower parent caps
the default at its own model, with an explicit `ceilingAdjusted` result. Effort is
not reduced automatically. Unknown parent rank requires reconciliation, not a guess.

Pass returned `hostFields` through supported native tool fields, not just prompt
text. Check tool restrictions, model/effort availability and fixed-model agent types;
configuration validation does not prove availability. Report unsupported defaults
rather than silently switching versions. No automatic reconfiguration, timers,
MCP callback, global Codex config write or native-call interception is implemented.
Updating these files does not prove already-running agents have reloaded them.
