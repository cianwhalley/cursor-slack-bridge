# Why this exists

Cursor already has a Slack app. OpenClaw already puts an agent in Slack. This repo exists because neither of those is “the same Cursor agent you already run on a VPS.”

## The problem

If you live in Cursor, Slack usually becomes a *second* brain:

- Native `@Cursor` starts a Cloud Agent. Even with [My Machines](https://cursor.com/docs/cloud-agent/self-hosted-guides/my-machines), you still pass `worker=` / `repo=` (or hope channel defaults are right). Personal-plan Automations cannot target that machine.
- A generic Slack bot (OpenClaw, a homegrown LLM wrapper, a retired container stack) has its own memory, tools, and personality. Skills you wrote for Cursor never fire. Sibling repos on the VPS are invisible.

You wanted one operator: same `SOUL.md`, same skills, same checkouts, whether you typed in the IDE, on your phone, or in Slack.

## What this is

The bridge is not a model router. It is Slack transport around the **headless Cursor `agent` CLI**:

1. Slack event (DM, `@mention`, or thread follow-up).
2. Policy (allowlist, mention, participation).
3. `agent create-chat` / `agent --resume` with `--workspace` set to your hub.
4. Stream-json → one editable Slack draft → last assistant bubble as the reply.

The hub (see [agent-hub-template](https://github.com/cianwhalley/agent-hub-template)) is the brain. Cursor IDE / web / iOS use the same path via a My Machines worker. Scheduling lives in the hub as git, not as N Cloud Automations.

## Vs Cursor native Slack

Native Slack is a good Cloud Agent trigger. Use it when you want “open a PR from this thread” with Cursor’s cards, “Open in Cursor,” and org routing rules.

Use this bridge when:

- Slack should be `@YourName`, not `@Cursor`.
- Every message should land on *this* VPS checkout, including sibling repos the hub cloned.
- You want a scheduler that actually runs on the body (vault, private network, local git state).
- You run more than one persona (ops vs family) on the same machine.

Honest gaps: the bridge does not backfill Slack thread history into the model, does not show Cloud Agent artifacts, and does not implement Cursor’s GitHub/Linear mention routing.

## Vs OpenClaw

OpenClaw is a full assistant framework with many channels. This project assumes you already chose Cursor (subscription, rules, skills, Cloud, iOS). We copied OpenClaw’s *Slack manners* (one draft, tool lines, no thinking leak) so the chat surface feels like a serious operator bot — without switching brains.

## Same workspace

See [workspaces.md](workspaces.md) and [my-machines.md](my-machines.md). Slack and Cloud usually use **separate** hub checkouts of the same remotes (`~/slack-workspace/…` vs `~/cursor-workspace/…`) so agents do not confuse deploy targets. Sibling product repos stay under `~/work/…` and are shared.
