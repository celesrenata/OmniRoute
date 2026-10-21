/**
 * GET /api/telemetry/fleet — M2/M5 Fleet Telemetry Gateway endpoint.
 *
 * One management-authenticated, server-side bounded snapshot of the fleet,
 * sourced EXCLUSIVELY from the OmniRoute-native adapter
 * (`src/shared/topology/telemetry/providers/omniroute.ts`). No browser
 * fan-out, no per-atom queries, no external telemetry backends (M0 audit:
 * none exist in this repo — see docs/specs/atomic-topology-telemetry-matrix.md).
 *
 * Security posture:
 * - Hard-gated by `requireManagementAuth` BEFORE any data access.
 * - Query is validated up front (400 on bad input); the gateway re-validates.
 * - Errors route through `buildErrorBody` — raw stack traces / upstream error messages
 *   never reach the response body (hard rule #12).
 * - The response is a normalized, provenance-carrying snapshot; GPU/runtime
 *   device facts are `null` with documented unavailable semantics, never
 *   fabricated.
 */

import { NextResponse } from "next/server";
import pino from "pino";

import { buildErrorBody } from "@omniroute/open-sse/utils/error.ts";

import { fetchFleetTelemetrySnapshot } from "@/shared/topology/telemetry/gatewayServer";
import { mapFleetTelemetryQuery } from "@/shared/topology/telemetry/httpQuery";
import { TelemetryAbortedError, TelemetryQueryError } from "@/shared/topology/telemetry/gateway";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";

const logger = pino({ name: "telemetry-fleet-api" });

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const url = new URL(request.url);
    const mapped = mapFleetTelemetryQuery(url.searchParams);
    if ("error" in mapped) {
      return NextResponse.json(buildErrorBody(400, mapped.error), { status: 400 });
    }

    const snapshot = await fetchFleetTelemetrySnapshot(mapped.query, request.signal);
    return NextResponse.json(snapshot);
  } catch (error) {
    if (error instanceof TelemetryQueryError) {
      // Defense in depth: httpQuery.ts should have caught this already.
      return NextResponse.json(buildErrorBody(400, "Invalid fleet telemetry query"), {
        status: 400,
      });
    }
    if (error instanceof TelemetryAbortedError) {
      // Client went away mid-collection — not a server fault.
      return NextResponse.json(buildErrorBody(408, "Fleet telemetry query aborted"), {
        status: 408,
      });
    }
    logger.error({ err: error }, "Failed to build fleet telemetry snapshot");
    return NextResponse.json(buildErrorBody(503, "Fleet telemetry backend unavailable"), {
      status: 503,
    });
  }
}
