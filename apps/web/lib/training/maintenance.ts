import { calendarDate, type Gear, type MaintenanceRecord } from "@/lib/training/activity-types";

/** Parts and the services each one takes, as in the original maintenance log. */
export const SERVICE_CATALOG: Record<string, string[]> = {
  "Bar Tape": ["New"],
  "Bottom Bracket": ["New", "Service"],
  "Brake Cables": ["New"],
  "Brake Housing": ["New"],
  "Brake Pads": ["New"],
  Cables: ["New"],
  Cassette: ["New"],
  Chain: ["Lube", "Hot Wax", "Top-Up", "New"],
  Crankset: ["New", "Service"],
  "Derailleur Hanger": ["New"],
  Handlebar: ["New"],
  Headset: ["New", "Service"],
  Pedals: ["New", "Service"],
  Saddle: ["New"],
  Seatpost: ["New"],
  Stem: ["New"],
  Tires: ["Top-Up", "New"],
  Wheels: ["True", "Service", "Retape"],
};

export type ServiceSchedule = {
  label: string;
  part: string;
  service: string;
  everyMiles?: number;
  everyMonths?: number;
};

export const SERVICE_SCHEDULES: ServiceSchedule[] = [
  { label: "Chain lube", part: "Chain", service: "Lube", everyMiles: 150 },
  { label: "Chain wax top-up", part: "Chain", service: "Top-Up", everyMiles: 100 },
  { label: "Chain hot wax", part: "Chain", service: "Hot Wax", everyMiles: 1000 },
  { label: "Tire sealant top-up", part: "Tires", service: "Top-Up", everyMonths: 4 },
  { label: "Tire replacement", part: "Tires", service: "New", everyMiles: 2000 },
];

export type ScheduleStatus = {
  schedule: ServiceSchedule;
  last: MaintenanceRecord;
  /** Miles remaining for distance schedules, days for calendar ones; negative when overdue. */
  remaining: number;
  unit: "mi" | "days";
  dueLabel: string;
};

function belongsTo(record: MaintenanceRecord, bike: Gear): boolean {
  return record.bikeId ? record.bikeId === bike.id : record.bike === bike.name;
}

export function bikeRecords(records: MaintenanceRecord[], bike: Gear): MaintenanceRecord[] {
  return records.filter((record) => belongsTo(record, bike));
}

/** Next due service for every schedule this bike has been serviced under. */
export function scheduleStatus(
  records: MaintenanceRecord[],
  bike: Gear,
  todayIso: string,
): ScheduleStatus[] {
  const mine = bikeRecords(records, bike);
  return SERVICE_SCHEDULES.flatMap<ScheduleStatus>((schedule) => {
    const last = mine
      .filter((record) => record.part === schedule.part && record.service === schedule.service)
      .sort((a, b) => b.date.localeCompare(a.date) || b.mileage - a.mileage)[0];
    if (!last) return [];
    if (schedule.everyMiles) {
      const dueAt = last.mileage + schedule.everyMiles;
      return [{
        schedule,
        last,
        remaining: dueAt - bike.distance,
        unit: "mi" as const,
        dueLabel: `at ${Math.round(dueAt).toLocaleString("en-US")} mi`,
      }];
    }
    const lastDate = calendarDate(last.date);
    const today = calendarDate(todayIso);
    if (!lastDate || !today || !schedule.everyMonths) return [];
    const due = new Date(Date.UTC(lastDate.year, lastDate.month + schedule.everyMonths, lastDate.day));
    const remaining = Math.round(
      (due.getTime() - Date.UTC(today.year, today.month, today.day)) / 86_400_000,
    );
    return [{
      schedule,
      last,
      remaining,
      unit: "days" as const,
      dueLabel: `on ${due.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}`,
    }];
  });
}

/** Photos of the bikes, kept from the original app. */
export const BIKE_PHOTOS: Record<string, string> = {
  b8099416: "/training/bikes/tcr.jpeg",
  b4073790: "/training/bikes/storck.jpeg",
  b8615449: "/training/bikes/headlands.jpeg",
  b11212849: "/training/bikes/caad13.jpeg",
  b5245627: "/training/bikes/slate.jpeg",
  b8029179: "/training/bikes/marin.jpeg",
};
