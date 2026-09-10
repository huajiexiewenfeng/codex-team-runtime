# V2 Worker guided recovery sample

Date: 2026-09-10. Model requested: Sol / medium. Fresh no-history temporary helper;
synthetic fixture only. This is not a native team registration, natural trigger,
compaction experiment, or recall-rate measurement.

## Prompt retained

The helper was given the repository's `skills/manager-session/SKILL.md`, trusted
checkout path, and the following explicit scenario and constraints:

> 隔了一段时间，现在继续团队协作。先告诉我当前登记身份、属于哪个团队、交付要向谁汇报，以及下一步可以做什么。

Fixture identity was explicitly `fixture-host / fixture-worker`; these were test
inputs, not evidence of the helper's real native identity. The optional MCP was
not globally installed. The prompt provided a read-only client command using the
isolated venv and `artifacts/registry-guided-client.py read`. The helper could read
the Skill and public references but not infer identity from implementation or
inspect the fixture JSON directly. Registration, confirmations, edits, native task
creation/messages, installation and timers were excluded. It was asked to return
the public read output and its response, without claiming natural recall.

The client actually starts the stdio server with `--registry`, initializes the SDK
client, checks no server instructions and exactly read/manage tools, calls read,
and checks byte-stable registry content after disconnect. The synthetic registry
was initialized with the product API and contains Manager plus a pending Worker;
no Node state or real task was involved. The local prompt and helper are retained
under artifacts for this run; they are not distributed runtime entrypoints.

## Public read output (selected fields)

```json
{
  "status": "active",
  "registryId": "d6cdcfdc-79a5-40a4-9f2d-fa101805d1c0",
  "registrySchemaVersion": 2,
  "policyRevision": 1,
  "team": {"id":"fixture-team","name":"Isolated registry evaluation","revision":2},
  "member": {
    "memberId":"worker","name":"Backend Worker","role":"Worker","lifecycle":"active",
    "binding":{"hostId":"fixture-host","threadId":"fixture-worker","revision":1}
  },
  "leader": {
    "memberId":"manager","name":"Manager","hostId":"fixture-host",
    "threadId":"fixture-manager","bindingRevision":1,"lifecycle":"active"
  },
  "onboarding":{"status":"pending","evidenceRef":null},
  "executionIntegration":"not-connected",
  "dispatchAllowed":false,
  "identityAssurance":"caller-declared",
  "onboardingReceipt":"v2:01e8901fb5040f4463d74a932f9ed33e46f58b0e3bc85d0653c98f54913f7d71"
}
```

The full returned capsule also contained the six shared recall/authority rules
and three Worker duties (own authorized assignment, own durable submission and
the existing submission-notice route to the exact Manager).

## Helper's scenario response

> 当前登记身份是 `Backend Worker`（memberId `worker`，角色 `Worker`），属于 `Isolated registry evaluation` 团队（`fixture-team`）。交付应向确切负责人 `Manager`（memberId `manager`，`fixture-host / fixture-manager`）汇报。
> 下一步可先由 Manager 核验并记录我的 onboarding receipt；之后还需另行确认当前任务及授权，我只能处理明确分配且已授权的任务。当前 registry 仅提供上下文，`dispatchAllowed: false`，不能据此自行接续或派发工作。

The helper returned the actual receipt; it did not confirm itself or send to a
native member. This demonstrates one guided application of the all-member
contract. It does not prove future invocation, comprehension, message delivery,
strong identity authentication, or a connected execution/acceptance loop.
