# Block Kit actions (no agent wake)

Optional bridge feature: map Slack button `action_id`s to a **hub shell script**, with optimistic Block Kit rewrites and a serialized job queue.

Product copy, script paths, and action IDs live in **hub config** — not in bridge source.

## Enable

In the instance env (`~/.config/cursor-slack/<name>.env`):

```bash
# Path relative to WORKSPACE, or absolute
BLOCK_ACTIONS_CONFIG=skills/orders-mvp-sync/block-actions.json

# Or inline JSON (same schema)
# BLOCK_ACTIONS_JSON={"groups":[...]}

# Optional: localhost POST http://127.0.0.1:8791/block-actions-test
# BLOCK_ACTIONS_TEST_HOOK=1
```

If unset, the bridge ignores Block Kit actions (agent mentions still work).

## Schema

See [`ops/block-actions.example.json`](../ops/block-actions.example.json) — one or more `groups`:

| Field | Meaning |
|-------|---------|
| `script` | Hub-relative bash entrypoint |
| `secondaryActionId` | Per-row discard / trash |
| `primaryActionId` | Commit / send-all — **ignored while secondary jobs pending** |
| `secondaryArgs` / `primaryArgs` | CLI argv; `{{value}}` `{{channel}}` `{{message_ts}}` |
| `idleRefreshArgs` | After secondary drain, run once (restore primary UI) |
| `optimisticSecondary` | `drop_row_hide_primary` \| `none` |
| `optimisticPrimary` | `replace_working` \| `none` |

## UX contract

Slack cannot disable buttons in place. Recommended pattern:

1. Secondary click → drop that row; **hide primary**; keep other secondary buttons
2. Fast secondary clicks stay allowed
3. When the queue drains → idle refresh restores the list + primary
4. Primary click → replace message with Working…; script publishes the final state

## Test hook

`BLOCK_ACTIONS_TEST_HOOK=1` listens on `127.0.0.1:8791` only:

```bash
curl -s http://127.0.0.1:8791/block-actions-test -H 'content-type: application/json' -d '{
  "action_id": "example_discard",
  "value": "row-id",
  "channel": "C…",
  "message_ts": "…",
  "blocks": [],
  "user_id": "U…"
}'
```
