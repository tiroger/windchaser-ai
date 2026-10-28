import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

import { readEnv, stravaVerifyToken } from "@/lib/server/env";

export const dynamic = "force-dynamic";

/**
 * Strava webhook callback.
 *
 * Two obligations shape this file. Strava validates a new subscription with a
 * GET carrying a challenge that must be echoed verbatim, and it expects event
 * POSTs to be acknowledged within about two seconds, retrying when they are
 * not. So this endpoint does the least possible: check it is really Strava,
 * put the event on a queue, and return. Fetching the activity and matching its
 * efforts happens off that queue, where being slow is allowed. The rider's own
 * activity events also go to the Training sync's queue; see forwardToTraining.
 *
 * Returning 200 to a duplicate is deliberate. Strava retries, and an event
 * arriving twice must not become an error; deduplication belongs downstream
 * against an idempotency record, per section 12.
 */

interface StravaEvent {
  object_type: "activity" | "athlete";
  object_id: number;
  aspect_type: "create" | "update" | "delete";
  owner_id: number;
  subscription_id: number;
  event_time: number;
  updates?: Record<string, string>;
}

/** Strava's subscription handshake. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");

  const expected = await stravaVerifyToken();
  if (!expected) {
    console.error("[webhook] no STRAVA_VERIFY_TOKEN configured");
    return Response.json({ error: "not configured" }, { status: 503 });
  }

  // Comparing lengths first keeps a mismatch from being distinguishable by
  // timing, which matters because this endpoint is public and unauthenticated.
  if (mode !== "subscribe" || !token || !timingSafeEqual(token, expected)) {
    console.warn("[webhook] rejected a validation attempt");
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  if (!challenge) {
    return Response.json({ error: "missing hub.challenge" }, { status: 400 });
  }

  // Strava accepts the subscription only if this is echoed exactly.
  return Response.json({ "hub.challenge": challenge });
}

export async function POST(request: Request) {
  let event: StravaEvent;
  try {
    event = (await request.json()) as StravaEvent;
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  // Strava does not sign webhook payloads, so the subscription id is the only
  // thing tying an event to our subscription. It is weak evidence, which is why
  // nothing downstream trusts the body: the worker re-fetches from the API.
  const expectedSubscription = readEnv("STRAVA_SUBSCRIPTION_ID");
  if (expectedSubscription && String(event.subscription_id) !== expectedSubscription) {
    console.warn("[webhook] event for an unknown subscription", event.subscription_id);
    return new Response(null, { status: 200 });
  }

  let client: SQSClient | undefined;
  const sqs = () =>
    (client ??= new SQSClient({ region: process.env.AWS_REGION || "us-east-1" }));

  const queueUrl = readEnv("STRAVA_EVENTS_QUEUE_URL");
  if (!queueUrl) {
    // Still acknowledge: Strava retrying will not fix our configuration, and
    // repeated failures count against the subscription. Not returned early, so
    // the Training forward below does not depend on this queue existing.
    console.error("[webhook] no queue configured; event dropped");
  } else {
    try {
      await sqs().send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify({
            received_at: new Date().toISOString(),
            event,
          }),
        }),
      );
    } catch (error) {
      console.error(
        "[webhook] could not enqueue:",
        error instanceof Error ? error.message : error,
      );
      // A 500 makes Strava retry, which is what we want for a transient failure.
      return Response.json({ error: "could not enqueue" }, { status: 500 });
    }
  }

  if (!(await forwardToTraining(sqs, event))) {
    // Retried by Strava like any other failure. The retry enqueues for
    // strava_worker a second time too, which is harmless: it skips efforts it
    // already holds, and the Training queue deduplicates on content.
    return Response.json({ error: "could not forward" }, { status: 500 });
  }

  return new Response(null, { status: 200 });
}

/**
 * Every message on the Training queue shares this group, including the
 * EventBridge schedules (modules/training-sync, var.message_group_id), so the
 * Training sync applies one change at a time to the objects it rewrites.
 */
const TRAINING_MESSAGE_GROUP = "strava-events";

/**
 * Forward the rider's activity events to the Training sync (ADR-0004).
 *
 * Strava allows one webhook subscription per application, and WindChaser holds
 * it, so this endpoint feeds both workers. Only activity events for the
 * configured athlete go: the Training section is one rider's, and an athlete
 * event (a deauthorisation) has nothing for it to do. The raw Strava fields are
 * sent rather than this queue's envelope, because that is the shape the
 * worker's tests and the FIFO queue's content deduplication are built around.
 *
 * Returns false only when a send failed; an unconfigured forward is not a
 * failure, so environments without the Training queue behave exactly as before.
 */
async function forwardToTraining(
  sqs: () => SQSClient,
  event: StravaEvent,
): Promise<boolean> {
  const queueUrl = readEnv("TRAINING_EVENTS_QUEUE_URL");
  const athleteId = readEnv("STRAVA_ATHLETE_ID");
  if (!queueUrl || !athleteId) return true;
  if (event.object_type !== "activity" || String(event.owner_id) !== athleteId) {
    return true;
  }

  try {
    await sqs().send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({
          object_type: event.object_type,
          aspect_type: event.aspect_type,
          object_id: event.object_id,
          owner_id: event.owner_id,
          subscription_id: event.subscription_id,
          event_time: event.event_time,
        }),
        MessageGroupId: TRAINING_MESSAGE_GROUP,
      }),
    );
    return true;
  } catch (error) {
    console.error(
      "[webhook] could not forward to training:",
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

/** Constant-time comparison, so a wrong token cannot be guessed by timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
