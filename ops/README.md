# Ops

Production install lives in **[docs/install.md](../docs/install.md)**. This folder is the scripts that doc calls.

| Script / unit | Role |
|---------------|------|
| `bootstrap-service-user.sh` | Create a non-sudo service user + linger |
| `install-bridge.sh` | Clone, build, install `cursor-slack@.service` |
| `cursor-slack@.service` | systemd user template (`%i` = instance name) |
| `env.example` | Per-instance env (copy to `~/.config/cursor-slack/<name>.env`, mode 600) |
| `legacy/cutover-nanoclaw.sh` | Historical NanoClaw → bridge cutover (not part of a new install) |

Multi-instance, My Machines, and the hub template are documented in [docs/](../docs/).
