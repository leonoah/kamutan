import { PubSub, type Topic } from '@google-cloud/pubsub';
import { ApiTopicJobSchema, type ApiTopicJob } from '@kamutan/contracts';

export const API_JOBS_QUEUE = Symbol('API_JOBS_QUEUE');

/**
 * Port for work the API runs itself, out of the request (topic `api-jobs`, consumed by the `apiJobs` Cloud Function in
 * src/function.ts — 9-minute timeout instead of the HTTP function's 120 s). Today: `offboarding.export`.
 */
export interface ApiJobsQueue {
  publish(payload: ApiTopicJob): Promise<{ messageId: string }>;
}

/** Tests / offline dev: records messages; `drain()` hands them to a runner (nothing consumes them otherwise). */
export class InMemoryApiJobsQueue implements ApiJobsQueue {
  readonly messages: ApiTopicJob[] = [];
  /** When set (offline dev), every message is run right after publishing (fire and forget). */
  runner?: (job: ApiTopicJob) => Promise<void>;

  async publish(payload: ApiTopicJob): Promise<{ messageId: string }> {
    const data = ApiTopicJobSchema.parse(payload);
    this.messages.push(data);
    if (this.runner) void this.runner(data).catch(() => undefined);
    return { messageId: String(this.messages.length) };
  }
}

export class PubSubApiJobsQueue implements ApiJobsQueue {
  private readonly topic: Topic;

  constructor(projectId: string, topicName: string, client?: PubSub) {
    this.topic = (client ?? new PubSub({ projectId })).topic(topicName, { batching: { maxMessages: 1, maxMilliseconds: 0 } });
  }

  async publish(payload: ApiTopicJob): Promise<{ messageId: string }> {
    const data = ApiTopicJobSchema.parse(payload);
    const messageId = await this.topic.publishMessage({
      json: data,
      attributes: { type: data.type, jobId: data.jobId, orgId: data.orgId, schemaVersion: String(data.schemaVersion) },
    });
    return { messageId };
  }
}
