---
name: workbuddy-bridge
description: Check, repair or remove the WorkBuddy model bridge that puts subscription models in the Codex model picker. Use when the user asks why WorkBuddy models are missing from the picker, wants to know if the bridge is running, or wants to roll back to the official subscription.
---

# WorkBuddy bridge

This plugin is the on/off switch for a local gateway that exposes the user's
WorkBuddy subscription models inside the Codex model picker. The gateway is a
separate Node process listening on `127.0.0.1:10100`; the plugin's MCP server
starts it when a session begins and stops it when the plugin shuts down.

## Checking state

Call `wb_status`. It answers whether the gateway is up and how many models it
exposes. Call `wb_models` to see the actual model ids and display names.

If `wb_status` says it is not running, the gateway did not come up. Common
causes, in order:

1. The Node process could not find the bridge checkout. The plugin is
   materialised into `~/.codex/plugins/cache/...`, so it resolves the checkout
   from the install record at `~/.wb-bridge/install.json`, or from
   `WB_BRIDGE_HOME` if set. Read `~/.wb-bridge/plugin.log` — it records the
   resolved path and any spawn error.
2. No usable credential. The bridge reads what the WorkBuddy desktop app left
   on disk; the user needs to have signed in to WorkBuddy at least once.
3. Port 10100 is occupied by something else.

## Rolling back

`wb_restore` removes the bridge's two injected lines from
`~/.codex/config.toml`, restores the backup taken on first run, and deletes the
generated model catalog. It does not uninstall the plugin — that is the user's
call in the plugin settings, and it is what actually stops the gateway.

Tell the user to fully quit and reopen the ChatGPT desktop app afterwards;
closing the window is not enough.

## What to tell the user

- Models they already know: they appear as `WB · <name> · x<credits>` in the
  picker, alongside the native ones.
- Switching back to an official model needs no action at all — just pick it.
- Doing this on a WorkBuddy subscription is against its terms of use. Say so
  plainly if they ask; do not bury it.
