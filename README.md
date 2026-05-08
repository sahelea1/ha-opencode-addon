# ha-opencode-addon

An AI coding agent for editing your Home Assistant configuration — with a **safety guardian** that automatically backs up config before every change and resets if you don't approve within 10 minutes.

## What it does

- Runs [OpenCode](https://opencode.ai) web UI inside a Docker container on your HA instance, rooted at your Home Assistant `/config` directory
- Mounts your entire `/config` directory (read/write) and mirrors it at `/root/ha-config` so OpenCode can always see your HA files
- **Config Guardian** monitors every file change and:
  1. Keeps a backup of the "last known good" config at all times
  2. When changes are detected, starts a 10-minute countdown
  3. Shows a floating banner in the UI: **"Approve or Reset"**
  4. If you don't approve in time → **auto-resets** and reloads HA
  5. On crash → **auto-reverts** on next startup (failsafe)
- No login required in the web UI — HA ingress handles authentication
- Provider presets/API keys, OpenCode logins, config, sessions, state, and cache persist in add-on data across restarts, rebuilds, and updates

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Browser (HA Frontend / HA App)                     │
│  "Open Web UI" → HA Ingress (handles auth)          │
└──────────────┬──────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────┐
│  Guardian Server (port 8099)                        │
│  ┌────────────────────────────────────────────────┐ │
│  │ Reverse Proxy → OpenCode Web (port 8100)       │ │
│  │ + Injects guardian banner into HTML responses   │ │
│  └────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────┐ │
│  │ File Watcher (polls /config every 5s)          │ │
│  │ Backup Manager (rsync to /data/last-known-good)│ │
│  │ Timer + Auto-Reset Logic                       │ │
│  └────────────────────────────────────────────────┘ │
│                                                     │
│  Mounted: /config (HA config, read/write)           │
│  Persistent: /data (backups, OpenCode auth, state)  │
└─────────────────────────────────────────────────────┘
```

## Setup

### 1. Copy the add-on to your HA instance

SSH into your HA and create the add-on directory:

```bash
mkdir -p /addons/ha-opencode-addon
```

Copy all files from this archive into `/addons/ha-opencode-addon/`.

### 2. Add the local repository

In HA: **Settings → Add-ons → Add-on Store → ⋮ (top right) → Repositories**

Add: `/addons`

Hit refresh. "ha-opencode-addon" should appear under **Local add-ons**.

### 3. Install and configure

- Click **ha-opencode-addon** → **Install** (builds the Docker image, takes 2-3 minutes)
- Go to the **Configuration** tab
- Choose a provider preset and optionally enter an API key
- Optionally adjust `confirm_timeout_minutes` (default: 10)
- Click **Start**
- Open the web UI and connect your provider or API key inside OpenCode if you did not enter one in the add-on options

Provider settings can be entered either in Home Assistant add-on options or in the OpenCode UI. Runtime OpenCode auth and config are stored in `/data/opencode-*`, which is Home Assistant add-on data.

### 4. Use it

Click **"Open Web UI"** on the add-on page. You'll see the OpenCode web interface.

Start editing your HA config files through OpenCode. The UI opens with `/config` as the working directory, and the same files are mirrored at `/root/ha-config`. When changes are detected, a banner appears at the top:

```
9:42  Config changes pending  automations.yaml · configuration.yaml
                                  [Approve]  [Reset]
```

- **Approve** → saves the current state as the new baseline
- **Reset** → restores the last approved state, deletes newly created included files, and reloads HA
- **Timeout** → auto-reverts after 10 minutes (configurable)
- The fallback approval page is available at `__guardian__/` if the banner is hidden by the upstream UI

### 5. Fallback status page

If the banner doesn't appear (e.g., due to CSP issues), visit:

```
http://<your-ha-ip>:8099/__guardian__/
```

(You may need to enable the port in the add-on's Network settings first.)

## Safety Guarantees

| Scenario | What happens |
|---|---|
| You approve in time | New baseline saved, you're good |
| You forget to approve | Auto-reset after timeout, HA reloads |
| OpenCode breaks your config | Auto-reset on timeout restores working config |
| HA crashes from bad config | Add-on restarts, detects unapproved changes, resets, triggers HA restart |
| Add-on itself crashes | On next startup, crash recovery reverts to last known good |
| Power outage mid-edit | Same as crash — recovery on next boot |
| Config changes while the add-on is stopped | Startup detects the difference and requires approval without starting an automatic reset timer |

## What gets backed up

Everything in `/config` **except**:
- `home-assistant_v2.db*` (HA database — huge, not config)
- `.storage/` (HA internal state registry)
- `.git/` (if you use git for version control)
- `deps/`, `__pycache__/`, `tts/`, `.cloud/`

Reset uses the last approved backup as the source of truth. Files created after the last approval are removed if they are inside the included backup scope above.

The guardian does not use git for approval/reset. Versions before 1.3.0 created an empty git repo in `/config`, which made every HA config file look untracked; 1.3.0 no longer creates that repo and moves only the exact empty legacy guardian repo (`guardian@opencode-addon`, no commits, no remotes, no tracked files) into `/data/legacy-guardian-git-*`. Existing user git repos are preserved.

## Persistence

| Data | Location | Survives restart? |
|---|---|---|
| OpenCode settings | `/data/opencode-config/` | ✅ |
| OpenCode auth/sessions | `/data/opencode-share/` | ✅ |
| OpenCode state | `/data/opencode-state/` | ✅ |
| OpenCode cache | `/data/opencode-cache/` | ✅ |
| Config backup (last known good) | `/data/last-known-good/` | ✅ |
| Guardian state | `/data/guardian-state.json` | ✅ |
| Your HA config files | `/config/` mapped, `/root/ha-config` symlink | ✅ |

## Updating OpenCode

Bump the `version` in `config.yaml` to trigger a rebuild:

```yaml
version: "1.4.0"
```

Then **Rebuild** from the add-on page. Your `/data` (auth, config, backups) persists through rebuilds.
