# Connecting a remote Mac (internet test mode)

Operator: your Mac runs the broker and a Cloudflare tunnel; video goes through LiveKit Cloud.
Target: any Apple silicon Mac, anywhere with internet. Recording is off in this mode.

## Operator (your Mac)

```bash
cd "/Users/umer.sofi/Documents/work/project task/Remote_Access_POC"
scripts/cloud-up.sh            # starts broker + tunnel, builds the app zip
caffeinate -d                  # in a second Terminal window: keep the Mac awake
```

* Console: http://localhost:8081, user `alice`, password = the 16 characters after
  `alice:` on the `OPERATORS=` line of `.env.cloud`.
* File to send the target user: `transfer/RemoteAccessEndpoint-cloud.app.zip` (send nothing else).
* Stop afterwards: `scripts/cloud-up.sh down`

**One zip works for any number of Macs** as long as the tunnel keeps running. If the tunnel
restarts (reboot, `down`), its URL changes: re-run `scripts/cloud-up.sh`, send the new zip, and
every target must redo steps 1-5 below (a new build needs its permissions granted again).

## Target Mac (first time)

Unzip `RemoteAccessEndpoint-cloud.app.zip` into Downloads, then in Terminal:

```bash
# 1. stop any older copy and clear stale permissions
pkill -f RemoteAccessEndpoint
tccutil reset ScreenCapture com.example.remoteaccess.endpoint
tccutil reset Accessibility com.example.remoteaccess.endpoint

# 2. allow the unsigned app to open
xattr -dr com.apple.quarantine ~/Downloads/RemoteAccessEndpoint.app

# 3. start it; it asks for Screen Recording and Accessibility
open ~/Downloads/RemoteAccessEndpoint.app
```

4. In each prompt click **Open System Settings** and switch **RemoteAccessEndpoint** on
   (Privacy & Security → Screen & System Audio Recording, and → Accessibility).
5. Restart it so macOS applies the permissions:

```bash
pkill -f RemoteAccessEndpoint; open ~/Downloads/RemoteAccessEndpoint.app
```

No permission alert should appear now. The Mac shows up in the operator's Targets list under
its computer name.

## Target Mac (every later session)

The app exits after each session (ephemeral mode), so before each connect:

```bash
open ~/Downloads/RemoteAccessEndpoint.app
```

## Connecting

1. Operator: Targets tab → type a reason → **View + control** or **View only** → **Connect**.
2. Target user: clicks **Allow** within 30 s. A red banner shows for the whole session.
3. Either side ends it: **Disconnect** (operator) or **End session** on the banner (target).
4. Audit trail: **Audit history** tab.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Target not in the list | App not running, or old zip with an old tunnel URL | `pgrep -fl RemoteAccessEndpoint` on the target; resend the current zip |
| "Denied" without the user clicking | A permission is missing | Redo steps 1-5 on the target |
| "Invalid username or password" | Password field includes `alice:` | Enter only the 16 characters after it |
| Can't delete the old app ("in use") | It is still running in the background | `pkill -9 -f RemoteAccessEndpoint` |
| Black video | Screen Recording not active for this build | Redo steps 1-5 |
| Video but no control | Accessibility not active for this build | Redo steps 1-5 |
