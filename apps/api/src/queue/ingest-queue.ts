import { PubSub, type Topic } from '@google-cloud/pubsub';
import { IngestTopicJobSchema, type IngestTopicJob } from '@kamutan/contracts';

export const INGEST_QUEUE = Symbol('INGEST_QUEUE');

/**
 * Port for scheduling work on topic `ingest` (ingest.sheet_version, boq.build, library.import — Sprint 3).
 * Payload is validated against the contract union before publishing.
 */
export interface IngestQueue {
  publish(payload: IngestTopicJob): Promise<{ messageId: string }>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export interface PublishedMessage {
  messageId: string;
  topic: string;
  attributes: Record<string, string>;
  data: IngestTopicJob;
}

/** Attributes let the push subscription / worker route and dedupe without parsing data. */
export function attributesFor(p: IngestTopicJob): Record<string, string> {
  return { type: p.type, jobId: p.jobId, orgId: p.orgId, schemaVersion: String(p.schemaVersion) };
}

/** Process-local queue for tests and offline dev. Nothing consumes it. */
export class InMemoryIngestQueue implements IngestQueue {
  readonly messages: PublishedMessage[] = [];

  constructor(private readonly topic = 'ingest') {}

  async publish(payload: IngestTopicJob): Promise<{ messageId: string }> {
    const data = IngestTopicJobSchema.parse(payload);
    const messageId = String(this.messages.length + 1);
    this.messages.push({ messageId, topic: this.topic, attributes: attributesFor(data), data });
    return { messageId };
  }

  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}

/**
 * Pub/Sub publisher for topic `ingest` (push subscription → Cloud Run worker,
 * with DLQ; ADR 0008). Delivery is at-least-once: the worker must treat
 * jobs/{jobId} as the idempotency key. Credentials: ADC; honours PUBSUB_EMULATOR_HOST.
 */
export class PubSubIngestQueue implements IngestQueue {
  private readonly client: PubSub;
  private readonly topic: Topic;

  constructor(projectId: string, topicName: string, client?: PubSub) {
    this.client = client ?? new PubSub({ projectId });
    this.topic = this.client.topic(topicName, { batching: { maxMessages: 1, maxMilliseconds: 0 } });
  }

  async publish(payload: IngestTopicJob): Promise<{ messageId: string }> {
    const data = IngestTopicJobSchema.parse(payload);
    const messageId = await this.topic.publishMessage({ json: data, attributes: attributesFor(data) });
    return { messageId };
  }

  /** Readiness: the API's SA only needs pubsub.publisher, so we don't call admin APIs here. */
  async ping(): Promise<void> {}

  async close(): Promise<void> {
    await this.client.close();
  }
}
