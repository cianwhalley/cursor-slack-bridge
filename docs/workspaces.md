# Workspaces — one hub per agent, many repos

The Slack bridge does not clone your company. It points Cursor at a **hub**. The hub is allowed to check out other git repos and keep them current. Slack and Cursor share that disk, so either UI can operate the fleet.

## Hub vs siblings

| | Hub | Siblings |
|---|-----|----------|
| What | The agent’s brain | Code and docs the agent may touch |
| Contains | `SOUL.md`, `AGENTS.md`, `.cursor/rules`, skills, `config/repos.json`, optional `schedules/` | Application / docs repos |
| Bridge `WORKSPACE` | This path | Not the `WORKSPACE`; listed in `repos.json` |

Starter layout: [agent-hub-template](https://github.com/cianwhalley/agent-hub-template).

## Instance = Slack app + env + hub path

```
~/.config/cursor-slack/ops.env      WORKSPACE=…/workspaces/ops-agent
~/.config/cursor-slack/family.env   WORKSPACE=…/workspaces/family-agent
```

Not in-process routing. Two bots, two hubs, two `repos.json` files. An ops agent never sees the family checkouts unless you put them in its registry.

## Hygiene contract

These rules live in the hub (Cursor always-apply + skills), so **Slack-spawned and My Machines sessions both follow them**:

1. Start of turn: `scripts/repo-monitor.sh` (ff-pull / clone missing when safe).
2. Before focusing a sibling: sync that name.
3. After *your* edits: `ship-work` (feature branch → PR). Do not leave dirt.
4. Never force-reset a dirty or diverged tree you did not create.
5. Optional Graphify index; always gitignore `graphify-out/`.

A scheduled `repo-hygiene` job (every few hours) does the same keep-warm. Slack once if something needs a human; silent on clean pulls. See [scheduling.md](scheduling.md).

## GitHub auth on the VPS

Prefer an SSH key for the service user (`ssh -T git@github.com`). HTTPS + a PAT file is the fallback (`HUB_GITHUB_TOKEN_FILE`). Do not commit tokens.

## What the bridge does *not* do

No special Slack command to “switch repo.” You ask the agent in natural language; it uses the hub skills and the checkouts on disk. If a repo is not in `repos.json` and not cloned, the agent should clone it via the hub scripts — or tell you it is missing.
