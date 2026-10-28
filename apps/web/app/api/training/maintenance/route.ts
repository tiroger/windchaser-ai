import { ownerModeActive } from "@/lib/training/admin-session";
import {
  ConflictError,
  loadMaintenanceRecords,
  updateMaintenanceRecords,
} from "@/lib/training/data";
import type { MaintenanceRecord } from "@/lib/training/activity-types";
import { sameOrigin } from "@/lib/training/security";
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const conflictResponse = () =>
  NextResponse.json(
    { error: "Service records changed elsewhere. Reload and try again." },
    { status: 409 },
  );

export async function GET() {
  try {
    return NextResponse.json(await loadMaintenanceRecords());
  } catch (error) {
    console.error("[training] could not read maintenance records", error);
    return NextResponse.json(
      { error: "Could not load maintenance records" },
      { status: 503 },
    );
  }
}

export async function POST(request: Request) {
  if (!sameOrigin(request) || !(await ownerModeActive())) {
    return NextResponse.json({ error: "Admin session required" }, { status: 403 });
  }

  let input: Partial<MaintenanceRecord>;
  try {
    input = (await request.json()) as Partial<MaintenanceRecord>;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (
    typeof input.bike !== "string" ||
    input.bike.length < 1 ||
    input.bike.length > 120 ||
    typeof input.part !== "string" ||
    input.part.length < 1 ||
    input.part.length > 80 ||
    typeof input.service !== "string" ||
    input.service.length < 1 ||
    input.service.length > 80 ||
    typeof input.date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(input.date) ||
    typeof input.mileage !== "number" ||
    !Number.isFinite(input.mileage) ||
    input.mileage < 0 ||
    input.mileage > 1_000_000 ||
    (input.bikeId !== undefined && (typeof input.bikeId !== "string" || !/^[bg]\d{1,20}$/.test(input.bikeId)))
  ) {
    return NextResponse.json({ error: "Invalid maintenance record" }, { status: 400 });
  }

  const record: MaintenanceRecord = {
    id: randomUUID(),
    ...(input.bikeId ? { bikeId: input.bikeId } : {}),
    bike: input.bike,
    part: input.part,
    service: input.service,
    date: input.date,
    mileage: input.mileage,
  };
  try {
    await updateMaintenanceRecords((records) => [record, ...records]);
    return NextResponse.json(record, { status: 201 });
  } catch (error) {
    if (error instanceof ConflictError) return conflictResponse();
    console.error("[training] could not save maintenance record", error);
    return NextResponse.json({ error: "Could not save record" }, { status: 503 });
  }
}

export async function DELETE(request: Request) {
  if (!sameOrigin(request) || !(await ownerModeActive())) {
    return NextResponse.json({ error: "Admin session required" }, { status: 403 });
  }
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing record ID" }, { status: 400 });

  let found = false;
  try {
    await updateMaintenanceRecords((records) => {
      const updated = records.filter((record) => record.id !== id);
      found = updated.length !== records.length;
      return updated;
    });
  } catch (error) {
    if (error instanceof ConflictError) return conflictResponse();
    console.error("[training] could not delete maintenance record", error);
    return NextResponse.json({ error: "Could not delete record" }, { status: 503 });
  }
  if (!found) {
    return NextResponse.json({ error: "Record not found" }, { status: 404 });
  }
  return NextResponse.json({ deleted: true });
}
