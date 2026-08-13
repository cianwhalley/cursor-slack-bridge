# My Machines — same disk as Slack

Cursor’s [My Machines](https://cursor.com/docs/cloud-agent/self-hosted-guides/my-machines) worker runs tool calls on hardware you already have. The agent loop stays in Cursor’s cloud; the checkout, credentials, and private network are yours.

That is how IDE / web / iOS “run on your own server” shares a brain with this Slack bridge: **both must use the same hub path.**

## Happy path

1. Hub checkout on the VPS (the same directory as bridge `WORKSPACE`).
2. Cursor CLI logged in with a **personal** API key.
3. Long-lived worker:

```bash
agent worker start \
  --name my-vps \
  --worker-dir /home/you/your-hub \
  --idle-release-timeout 0
```

A systemd unit for this lives in [agent-hub-template](https://github.com/zenmindhacker/agent-hub-template) (`ops/my-machines/`).

4. Confirm the machine at [cursor.com/agents](https://cursor.com/agents).
5. From Cloud / phone: `worker=my-vps repo=you/your-hub pwd` — expect the VPS hostname and that hub path.

The git remote of `--worker-dir` is how Cursor matches `repo=`. Start the worker in the hub (or in a sibling) whose `origin` is the repo you name.

## Why not rely on native Slack + `worker=`

You can trigger My Machines from `@Cursor worker=my-vps …`. That still:

- Uses Cursor’s Slack identity and Cloud Agent UX
- Requires the right `repo=` / channel default every time
- Does not give you a second persona (ops vs family) without more Cloud setup
- Does not run personal-plan Automations on that worker

The bridge skips the flags: every Slack message is already `--workspace $HUB`.

## Dual Unix users (optional)

Some operators run Slack as a locked-down `cursor-agent` and My Machines / ticks as an admin user, with **two checkouts** of the same hub. That is isolation, not a sync mechanism — you must ff-pull both trees. Prefer **one checkout** unless you have a reason. See [example-cleo.md](example-cleo.md).
