# Approvals

Ethan asks for approval by ending a reply with one line:

```
APPROVAL_REQUEST: {"approver":"U0123456789","summary":"wipe user ada"}
```

The bridge strips that line, stores the request against the original channel and thread, and DMs Approve / Deny to `approver`. Only that Slack user id can decide. If `APPROVER_USER_ID` is set, the trailer and the click must both be that user.

A click resumes the same OpenCode session in the original thread with an `[approval event]`. The decision is evidence for the hub policy. It does not grant a new credential.

This is separate from `BLOCK_ACTIONS_CONFIG`, which runs a hub script and does not wake the agent.
