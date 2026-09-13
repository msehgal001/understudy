# Understudy

An offboarding agent that removes a departing employee's access across GitHub,
Google Drive, Linear and Slack — and then independently proves it actually
happened.

The premise is narrow and it is the whole project: **a write that returns `204`
has not told you that access is gone.** It has told you that one API call
succeeded. Access is frequently held through more than one path at once, and the
response body of a write never mentions the paths it did not touch. An agent that
trusts its own writes will report a clean offboarding over an account that can
still push to production.

Understudy never trusts a write. Every claim is re-read from the live API by a
verify phase that has no access to the write it is checking, and an eval harness
measures how often the agent's report and reality disagree.

The headline number is the **silent failure rate**: runs where the agent claimed
success and independent ground truth said otherwise.

```
silent failure rate      0.0%     over 13 scenarios, both planner arms
silent failures caught   37       naive baseline · 11 with the claude-sonnet-5 planner
silent failures missed   0
task success rate        100.0%
rollback correctness     1/1
mutants killed           3/3      the suite goes red when a safety check is broken
```

The last line matters more than the first. A silent failure rate of zero is only
worth reading if the suite could have reported something else, so `npm run
eval:mutation` breaks each safety check on purpose and requires the suite to
notice. See [Mutation testing](#mutation-testing-proving-the-eval-can-fail).

---

## The reliability architecture

### 1. Postconditions re-read; they never inspect the write

Every write is an `Action` with `preconditions` and `postconditions`. A
postcondition answers its question by calling the API again.

The precise claim, because the loose version of it does not survive contact with
a reviewer: **TypeScript cannot prevent a postcondition from closing over the
write's response.** If an `Action` were one object literal, `apply` and
`postconditions` would share a scope and a captured variable would compile
happily. What actually holds is structural, and it is testable:

- Postcondition factories live in `src/checks/postconditions.ts`, a module that
  imports nothing from `src/actions/`. They receive an adapter and a resource
  identity. There is no write response in lexical scope to capture.
- `src/checks/postconditions.spy.test.ts` runs every factory against a spy
  adapter and **fails any check that returns a verdict without issuing at least
  one read.** A check that answered from memory would not survive CI.

That is separation plus a test, not typed impossibility.

One nuance worth stating: a *created* resource can only be re-read once you know
its id, so `linearIssueExists` takes an id *provider*. Using the write's response
to locate a resource is fine; using it to decide pass/fail is not.

### 2. Discovery composes grant paths; the permission endpoint is the oracle

GitHub's permission endpoint returns the highest role calculated across
repository, team, organization and enterprise — and documents no way to tell
which of those produced the answer. So the two questions get two different
sources:

- **The discoverer** is the enumeration endpoints. Direct collaborators
  (`?affiliation=direct`), repo teams crossed with team membership, and the org's
  `default_repository_permission`. Together they say *why* someone has access.
- **The oracle** is `GET /repos/{o}/{r}/collaborators/{u}/permission`. It answers
  only *whether effective access survived*.

Discovery records `{ resource, permission, path }` where path is one of `direct`,
`team:<slug>`, `org-base`, `link-sharing:anyone`, `group:<email>`. The grant path
is the output, not the grant.

### 3. The shadow adapter models paths, not booleans

Each of the four apps has a `LiveAdapter` and a `ShadowAdapter` behind one
interface. Shadow is seeded from real live reads at run start and simulates
writes in memory with the same return shapes, including realistic success
envelopes — a bare `204`, Linear's `{ success: true, issue }`, Slack's
`{ ok: true, ts }`. Selecting between them is a single switch in
`src/adapters/registry.ts`; actions, checks and the agent cannot tell which they
hold.

Crucially, shadow reproduces the *traps*. `removeCollaborator` deletes only the
direct record and leaves team-derived admin standing, exactly as the real API
does. If shadow flipped a `hasAccess` boolean, rehearsal would show a clean diff
that commit then contradicts — worse than no rehearsal at all.

Live and shadow also raise the **same error types** (`RateLimitError`,
`TimeoutError`), so retry and rollback behaviour cannot diverge between rehearsal
and commit.

### 4. Six phases

`discover → plan → rehearse → approve → commit → verify`

- **discover** — read-only enumeration across four apps, composing grant paths.
- **plan** — `claude-sonnet-5` emits a schema-validated plan through one forced
  tool call. The model picks operations from a whitelist; it never constructs an
  `Action`, never chooses a postcondition, and never sets `reversible`. Those are
  properties of the operation, so a persuasive plan cannot talk its way past an
  approval gate. **Transfer-before-revoke ordering is enforced in code** after the
  model answers — a violating plan is rejected and re-planned with the violation
  quoted back.
- **rehearse** — every action against shadow, producing a full diff. Nothing
  touches production.
- **approve** — blocks on any action with `reversible: false`.
- **commit** — live, with idempotency keys recorded **before** the call so a crash
  between the write and the record cannot replay it. Any failure rolls back
  completed actions in reverse order.
- **verify** — independent live re-read of every postcondition. Failures generate
  remediation and re-enter commit, bounded at two rounds, after which the run is
  marked `unresolved` loudly. An agent that loops forever is another way of lying.

Four honest details in the executor:

- **A planned action that never ran is not a success.** Preconditions that
  refused, writes that failed, and approvals withheld all make the run
  `unresolved`, even when every evaluated postcondition passed. (The eval caught
  this; it was a real bug.)
- **An approved irreversible action cannot be rolled back.** Rollback reports it
  as `irreversibleLeftInPlace` rather than pretending. That is precisely why it
  required a human first.
- **Remediation is deterministic, not a model call.** The failed postcondition's
  observed value already names the surviving path, so the fix is a lookup — and a
  lookup cannot hallucinate a repo name at the exact moment the system is trying
  to prove it is honest.
- **"Could not check" is not "checked and failed".** When a read cannot be
  performed at all — almost always a missing credential scope — the check is
  recorded as `unverifiable` rather than failed. It blocks `verified`, because
  unknown is not success, but it does not feed remediation and is not counted as a
  detected failure. Collapsing the two is its own kind of lie: one says "access
  still stands", the other says "nobody knows". This was found live, via a Slack
  token that could post but not read back — and the adapter had been returning an
  empty message list on API error, quietly turning "I could not look" into "it is
  not there".

A failed **notification** is also handled separately from a failed write:
rolling back a completed set of revocations because a Slack post 404'd would hand
the departing employee their access back in order to fix a reporting problem.
`notify` actions that fail are recorded, the run continues, and the run ends
`unresolved`. Revocations and transfers still roll back. Both halves are pinned by
tests in `src/core/executor.test.ts`.

### 5. Tracing and the judge

Every model call, tool call, phase transition, precondition and postcondition is
appended to a JSONL trace with timestamps, durations, token counts and the
**observed value** of every check. That file is the artifact the eval scores.

The trace judge (`claude-opus-5`) answers one question: was the goal achieved, or
did the agent merely report that it was. It is given the trace with the agent's
own `summary` and `rationale` fields **stripped**, because the summary is the
artifact under suspicion. Verdict is `achieved` / `partial` / `reported-only`
plus a list of discrepancies.

---

## The seeded failure

The demo org is provisioned by `npm run seed:github`, which is idempotent and
re-asserts the fixture before every demo rather than assuming a clean slate.

A correction to the original brief, which specified org-member removal returning
204 while access persists: **that does not reproduce.** GitHub cascades org
removal to team memberships and ends repository access. The authentic version:

```
DELETE /repos/{org}/{repo}/collaborators/{user}      → 204 No Content
GET    /repos/{org}/{repo}/collaborators/{user}/permission
                                                     → { "permission": "admin" }
```

The fixture seeds **two independent paths**, on purpose:

1. `team:payments` holds **admin** on the repo and the departing user is a member.
   Removing their direct-collaborator record returns 204 and leaves admin
   standing. A naive plan walks into this.
2. The org's `default_repository_permission` is **write**, so every member has
   write on every repo with *no collaborator record and no team record to
   delete*. No per-repo action can close it. The only per-user fix is removing org
   membership, which is irreversible and stops for approval.

Path 2 is why the catch is **reproducible on every run rather than a lucky
accident** — it does not depend on the model being careless. A better plan closes
path 1 and still cannot close path 2.

### Confirmed on live GitHub

Against a real org, with `claude-sonnet-5` planning and approval withheld on the
irreversible action:

```
$ npm run seed:github && npm run offboard -- --mode=live --deny

  ── SILENT FAILURE CAUGHT ──

  msehgal-builds has no effective access to msehgal-org/payments-core   STILL OPEN
    the write said   204  (success)
    the re-read said write
    surviving path   org-base
    effective permission is "write" via org-base

  ── COULD NOT VERIFY ──
  these are not failures. nobody knows, and unknown is not success.

  a message containing "offboarding:msehgal-builds" is present in U0C1DBVE77X
    could not verify: slack conversations.history: missing_scope

  status     UNRESOLVED
  actions    3 applied, 0 skipped (idempotent), 0 failed
```

A real `204 No Content` from `DELETE /repos/.../collaborators/...`, followed by a
real `GET .../permission` still returning `write`. The model had planned the team
removal, so path 1 never fired — path 2 caught it anyway, which is exactly what it
is there for.

---

## Failure modes the eval covers

13 frozen fixtures in `src/eval/scenarios/`, each a complete `WorldState` plus a
hand-authored known-correct end state. They run against `ShadowAdapter`, so the
suite is fast and deterministic.

| # | Scenario | What it proves |
|---|---|---|
| 01 | Inherited team access | The headline silent failure: 204 while admin persists via `team:payments` |
| 02 | Org base permission | Access with no collaborator and no team record — unclosable per-repo |
| 03 | Drive link sharing | `anyone with the link` is a separate ACL record and survives the user's removal |
| 04 | Mid-commit timeout | Rollback undoes completed work in reverse order, leaving no partial state |
| 05 | Rate limited | 429 + Retry-After produces a backoff and a real write, never a phantom success |
| 06 | Stale cache | A read returning pre-revocation state must not fool verify in either direction |
| 07 | Sole-owner Drive file | Ownership transfers before access is revoked, or the file is orphaned |
| 08 | Successor also departing | The transfer is refused rather than laundering the problem onto someone leaving |
| 09 | Irreversible needs approval | With approval withheld the action does not run — and the run says so |
| 10 | Idempotent replay | Re-running a completed run writes nothing twice |
| 11 | Two surviving paths | Closing one inherited path is not enough; remediation loops until a re-read agrees |
| 12 | Happy path | No false positives when there is nothing hidden |
| 13 | Dormant team membership | A team with no repo grants is invisible to every access check and is still a latent grant |

### Why the number means anything

`src/eval/oracle.ts` computes ground truth. It **never calls a `Check` the agent
uses**, never imports `src/checks/`, and never reads the agent's summary. It
re-implements GitHub's permission resolution a second time, deliberately, in a
separate module from the shadow adapter's copy.

That duplication is the point. If both sides shared one function, a bug in it
would make the agent's checks and the ground truth agree with each other while
both were wrong, and the silent-failure number would be measuring nothing but its
own reflection.

### Measured results

Two arms, and `npm run eval` runs both. The **naive baseline** plans the obvious
way and leaves inherited grants standing, so verify has real work to do. The
**model arm** replays recorded `claude-sonnet-5` plans, which resolve grant paths
during planning and usually leave nothing behind.

```
$ npm run eval

UNDERSTUDY EVAL  naive-baseline · replay · 13 scenarios

  PASS  01-inherited-team-access       verified     caught:3
  PASS  02-org-base-permission         verified     caught:3 blocked:1
  PASS  03-drive-link-sharing          verified     caught:3
  PASS  04-commit-timeout-rollback     rolled-back
  PASS  05-rate-limited                verified     caught:3
  PASS  06-stale-cache                 verified     caught:3
  PASS  07-drive-sole-owner            verified     caught:3
  PASS  08-successor-also-departing    unresolved   caught:3
  PASS  09-irreversible-needs-approval unresolved   caught:5 blocked:3
  PASS  10-idempotent-replay           verified     caught:3
  PASS  11-two-surviving-paths         verified     caught:4
  PASS  12-happy-path                  verified
  PASS  13-dormant-team-membership     verified     caught:4

  task success rate        100.0%
  silent failure rate      0.0%   (claimed success, ground truth disagreed)
  silent failures caught   37     (write reported success, re-read disagreed)
  silent failures missed   0
  blocked by design        5      (action never ran; the approval gate holding)
  rollback correctness     1/1 (100.0%)

NAIVE vs MODEL
                            naive       model
  silent failures caught    37          11
  silent failures missed    0           0
```

Live wall-clock, measured against the real GitHub org, Drive, Linear and Slack:
**~89s and ~$0.034 per run**. The per-scenario millisecond timings the replay
harness reports are the harness, not the agent, so they are deliberately not
quoted as latency anywhere in this project.

**`caught` and `blocked by design` are different things and used to be added
together.** A verify postcondition that fails because the human withheld approval
is the gate working, not a lie detected: the write never ran, so nothing claimed
success. Only a check that fails *after* a write reported success counts as a
caught silent failure. Conflating them inflated the headline with the opposite of
a failure, and `src/eval/run-scenario.ts` now separates them by requiring a
successful `commit:applied` event for the action before counting a catch.

**The `caught` number depends on how good the planner is, and that is the
interesting part.** The naive baseline catches 37 surviving grants, because a
literal-minded plan closes the record it can see and leaves every inherited path
standing. `claude-sonnet-5` catches 11, because it reads the grant paths from the
survey and plans the team removals up front. Both end at zero missed.

Verify is not there because the model is careless. It is there because some
failures are structural: `org-base` grants have no per-repo action to plan, and
the only fix is irreversible and stops for a human. A better planner moves the
catches; it does not remove the need for them.

<a id="mutation-testing-proving-the-eval-can-fail"></a>
### Mutation testing: proving the eval can fail

An eval that cannot fail measures nothing. The suite reported a silent failure
rate of zero for most of this project's life, and that number was decoration
until it was tested.

`npm run eval:mutation` breaks one safety check at a time, forcing it to return a
clean pass without looking at what it read, and requires the suite to go red. A
mutant that **survives** means no scenario's ground truth depends on that check,
so a green run proves nothing about it.

```
$ npm run eval:mutation

MUTATION TESTING  break a check on purpose; the eval must go red

  KILLED    gh.no-access           GitHub effective-access check always passes
  KILLED    gh.not-team-member     GitHub team-membership check always passes
  KILLED    drive.no-access        Drive access check always passes

  3/3 mutants killed
```

It did not start at 3/3. The first run killed two and `gh.not-team-member`
survived, which exposed a real hole in the product rather than the test:

- Team membership was only ever **discovered** by walking repositories and
  reading their team grants. A team with no repository grants produces no
  repo-team record, so it was invisible to discovery entirely.
- Goal checks covered repo access and Drive files, never team membership.

So a departing employee left on a dormant team passed every check. The day
someone attaches a repository to that team, a person who left months ago has
access again. Fixed in `src/core/discover.ts` by enumerating the org's teams
directly, in `src/core/goals.ts` by adding a membership goal per discovered team,
and in `src/core/remediate.ts` by closing one when verify finds it. Scenario 13
pins it, and the mutant now dies.

### What the live run cost me

The 12-scenario recording pass against `claude-sonnet-5` cost **$0.49** and took
about 18 minutes wall-clock. After that the suite replays for free in ~50ms.

### Bugs the eval and the live runs found in this codebase

Worth naming, because an eval that never fails its own author is decorative. Every
one of these is the same mistake in a different costume — trusting something that
reported success:

The last three were found on the day of the deadline, by an adversarial audit and
by mutation testing, and they are the most instructive ones here.

0a. **The eval itself could not fail.** Forcing the headline check
   `githubNoEffectiveAccess` to return a clean pass changed nothing: all scenarios
   still passed and the silent failure rate stayed at 0.0%. The recorded Sonnet
   plans already closed every inherited path before verify ran, so the check never
   had anything to catch and a broken check was indistinguishable from a working
   one. The suite now runs a **naive baseline arm** where verify has real work, and
   `npm run eval:mutation` fails the build if any safety check can be broken
   without the suite noticing.

0b. **A team-derived `write` grant was invisible to rehearsal in live mode.**
   GitHub returns repo-team permissions in its legacy vocabulary (`pull`/`push`)
   while role names use the modern one (`read`/`write`). The world ranks only the
   modern set, so an un-normalised `push` fell out of the rank table as `undefined`
   and compared as no access at all. The eval never caught it because the eval's
   "live" adapter is itself a shadow, so the live adapters had no contract test.
   `src/adapters/github/vocabulary.test.ts` is now that contract, in both
   directions — GitHub also rejects `write` on the collaborators endpoint, so
   rolling back a removal would have failed too.

0c. **A dormant team membership was invisible to everything.** Described under
   [Mutation testing](#mutation-testing-proving-the-eval-can-fail): team membership
   was discovered only by walking repositories, so a team with no repository grants
   was never seen, and no goal check covered membership. A departing employee left
   on that team passed every check and would silently regain access the moment the
   team was given a repo.

0d. **The audit issue was filed at an address the model invented.** On a live run
   Sonnet filed the Linear audit issue into a team called `payments` — the GitHub
   team slug, which does not exist in Linear. The precondition caught it and the
   run ended `unresolved`, so nothing was written to the wrong place, but this was
   never the model's decision to make. The destination now comes from
   `LINEAR_TEAM_ID` or is resolved from the workspace, the same rule already used
   for the Slack channel and the transfer recipient, and `npm run preflight`
   checks it resolves before a run starts.

1. **A skipped action was reported as success.** A precondition correctly refused
   to transfer a file, and the run still finished `verified`. Preconditions that
   refuse, writes that fail, and withheld approvals now all force `unresolved`.
2. **An irreversible transfer trusted the model's choice of recipient.** With the
   successor deliberately misconfigured as the departing employee, Sonnet did not
   refuse — it invented a recipient, `<UNKNOWN>`, and transferred the file there.
   The distinctness precondition passed, because `<UNKNOWN>` is indeed distinct
   from the departing address. Narrowing the check would have been chasing the
   symptom; the recipient of an irreversible transfer now comes from configuration
   and a plan that names anyone else is refused.

3. **A non-2xx response was recorded as "applied".** Slack answers `200 ok:false`
   for application errors, which the adapter maps to 400 — and commit logged it as
   an applied action with a green `400` beside it. A write is applied when the API
   says it succeeded, not when the call returns.
4. **The planner chose the notification channel.** It picked `#offboarding` while
   `SLACK_CHANNEL` pointed elsewhere, and the post failed. Same fix as the transfer
   recipient: configuration decides, the plan does not.
5. **The seed script claimed "INVITATION SENT" without checking the write.** The
   `PUT` 404'd on a misspelled username and the script reported success anyway —
   in the very script that provisions the demonstration of unchecked writes.
6. **A missing credential crashed the process instead of degrading.** An empty
   `GOOGLE_OAUTH_CREDENTIALS` threw inside `JSON.parse` before discovery started.
   Drive now degrades out of the run explicitly, and an unconfigured integration
   reports `unverifiable` rather than looking like an empty account.
7. **Tool input was assumed to match its schema.** `decisions` arrived once as a
   JSON *string* instead of an array, and `.filter` threw deep inside the planner,
   costing the whole run. Input is normalised before use now, with tests for each
   shape observed (`src/agent/loop.test.ts`).
8. **The planner invented a Linear team id**, and the write came back `Argument
   Validation Error`. A precondition now confirms the team exists, turning a hard
   failure into an honest refusal that names the bad id.

9. **Replay protection was dead code that looked alive.** Idempotency keys were
   stored against `run_id` and looked up with `run_id LIKE '%<login>%'` — a run id
   is `run-<timestamp>` and never contains the login, so the query returned zero
   rows on every live run. Keyed by target now, with regression tests.
10. **Repository names arrived org-qualified.** The survey prints
    `acme-co/payments-core`, so the model supplied it back that way, producing
    `/repos/acme-co/acme-co%2Fpayments-core/...`. Every precondition failed, the
    revoke never ran, and the run still reported its evaluated postconditions
    passing. Normalised in the builder — telling the model not to do it works most
    of the time, and most of the time is not a reliability property.
11. **Redundant verification reads.** Two actions on one Drive file share a
    postcondition, and a goal check asks the same question a third time — so one
    finding was reported three times and billed three API calls. Each distinct
    question is now asked once per round.
12. **The eval harness corrupted its own fixture.** Scenario 10 executes twice to
    prove replay protection, and during recording the second pass — planning
    against an already-offboarded world — overwrote the first pass's recorded plan
    with an empty one. First write wins now.

The pattern across 3, 4, 5, 8 and 10 is one thing: **anything that identifies a
resource — a recipient, a channel, a team, a repository — is configuration or
discovery, never a planner decision.** The model chooses what to do, not what to
do it to.

The first two were caught by the oracle disagreeing with a run that claimed
success; the rest by running against real APIs. That is the entire thesis, applied
to its own implementation.

### One trace file per run

`src/core/trace.ts` used to open the JSONL stream in append mode while the eval
reused a run id per scenario, so a single file accumulated many runs. The trace
viewer and the Opus judge then read a stale, self-contradictory history and scored
an execution that had not happened. The stream is truncated on open.

### Verification is goal-based, not action-based

The most consequential finding. A scenario had the plan transfer a sole-owned
Drive file to the successor and then never remove the departing employee's own
permission on it. **Every postcondition passed** — postconditions check that the
actions taken landed, and an action that was never planned has no postcondition to
fail. The agent reported a clean offboarding over a file the departing employee
could still open.

`src/core/goals.ts` closes that hole. Verify now also evaluates checks derived
from **discovery**: every access path found at the start must be gone at the end,
whether or not the plan addressed it. The question is "does this person still have
access", not "did my writes succeed". Goal checks that duplicate an action's own
postcondition are skipped, so the same question is not asked twice.

Adding them took caught silent failures in the suite from 4 to 10 with no change
to the agent — those were omissions the harness previously could not see.

One deliberate restraint: a surviving **owner** permission is never auto-remediated.
Deleting the only owner's access orphans the file, and the fix would be worse than
the finding. It stays failing, and the run stays unresolved, visibly.

### Why the planner uses structured outputs, not a tool call

This started as a forced `tool_choice` against a `submit_plan` tool — the shape
most agent code reaches for. It was measurably unreliable. Roughly two calls in
five returned a well-written `summary` and an **empty** `decisions` array: a
confident narrative over no plan at all, which is precisely the failure this
project exists to refuse. Reordering the schema so `decisions` generated before
`summary` helped the symptom and did not fix the cause.

Measured on one scenario and prompt:

```
forced tool call      3/5  usable on the first attempt
structured outputs   11/11 usable on the first attempt
```

The reason is semantic. Nothing here is a tool — the model is not taking an
action, it is returning data. `output_config.format` constrains generation to the
schema; a forced tool call only hopes the result comes back well-formed. `params`
is typed as a JSON *string* because structured outputs require
`additionalProperties: false` throughout, which a free-form parameter bag cannot
satisfy; `normaliseDecisions` parses it back along with every other shape the
model has been observed to emit.

The retry logic remains as a safety net. It no longer fires.

### The trace judge, both directions

```
$ npm run offboard -- --scenario=01-inherited-team-access --yes --skip-verify --judge
  verdict   reported-only (high confidence)
  "…the verify phase was skipped entirely (seq 83 'verify:skipped'), so not a
   single committed write was independently re-read against live state."

$ npm run offboard -- --scenario=09-irreversible-needs-approval --yes --judge
  verdict   achieved (high confidence)
  "…the two round-0 failures observing permission:'write' surviving via org-base
   were diagnosed, remediated, and independently re-read as permission:'none'."
```

About $0.10 per verdict on `claude-opus-5`. The judge also found a traceability
hole nobody asked it to look for: approvals were being granted with no event
recorded in the trace. That is fixed — an approval gate that leaves no evidence
is not an audit trail.

---

## Setup

```bash
npm install
cp .env.example .env     # then fill it in
npm run preflight        # every required row must be green
```

`.env` keys: `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `GITHUB_ORG`,
`DEPARTING_GITHUB_LOGIN`, `DEPARTING_EMAIL`, `SUCCESSOR_EMAIL`,
`SUCCESSOR_GITHUB_LOGIN`, `GOOGLE_OAUTH_CREDENTIALS`, `LINEAR_API_KEY`,
`SLACK_BOT_TOKEN`, `SLACK_CHANNEL`.

### Two things that will block a live demo

1. **Token scopes.** Seeding the fixture creates teams and manages org
   membership; remediation removes a team member. A `repo, read:org` token cannot
   do any of it.

   ```bash
   gh auth refresh -h github.com -s admin:org,repo
   gh auth token        # → GITHUB_TOKEN
   ```

2. **The org invitation must be accepted.** Adding someone to an org creates a
   *pending* membership until they click a link in an email. A pending member
   holds no team-derived grant, so the fixture cannot exist and there is nothing
   for verify to catch. `seed:github` detects this and stops with instructions
   rather than failing a confusing assertion later.

```bash
npm run seed:github      # idempotent; run it before every demo
```

### Google Drive

```bash
npm run google:auth <client_id> <client_secret>   # one-time; writes google-oauth.json
npm run seed:drive                                # idempotent Drive fixture
```

The OAuth client is a **Desktop app** in a Google Cloud project with the Drive API
enabled and your account listed under *Audience → Test users*. The flow requests
`access_type=offline` with `prompt=consent`, because without the latter a
re-authorisation returns an access token only and the credential file is useless
the next day.

`seed:drive` creates a folder (`understudy-demo`) and two Google Docs inside it:
one shared with the departing employee as a writer, and one shared with them *and*
published `anyone with the link`. It only ever touches files it created.

Two honest limits. The agent authenticates as the successor rather than the
departing employee, so no live file is *owned* by the departing account — the
sole-owner transfer case stays covered by the eval fixtures, since standing it up
live needs Workspace admin with domain-wide delegation. And `listFilesSharedWith`
returns everything shared with that address, so point `DEPARTING_EMAIL` at an
account with nothing real shared to it. Run the discovery check before the first
live Drive run and read what comes back.

---

## Running it

```bash
npm run eval                                        # replays recorded plans — free, ~50ms
npm run eval -- --live                              # re-plan against claude-sonnet-5 (~$0.49, ~18 min)
npm run eval -- --record --only=03                  # re-record one scenario
npm test                                            # spy-adapter + ordering tests

npm run offboard -- --scenario=01-inherited-team-access --yes
npm run offboard -- --mode=live                     # interactive approval prompts
npm run offboard -- --mode=live --yes --judge       # + claude-opus-5 trace verdict

npm run dev                                         # console at localhost:3000
```

Useful flags: `--skip-verify` deliberately disables the verify phase, which is how
you demonstrate that the trace judge notices — a judge that only ever says
"achieved" is untested.

### The console

Six routes matching the phases, a trace inspector, and an eval dashboard, with
run progress streamed over server-sent events.

- `/` — run history, plus a launcher that streams a run live
- `/run/<id>/rehearse` — the rehearsal diff: what the plan removes, and what is
  **still standing after the plan**, with the grant path named
- `/run/<id>/verify` — the catch: what the write said (`204`) next to what the
  independent re-read said (`admin`), the surviving path, the remediation, and the
  raw trace lines
- `/trace/<id>` — the full structured trace
- `/eval` — the report, rendered

---

## Layout

```
src/
  adapters/      four apps × {live, shadow} behind one interface; registry.ts is the switch
  core/          action contract, six-phase executor, rollback, tracing, world model, SQLite
  actions/       the operation whitelist — reversibility and postconditions live here
  checks/        pre/postconditions; imports nothing from actions/, by design
  agent/         planner (sonnet-5), trace judge (opus-5), deterministic stub planner
  eval/          scenarios, harness, and the independent oracle
  app/           Next.js console
scripts/         seed-github, preflight, offboard, eval, build-scenarios
```

## Notes on what is not here

- UI primitives are hand-rolled Tailwind rather than shadcn/ui — the design is
  bespoke enough that the component library would have been setup cost without
  payoff at this scale.
- `better-sqlite3` is the persistence layer. If its native build ever fails,
  `node:sqlite`'s `DatabaseSync` exposes the same `exec`/`prepare` surface and
  only `src/core/db.ts` changes.
- Drive is the one adapter whose live path is hardest to stand up (OAuth refresh
  token). Everything else degrades to fixtures cleanly if a credential is missing;
  `preflight` tells you which.
- Slack uses a **bot** token (`xoxb-`) with `chat:write` and `channels:history`.
  Both scopes matter: without the second the report posts but cannot be read back,
  and the run correctly ends `unresolved` with "could not verify" rather than
  claiming success. The bot must also be invited to the channel — unlike a user
  token it does not inherit your membership.
- The planner is `claude-sonnet-5` and the judge is `claude-opus-5`, per spec.
  Plans are recorded to `src/eval/recorded-plans.json` so the suite is
  reproducible; delete an entry and re-run with `--record` to refresh it.
