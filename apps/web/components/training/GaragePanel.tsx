"use client";

import { useMemo, useState } from "react";

import {
  calendarDate,
  formatCalendarDate,
  formatNumber,
  localIsoDate,
  type Activity,
  type Gear,
  type MaintenanceRecord,
} from "@/lib/training/activity-types";
import {
  BIKE_PHOTOS,
  bikeRecords,
  scheduleStatus,
  SERVICE_CATALOG,
} from "@/lib/training/maintenance";
import { ownerRequest } from "@/lib/training/use-admin";

import { useTraining } from "./TrainingProvider";

type GearUsage = { yearMiles: number; lastUsed: string | null; activities: number };

function usageByGear(activities: Activity[], year: number): Map<string, GearUsage> {
  const usage = new Map<string, GearUsage>();
  for (const activity of activities) {
    if (!activity.gear_id) continue;
    const entry = usage.get(activity.gear_id) ?? { yearMiles: 0, lastUsed: null, activities: 0 };
    entry.activities += 1;
    if (calendarDate(activity.date)?.year === year) entry.yearMiles += activity.distance;
    if (!entry.lastUsed || activity.date > entry.lastUsed) entry.lastUsed = activity.date;
    usage.set(activity.gear_id, entry);
  }
  return usage;
}

/**
 * The bikes and shoes Strava knows about, with this year's miles on each, and
 * the maintenance log with what is due next.
 */
export default function GaragePanel({
  gear,
  activities,
  initialRecords,
}: {
  gear: Gear[];
  activities: Activity[];
  initialRecords: MaintenanceRecord[];
}) {
  const { todayIso, admin } = useTraining();
  const year = calendarDate(todayIso)?.year ?? new Date().getFullYear();
  const usage = useMemo(() => usageByGear(activities, year), [activities, year]);
  const bikes = gear.filter((item) => item.kind === "bike");
  const active = bikes.filter((bike) => !bike.retired);
  const retired = bikes.filter((bike) => bike.retired);
  const shoes = gear.filter((item) => item.kind === "shoe" && !item.retired);
  const [showRetired, setShowRetired] = useState(false);

  return (
    <section className="t-grid t-grid-wide">
      <div className="t-stack">
        <article className="panel">
          <div className="t-card-head">
            <div>
              <span className="label">Your equipment</span>
              <h2 className="t-card-title">The garage</h2>
            </div>
            <span className="tag">{active.length} active</span>
          </div>
          <div className="t-bikes">
            {active.map((bike) => (
              <GearCard key={bike.id} item={bike} usage={usage.get(bike.id)} year={year} />
            ))}
            {!active.length && (
              <div className="t-empty">
                No bikes yet. They appear after the first Strava sync, including any added later.
              </div>
            )}
          </div>
          {retired.length > 0 && (
            <>
              <button
                className="t-link t-spaced"
                type="button"
                aria-expanded={showRetired}
                onClick={() => setShowRetired((value) => !value)}
              >
                {showRetired ? "Hide" : "Show"} {retired.length} retired{" "}
                {retired.length === 1 ? "bike" : "bikes"}
              </button>
              {showRetired && (
                <div className="t-bikes">
                  {retired.map((bike) => (
                    <GearCard key={bike.id} item={bike} usage={usage.get(bike.id)} year={year} />
                  ))}
                </div>
              )}
            </>
          )}
        </article>
        {shoes.length > 0 && (
          <article className="panel">
            <span className="label">Shoes</span>
            <div className="t-list">
              {shoes.map((shoe) => (
                <div className="t-row" key={shoe.id}>
                  <span className="t-row-text">
                    <strong>{shoe.name}</strong>
                    <small>{[shoe.brand, shoe.model].filter(Boolean).join(" ") || "Strava gear"}</small>
                  </span>
                  <span className="t-row-figure num">{formatNumber(shoe.distance)} mi</span>
                </div>
              ))}
            </div>
          </article>
        )}
      </div>
      <MaintenanceCard
        bikes={active.length ? active : bikes}
        initialRecords={initialRecords}
        todayIso={todayIso}
        canEdit={admin.authenticated}
      />
    </section>
  );
}

function GearCard({ item, usage, year }: { item: Gear; usage: GearUsage | undefined; year: number }) {
  const photo = BIKE_PHOTOS[item.id];
  return (
    <article className={`t-bike ${item.retired ? "is-retired" : ""}`}>
      {photo ? (
        // eslint-disable-next-line @next/next/no-img-element -- static, pre-sized photos
        <img className="t-bike-photo" src={photo} alt="" loading="lazy" width={900} height={675} />
      ) : (
        <div className="t-bike-photo is-placeholder" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 17a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm14 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM5 14l4-7h5l5 7M9 7l3 7h7M13 4h3" />
          </svg>
        </div>
      )}
      <div className="t-bike-body">
        <strong>{item.name}</strong>
        <small>{[item.brand, item.model].filter(Boolean).join(" ") || "Strava gear"}</small>
        <div className="t-bike-figures">
          <span>
            <b className="num">{formatNumber(item.distance)}</b>
            <small>mi total</small>
          </span>
          <span>
            <b className="num">{formatNumber(usage?.yearMiles ?? 0)}</b>
            <small>mi in {year}</small>
          </span>
        </div>
        {usage?.lastUsed && (
          <em>
            Last ridden{" "}
            {formatCalendarDate(usage.lastUsed, { month: "short", day: "numeric", year: "numeric" })}
          </em>
        )}
      </div>
    </article>
  );
}

function MaintenanceCard({
  bikes,
  initialRecords,
  todayIso,
  canEdit,
}: {
  bikes: Gear[];
  initialRecords: MaintenanceRecord[];
  todayIso: string;
  canEdit: boolean;
}) {
  const [records, setRecords] = useState(initialRecords);
  const [bikeId, setBikeId] = useState(bikes[0]?.id ?? "");
  const [part, setPart] = useState("Chain");
  const [service, setService] = useState(SERVICE_CATALOG.Chain[0]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ error?: string; notice?: string }>({});
  const bike = bikes.find((item) => item.id === bikeId) ?? bikes[0];
  const history = bike ? bikeRecords(records, bike) : [];
  const schedules = bike ? scheduleStatus(records, bike, todayIso) : [];

  async function addRecord() {
    if (!bike) return;
    setBusy(true);
    setStatus({});
    try {
      const record = await ownerRequest<MaintenanceRecord>("/api/training/maintenance", "POST", {
        bikeId: bike.id,
        bike: bike.name,
        part,
        service,
        date: localIsoDate(),
        mileage: bike.distance,
      });
      setRecords((current) => [record, ...current]);
      setStatus({ notice: `${part} · ${service} logged for ${bike.name}.` });
    } catch (reason) {
      setStatus({ error: reason instanceof Error ? reason.message : "Could not save service" });
    } finally {
      setBusy(false);
    }
  }

  async function deleteRecord(id: string) {
    setBusy(true);
    setStatus({});
    try {
      await ownerRequest(`/api/training/maintenance?id=${encodeURIComponent(id)}`, "DELETE");
      setRecords((current) => current.filter((record) => record.id !== id));
    } catch (reason) {
      setStatus({ error: reason instanceof Error ? reason.message : "Could not delete record" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="panel">
      <div className="t-card-head">
        <div>
          <span className="label">Service</span>
          <h2 className="t-card-title">Maintenance</h2>
        </div>
        {!canEdit && <span className="tag">Owner edits</span>}
      </div>

      <label className="t-select is-block">
        <span>Bike</span>
        <select value={bike?.id ?? ""} onChange={(event) => setBikeId(event.target.value)}>
          {bikes.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>

      {bike && (
        <div className="t-subsection">
          <div className="t-subhead">
            Next due · {formatNumber(bike.distance)} mi on the odometer
          </div>
          {schedules.length ? (
            schedules.map((entry) => {
              const overdue = entry.remaining < 0;
              const soon = !overdue && entry.remaining <= (entry.unit === "mi" ? 25 : 14);
              return (
                <div
                  className={`t-row t-schedule ${overdue ? "is-overdue" : soon ? "is-soon" : ""}`}
                  key={entry.schedule.label}
                >
                  <span className="t-row-text">
                    <strong>{entry.schedule.label}</strong>
                    <small>
                      Last{" "}
                      {formatCalendarDate(entry.last.date, {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}{" "}
                      · due {entry.dueLabel}
                    </small>
                  </span>
                  <b className="num">
                    {overdue
                      ? `${formatNumber(Math.abs(entry.remaining))} ${entry.unit} overdue`
                      : `in ${formatNumber(entry.remaining)} ${entry.unit}`}
                  </b>
                </div>
              );
            })
          ) : (
            <p className="t-note">
              Log a chain or tire service to start tracking when the next one is due.
            </p>
          )}
        </div>
      )}

      {canEdit && bike && (
        <div className="t-service-form">
          <label className="t-select is-block">
            <span>Part</span>
            <select
              value={part}
              onChange={(event) => {
                setPart(event.target.value);
                setService(SERVICE_CATALOG[event.target.value][0]);
              }}
            >
              {Object.keys(SERVICE_CATALOG).map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </label>
          <label className="t-select is-block">
            <span>Service</span>
            <select value={service} onChange={(event) => setService(event.target.value)}>
              {SERVICE_CATALOG[part].map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </label>
          <button className="t-button" disabled={busy} onClick={() => void addRecord()} type="button">
            {busy ? "Saving…" : "Log service"}
          </button>
        </div>
      )}
      {(status.error || status.notice) && (
        <p className={status.error ? "t-error" : "t-notice"} role="status">
          {status.error ?? status.notice}
        </p>
      )}

      <div className="t-subsection">
        <div className="t-subhead">History</div>
        {history.slice(0, 12).map((record) => (
          <div className="t-row" key={record.id}>
            <span className="t-check" aria-hidden="true">
              ✓
            </span>
            <span className="t-row-text">
              <strong>
                {record.part} · {record.service}
              </strong>
              <small>
                {formatCalendarDate(record.date, { month: "short", day: "numeric", year: "numeric" })}
              </small>
            </span>
            <span className="t-row-figure num">{formatNumber(record.mileage)} mi</span>
            {canEdit && (
              <button
                aria-label={`Delete ${record.part} ${record.service} record`}
                className="icon-button t-delete"
                disabled={busy}
                onClick={() => void deleteRecord(record.id)}
                type="button"
              >
                ×
              </button>
            )}
          </div>
        ))}
        {!history.length && <div className="t-empty">No service records for this bike yet.</div>}
      </div>
    </article>
  );
}
