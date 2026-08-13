# Example: two agents on one VPS

This is a production-shaped story with the private bits removed. Names are personas, not a requirement.

## Layout

One VPS. One bridge install. Two Slack apps. Two hubs.

| | Ops agent | Family agent |
|---|-----------|----------------|
| Slack | `@Ops` (or whatever you named the app) | `@Family` |
| systemd | `cursor-slack@ops` | `cursor-slack@family` |
| Env | `~/.config/cursor-slack/ops.env` | `~/.config/cursor-slack/family.env` |
| Hub | `~/workspaces/ops-agent` | `~/workspaces/family-agent` |
| Siblings | Client / company repos in that hub’s `repos.json` | School / home repos in *that* hub’s `repos.json` |
| Channel policy | Often `any` + a tight allowlist | Often `configured` + a couple of channels |

My Machines can be one worker (`repo=` selects the hub by git remote) or two workers. Slack does not share session DBs.

## Isolation we actually use

Interactive Slack runs as a dedicated Unix user (`cursor-agent`, no sudo). Cloud worker + scheduled ticks may run as the host admin so they can reach Docker / vault on loopback. That implies **two checkouts** of a hub unless you symlink.

That split is optional. The community default is **one checkout** for Slack and My Machines. Dual trees are extra isolation, and you must ff-pull both.

## What we do not publish

Hostnames, Slack user/channel IDs, vault names, client repo lists, and personal memory files. Copy the *shape*, not someone else’s brain.

## NanoClaw

If you used a container Slack face on the same bot token, stop it before starting this bridge (one Socket Mode consumer per app). A historical helper lives at `ops/legacy/cutover-nanoclaw.sh`. New installs ignore it.
