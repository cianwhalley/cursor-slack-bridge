# Credentials

The bridge itself needs three secrets in the instance env (mode 600):

- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`
- `CURSOR_API_KEY`

That is enough for Q&A against the hub (the agent uses whatever tools Cursor already has for that user).

## Optional: Agent Vault

When hub *skills* need OAuth or API keys on the VPS (mail, issue trackers, billing), run a secrets proxy on loopback rather than stuffing every token into the Slack env.

[Infisical Agent Vault](https://infisical.com/docs/documentation/getting-started/agent) (or equivalent) on `127.0.0.1:14321` is the pattern we use: the My Machines worker and tick scripts call `vault_run` / `agent-vault run` so secrets are injected into child commands and never printed.

Do **not** put the vault on a public URL. Bind loopback, plus Tailscale if the laptop must reach it.

The Slack **Node process must not** run under `agent-vault run`. Process-wide `HTTPS_PROXY` breaks the Cursor agent CLI (HTTP/2 ALPN — `tlsv1 alert no application protocol`, SSL alert 120). `ops/run-bridge.sh` sources hub `vault-env.sh` so STT can make a **one-shot** `agent-vault run -- curl` to OpenRouter. Hub skills still `source vault-env.sh` themselves. Slack tokens stay out of the agent child (`src/agent-runner.ts` also strips proxy env).

Start without a vault. Add one when a skill actually needs it.
