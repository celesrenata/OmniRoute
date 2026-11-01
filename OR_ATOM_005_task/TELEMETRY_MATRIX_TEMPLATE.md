# OR-ATOM-005 telemetry evidence matrix (fill during M5)

Use only verified current sources. No credentials, tokens, API keys, private host addresses, or raw user request text in this file.

| Metric                                 | Confirmed source | Backend/datasource | Query/producer reference | Units       | Labels/identity              | Scrape/aggregation window | Freshness SLA | Join proof | Available? | Notes |
| -------------------------------------- | ---------------- | ------------------ | ------------------------ | ----------- | ---------------------------- | ------------------------- | ------------- | ---------- | ---------- | ----- |
| Physical GPU UUID/host                 |                  |                    |                          | IDs         | host_id, device_uuid         |                           |               |            |            |       |
| GPU utilization                        |                  |                    |                          | percent     | host_id, device_uuid         |                           |               |            |            |       |
| VRAM used/total                        |                  |                    |                          | bytes       | host_id, device_uuid         |                           |               |            |            |       |
| GPU temperature/power                  |                  |                    |                          | C / W       | host_id, device_uuid         |                           |               |            |            |       |
| Runtime identity                       |                  |                    |                          | ID          | host_id, runtime_id          |                           |               |            |            |       |
| Per-model runtime assignment           |                  |                    |                          | IDs         | runtime_id, model_id         |                           |               |            |            |       |
| Runtime→GPU device assignment          |                  |                    |                          | IDs         | runtime_id, device_uuid      |                           |               |            |            |       |
| Device output tokens/sec               |                  |                    |                          | tokens/s    | device_uuid (proof required) |                           |               |            |            |       |
| Runtime output tokens/sec              |                  |                    |                          | tokens/s    | runtime_id                   |                           |               |            |            |       |
| Inference scheduler pending jobs       |                  |                    |                          | count       | runtime_id/device_uuid       |                           |               |            |            |       |
| OmniRoute request lifecycle            |                  |                    |                          | transitions | provider_id, request_id      |                           |               |            |            |       |
| OmniRoute provider→runtime association |                  |                    |                          | IDs         | provider_id, runtime_id      |                           |               |            |            |       |

Rule: missing source, no proven join, stale sample, or query failure → unknown/unavailable; never an invented 0 or heuristic GPU assignment.
