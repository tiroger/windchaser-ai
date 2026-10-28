/**
 * A small validator for the subset of JSON Schema the Ask tools use.
 *
 * The model's tool input is untrusted output, so every call is checked against
 * the same schema the model was given before anything runs. Keeping the
 * definition and the check in one object means they cannot drift apart, and
 * avoids a schema library for seven flat objects.
 */

export type JsonSchema = {
  type?: "object" | "string" | "integer" | "number" | "boolean" | "array";
  description?: string;
  enum?: readonly (string | number)[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
};

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

function check(schema: JsonSchema, value: unknown, path: string): string | null {
  if (schema.enum && !schema.enum.includes(value as string | number)) {
    return `${path} must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(", ")}`;
  }
  switch (schema.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return `${path} must be an object`;
      }
      const record = value as Record<string, unknown>;
      for (const key of schema.required ?? []) {
        if (record[key] === undefined) return `${path}.${key} is required`;
      }
      for (const [key, child] of Object.entries(record)) {
        const property = schema.properties?.[key];
        if (!property) {
          if (schema.additionalProperties === false) return `${path}.${key} is not a known field`;
          continue;
        }
        // An explicit null reads as "not given", as models sometimes send it.
        if (child === null) continue;
        const problem = check(property, child, `${path}.${key}`);
        if (problem) return problem;
      }
      return null;
    }
    case "string": {
      if (typeof value !== "string") return `${path} must be a string`;
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        return `${path} must be at least ${schema.minLength} characters`;
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        return `${path} must be at most ${schema.maxLength} characters`;
      }
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
        return `${path} does not match the expected format`;
      }
      return null;
    }
    case "integer":
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return `${path} must be a number`;
      if (schema.type === "integer" && !Number.isInteger(value)) return `${path} must be an integer`;
      if (schema.minimum !== undefined && value < schema.minimum) {
        return `${path} must be at least ${schema.minimum}`;
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        return `${path} must be at most ${schema.maximum}`;
      }
      return null;
    }
    case "boolean":
      return typeof value === "boolean" ? null : `${path} must be true or false`;
    case "array": {
      if (!Array.isArray(value)) return `${path} must be an array`;
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        return `${path} needs at least ${schema.minItems} items`;
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        return `${path} allows at most ${schema.maxItems} items`;
      }
      if (schema.items) {
        for (let index = 0; index < value.length; index++) {
          const problem = check(schema.items, value[index], `${path}[${index}]`);
          if (problem) return problem;
        }
      }
      return null;
    }
    default:
      return null;
  }
}

/** Checks a value against the schema; nulls on optional fields are dropped. */
export function validate<T>(schema: JsonSchema, value: unknown): Validation<T> {
  const problem = check(schema, value, "input");
  if (problem) return { ok: false, error: problem };
  if (schema.type === "object") {
    const cleaned = Object.fromEntries(
      Object.entries(value as Record<string, unknown>).filter(([, child]) => child !== null),
    );
    return { ok: true, value: cleaned as T };
  }
  return { ok: true, value: value as T };
}

/** A real calendar date in YYYY-MM-DD form (rejects 2026-02-30). */
export function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}
