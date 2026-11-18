# Research Brief — Axonius Device-Inventory Integration

**Author:** Umer Sofi
**Date:** 18 November 2026
**Project:** Remote Access (PAM) module — endpoint remote support with consent, recording and audit

---

## 1. Objective
Extend the existing Remote Access module so the operator connects to workstations drawn from the
organisation's **Axonius** asset inventory. A device becomes connectable only when (a) its endpoint
app is running and (b) it matches an Axonius record that is tagged as remote-access-allowed. The
existing session flow — consent prompt, live screen, recording and audit — remains unchanged.

## 2. Scope of the work
- The broker pulls workstation inventory from Axonius on a schedule (every 15 minutes) and keeps its
  own copy in a database.
- A matcher links each live endpoint to its Axonius record by serial number, then MAC address, then
  hostname.
- The operator console shows the inventory with device tags, OS and live status (Online / Known).
- Authorisation is governed by an Axonius tag; the Axonius device ID is written into the audit log.

## 3. Requirements and dependencies

### 3.1 Software libraries — none required
No new third-party libraries are needed. Communication with Axonius uses standard web requests
already supported by the language, and device identifiers (serial, MAC) are read through operating-
system facilities already available on macOS and Windows.

### 3.2 External access required from Axonius *(the primary blocker)*
| Requirement | Purpose | Status |
|---|---|---|
| Official v2 API reference (developer portal) | Confirm exact endpoints and field names | Requested; approval not assured |
| A live Axonius tenant (trial or a mutual customer) | Validate sign-in, real field names and paging | **Not yet available — the key dependency** |
| Read-only service account | Lets the broker authenticate and pull inventory | Needed once a tenant is available |
| Name of the workstations "saved query" | Filters inventory to workstations only | Provided by the Axonius administrator |

### 3.3 Organisational decisions
- The tag that marks a device as permitted for remote access (e.g. `remote-access-allowed`).
- Policy for an endpoint that is running but has no Axonius record (recommended: block).

## 4. Current status
- The design is complete and maps cleanly onto the existing architecture; no part of the current
  consent/recording/audit flow needs to change.
- Approximately 90% of the work can proceed immediately using a **mock Axonius** (a local stand-in
  that serves sample inventory), allowing the full feature to be built and demonstrated before live
  access is granted.
- Only **live validation** against a real tenant is blocked.

## 5. Estimated effort
Roughly **8–10 working days** to a complete demonstration using mock inventory, plus **1–2 days** of
validation once a live Axonius tenant is available.

## 6. Honest status statement
Until validation against a live tenant is complete, the accurate claim is:
**"Built to the published Axonius v2 contract; not yet validated against a live Axonius tenant."**
