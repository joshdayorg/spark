export type ValidatedMcpPushPayload = {
  source: string;
  type: string;
  actor: string;
  summary: string;
  timestamp: number;
  sourceDeliveryId?: string;
};

function getRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function readRequiredTrimmedString(
  payload: Record<string, unknown>,
  field: "source" | "type" | "actor" | "summary",
): string {
  const value = payload[field];
  if (typeof value !== "string") {
    throw new Error(`BAD_REQUEST: spark_push requires input.${field}`);
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`BAD_REQUEST: spark_push requires non-empty input.${field}`);
  }

  return trimmed;
}

function readOptionalTrimmedString(
  payload: Record<string, unknown>,
  field: "sourceDeliveryId",
): string | undefined {
  const value = payload[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`BAD_REQUEST: spark_push input.${field} must be a string`);
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`BAD_REQUEST: spark_push input.${field} must be non-empty`);
  }
  return trimmed;
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function formatRawPayloadPath(path: string): string {
  return path.length > 0 ? `input.${path}` : "input";
}

function assertConvexCompatibleRawPayload(value: unknown, path = ""): void {
  if (value === null) {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertConvexCompatibleRawPayload(item, `${path}[${index}]`);
    });
    return;
  }

  if (typeof value !== "object") {
    if (value === undefined || typeof value === "function" || typeof value === "symbol") {
      throw new Error(
        `BAD_REQUEST: spark_push ${formatRawPayloadPath(path)} contains a value Convex cannot store`,
      );
    }
    return;
  }

  if (!isPlainObject(value)) {
    throw new Error(
      `BAD_REQUEST: spark_push ${formatRawPayloadPath(path)} must be a plain JSON object or array`,
    );
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === "" || key.startsWith("$") || key.startsWith("_")) {
      throw new Error(
        `BAD_REQUEST: spark_push ${formatRawPayloadPath(path)} contains invalid Convex field name "${key}"`,
      );
    }
    const childPath = path.length > 0 ? `${path}.${key}` : key;
    assertConvexCompatibleRawPayload(child, childPath);
  }
}

export function validateMcpPushPayload(input: unknown): ValidatedMcpPushPayload {
  const payload = getRecord(input);
  if (!payload) {
    throw new Error("BAD_REQUEST: MCP push payload must be an object");
  }
  assertConvexCompatibleRawPayload(payload);
  const sourceDeliveryId = readOptionalTrimmedString(payload, "sourceDeliveryId");

  const timestamp = payload.timestamp;
  if (timestamp !== undefined) {
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
      throw new Error("BAD_REQUEST: spark_push input.timestamp must be a finite number");
    }
  }

  return {
    source: readRequiredTrimmedString(payload, "source"),
    type: readRequiredTrimmedString(payload, "type"),
    actor: readRequiredTrimmedString(payload, "actor"),
    summary: readRequiredTrimmedString(payload, "summary"),
    timestamp: timestamp === undefined ? Date.now() : timestamp,
    ...(sourceDeliveryId ? { sourceDeliveryId } : {}),
  };
}
