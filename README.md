# OpenCode Home Assistant Add-on Repository

A Home Assistant add-on repository providing **OpenCode** — an AI coding agent
for editing your Home Assistant configuration, with a built-in safety guardian
that automatically backs up `/config` before every change and reverts if you
don't confirm within a configurable timeout.

## Add this repository to Home Assistant

In Home Assistant, go to **Settings → Add-ons → Add-on Store**, click the
**⋮ menu (top right) → Repositories**, and add:

```
https://github.com/sahelea1/ha-opencode-addon
```

After adding, the **OpenCode** add-on will appear in the add-on store under
this repository.

## Add-ons

| Add-on | Description |
|---|---|
| [OpenCode](./opencode) | AI coding agent with `/config` safety guardian |

See the add-on's own [README](./opencode/README.md) for full setup and
architecture details.
