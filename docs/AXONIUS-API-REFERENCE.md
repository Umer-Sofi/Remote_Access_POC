# Axonius v2 API — the contract we build against

Compiled from public sources (the open-source `axonius-api-client` SDK and third-party
connector docs). **Not yet validated against a live tenant** — field names may need small
corrections, which are isolated to `broker/src/inventory/axonius.ts`.

## Authentication
Service account credentials sent as request headers (per public connector docs):
```
api-key:    <service account key>
api-secret: <service account secret>
```
Read-only rights on devices, tags (labels) and saved queries.

## Endpoints we use
| Purpose | Call |
|---|---|
| List workstations (paged) | `POST /api/v2/assets/devices` |
| One device's full detail | `GET /api/v2/assets/devices/{internal_axon_id}` |

## List request body (the important shape)
```jsonc
{
  "saved_query_name": "workstations",   // the Axonius admin's saved filter → only workstations
  "fields": {                            // which columns to return
    "devices": [
      "specific_data.data.hostname",
      "specific_data.data.os.type",
      "specific_data.data.device_serial",
      "specific_data.data.network_interfaces.mac_addresses",
      "specific_data.data.network_interfaces.ips",
      "specific_data.data.last_seen",
      "labels"
    ]
  },
  "page": { "offset": 0, "limit": 2000 } // paging; 2000 is the max page size
}
```

## Response shape
```jsonc
{
  "assets": [ /* device objects, see the mock fixture */ ],
  "page":   { "offset": 0, "limit": 2000, "totalResources": 1234 }
}
```

## Fields Axonius ALWAYS returns (even if not requested)
- `internal_axon_id` — the stable unique device ID (we store this in the audit log).
- `labels` — the device's **tags** (e.g. `remote-access-allowed`).
- `adapters`, `adapter_list_length` — which data sources contributed; we ignore these for now.

## Field names we rely on (approximate until validated)
| Our concept | Axonius field |
|---|---|
| hostname | `specific_data.data.hostname` |
| OS | `specific_data.data.os.type` |
| serial (best match key) | `specific_data.data.device_serial` |
| MAC addresses | `specific_data.data.network_interfaces.mac_addresses` |
| IPs | `specific_data.data.network_interfaces.ips` |
| last seen | `specific_data.data.last_seen` |
| tags | `labels` |

> Note: Axonius returns aggregated fields as arrays (a device can have several adapters,
> each with its own hostname/MAC). Our parser takes the first non-empty value per field.

## Which-are-workstations
The saved query (owned by the Axonius admin) filters to
`Preferred Device Type in (Laptops, Desktops, Workstations)`. We never hard-code that
filter — we just pass its name via `saved_query_name`.

## Sources
- axonius-api-client (official SDK) — https://axonius-api-client.readthedocs.io
- Swimlane connector — https://docs.swimlane.com/connectors/axonius
- Cortex XSOAR integration — https://xsoar.pan.dev/docs/reference/integrations/axonius
