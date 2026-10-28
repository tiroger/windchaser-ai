import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// SQS is replaced by a recorder, so a test reads exactly what each queue was
// sent and can make either send fail.
const send = vi.hoisted(() => vi.fn());

vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: class {
    send = send;
  },
  SendMessageCommand: class {
    constructor(readonly input: Record<string, unknown>) {}
  },
}));

// The real readEnv falls back to a developer's .env files, which would let a
// local checkout's configuration leak into these tests. Process env only.
vi.mock("@/lib/server/env", () => ({
  readEnv: (name: string) => process.env[name] || undefined,
  stravaVerifyToken: async () => process.env.STRAVA_VERIFY_TOKEN || undefined,
}));

const { GET, POST } = await import("./route");

const STRAVA_QUEUE = "https://sqs.example/windchaser-dev-strava-events";
const TRAINING_QUEUE = "https://sqs.example/windchaser-dev-training-events.fifo";

const event = {
  object_type: "activity",
  aspect_type: "create",
  object_id: 123,
  owner_id: 42,
  subscription_id: 7,
  event_time: 1_700_000_000,
};

const post = (body: unknown) =>
  POST(
    new Request("https://windchaser.example/api/strava/webhook", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

const sentTo = (queueUrl: string) =>
  send.mock.calls
    .map(([command]) => command.input)
    .filter((input) => input.QueueUrl === queueUrl);

describe("Strava webhook", () => {
  beforeEach(() => {
    vi.stubEnv("STRAVA_SUBSCRIPTION_ID", "7");
    vi.stubEnv("STRAVA_EVENTS_QUEUE_URL", STRAVA_QUEUE);
    vi.stubEnv("TRAINING_EVENTS_QUEUE_URL", TRAINING_QUEUE);
    vi.stubEnv("STRAVA_ATHLETE_ID", "42");
    vi.stubEnv("STRAVA_VERIFY_TOKEN", "verify-me");
    send.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe("forwarding to the Training sync", () => {
    it("forwards the rider's activity events as the raw event in the shared group", async () => {
      const response = await post({ ...event, updates: { title: "Renamed" } });
      expect(response.status).toBe(200);

      const [training] = sentTo(TRAINING_QUEUE);
      expect(training.MessageGroupId).toBe("strava-events");
      // The six Strava fields and nothing else: no envelope, no updates.
      expect(JSON.parse(training.MessageBody as string)).toEqual(event);
      // FIFO with content-based deduplication, so no id is invented here.
      expect(training.MessageDeduplicationId).toBeUndefined();
    });

    it("still enqueues for strava_worker first, unchanged", async () => {
      await post(event);
      expect(send).toHaveBeenCalledTimes(2);
      const [ingestion] = sentTo(STRAVA_QUEUE);
      expect(send.mock.calls[0][0].input.QueueUrl).toBe(STRAVA_QUEUE);
      expect(ingestion.MessageGroupId).toBeUndefined();
      const body = JSON.parse(ingestion.MessageBody as string);
      expect(body.event).toEqual(event);
      expect(typeof body.received_at).toBe("string");
    });

    it("does not forward another athlete's events", async () => {
      expect((await post({ ...event, owner_id: 1 })).status).toBe(200);
      expect(sentTo(TRAINING_QUEUE)).toHaveLength(0);
      expect(sentTo(STRAVA_QUEUE)).toHaveLength(1);
    });

    it("does not forward athlete events", async () => {
      const deauthorised = {
        ...event,
        object_type: "athlete",
        object_id: 42,
        aspect_type: "update",
        updates: { authorized: "false" },
      };
      expect((await post(deauthorised)).status).toBe(200);
      expect(sentTo(TRAINING_QUEUE)).toHaveLength(0);
      expect(sentTo(STRAVA_QUEUE)).toHaveLength(1);
    });

    it("does not forward when the Training queue is not configured", async () => {
      vi.stubEnv("TRAINING_EVENTS_QUEUE_URL", "");
      expect((await post(event)).status).toBe(200);
      expect(sentTo(TRAINING_QUEUE)).toHaveLength(0);
      expect(send).toHaveBeenCalledTimes(1);
    });

    it("does not forward when no athlete is configured", async () => {
      vi.stubEnv("STRAVA_ATHLETE_ID", "");
      expect((await post(event)).status).toBe(200);
      expect(sentTo(TRAINING_QUEUE)).toHaveLength(0);
    });

    it("asks Strava to retry when forwarding fails", async () => {
      send.mockImplementation(async (command: { input: { QueueUrl: string } }) => {
        if (command.input.QueueUrl === TRAINING_QUEUE) throw new Error("throttled");
        return {};
      });
      expect((await post(event)).status).toBe(500);
    });

    it("forwards even when the strava_worker queue is not configured", async () => {
      vi.stubEnv("STRAVA_EVENTS_QUEUE_URL", "");
      expect((await post(event)).status).toBe(200);
      expect(send).toHaveBeenCalledTimes(1);
      expect(sentTo(TRAINING_QUEUE)).toHaveLength(1);
    });
  });

  describe("existing behaviour", () => {
    it("rejects a body that is not JSON", async () => {
      expect((await post("{not json")).status).toBe(400);
      expect(send).not.toHaveBeenCalled();
    });

    it("acknowledges and drops events for another subscription", async () => {
      expect((await post({ ...event, subscription_id: 1 })).status).toBe(200);
      expect(send).not.toHaveBeenCalled();
    });

    it("acknowledges and drops events when no queue is configured", async () => {
      vi.stubEnv("STRAVA_EVENTS_QUEUE_URL", "");
      vi.stubEnv("TRAINING_EVENTS_QUEUE_URL", "");
      expect((await post(event)).status).toBe(200);
      expect(send).not.toHaveBeenCalled();
    });

    it("asks Strava to retry when the ingestion queue is unavailable, before forwarding", async () => {
      send.mockRejectedValueOnce(new Error("throttled"));
      expect((await post(event)).status).toBe(500);
      expect(send).toHaveBeenCalledTimes(1);
    });

    it("echoes the challenge for a valid subscription handshake", async () => {
      const response = await GET(
        new Request(
          "https://windchaser.example/api/strava/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=abc",
        ),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ "hub.challenge": "abc" });
    });

    it("refuses a handshake with the wrong token", async () => {
      const response = await GET(
        new Request(
          "https://windchaser.example/api/strava/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=abc",
        ),
      );
      expect(response.status).toBe(403);
    });
  });
});
