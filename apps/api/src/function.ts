/**
 * Cloud Functions (2nd gen) entry point — `firebase deploy --only functions`
 * with source `apps/api` (package.json "main": "dist/function.js").
 * Firebase Hosting rewrites `/api/**` to this function (same origin, ADR 0008).
 */
import 'reflect-metadata';
import { ApiTopicJobSchema, JOB_TYPES, TOPICS } from '@kamutan/contracts';
import express, { type Express } from 'express';
import { setGlobalOptions } from 'firebase-functions/v2';
import { defineSecret, defineString } from 'firebase-functions/params';
import { onRequest } from 'firebase-functions/v2/https';
import { onMessagePublished } from 'firebase-functions/v2/pubsub';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApp } from './bootstrap';
import { loadConfig } from './config/config';
import { DependentsService } from './governance/dependents.service';
import { OffboardingService } from './governance/offboarding.service';

const UPLOAD_TOKEN_SECRET = defineSecret('UPLOAD_TOKEN_SECRET');

/**
 * R-A8 (infra/IAM.md §3): every function (api, apiJobs, reprocessDependents) runs as the least-privilege runtime SA,
 * never the default compute SA. `kamutan-api@` (trailing `@`) is expanded by the Firebase CLI to
 * `kamutan-api@<project>.iam.gserviceaccount.com`, so staging/production differ automatically; override per project
 * with the `API_SERVICE_ACCOUNT` param (`.env.<project>`). Emulators ignore it.
 */
export const API_SERVICE_ACCOUNT = defineString('API_SERVICE_ACCOUNT', {
  default: 'kamutan-api@',
  description: 'Runtime service account of the API functions (infra/IAM.md §3)',
});
setGlobalOptions({ serviceAccount: API_SERVICE_ACCOUNT });

let ready: Promise<Express> | undefined;

/** Boots NestJS once per instance and reuses it across requests. */
function server(): Promise<Express> {
  ready ??= (async () => {
    const instance = express();
    const app = await createApp(loadConfig(process.env), instance);
    await app.init();
    return instance;
  })().catch((err: unknown) => {
    ready = undefined; // retry boot on the next request
    throw err;
  });
  return ready;
}

export const api = onRequest(
  {
    region: 'europe-west1',
    memory: '1GiB',
    timeoutSeconds: 120,
    concurrency: 40,
    secrets: [UPLOAD_TOKEN_SECRET],
    invoker: 'public', // auth is enforced per route with Firebase ID tokens
  },
  async (req, res) => {
    try {
      const app = await server();
      app(req as unknown as express.Request, res as unknown as express.Response);
    } catch {
      // Config errors list variable names only; never echo values.
      res.status(503).json({ error: { code: 'service_unavailable', message: 'service starting', requestId: null } });
    }
  },
);

let jobsApp: Promise<NestExpressApplication> | undefined;

/** Nest application for the background-jobs function (same module graph, no HTTP listener). */
function jobsContext(): Promise<NestExpressApplication> {
  jobsApp ??= (async () => {
    const app = await createApp(loadConfig(process.env));
    await app.init();
    return app;
  })().catch((err: unknown) => {
    jobsApp = undefined;
    throw err;
  });
  return jobsApp;
}

/**
 * Sprint 5: the API's own background jobs (topic `api-jobs`; Firebase deploy creates the topic). Today only
 * `offboarding.export` (streams a ZIP of the org into Storage — longer than an HTTP request may take).
 * No automatic retry: a failed export is marked `failed` and the admin requests a new one; the runner is idempotent
 * for at-least-once redelivery (a `ready` export is never rebuilt).
 */
export const apiJobs = onMessagePublished(
  {
    topic: TOPICS.apiJobs,
    region: 'europe-west1',
    memory: '2GiB',
    timeoutSeconds: 540,
    retry: false,
    secrets: [UPLOAD_TOKEN_SECRET],
  },
  async (event) => {
    const job = ApiTopicJobSchema.parse(event.data.message.json);
    const app = await jobsContext();
    if (job.type === JOB_TYPES.offboardingExport) await app.get(OffboardingService, { strict: false }).runExport(job);
  },
);

/**
 * Sprint 5 (Worker-B): every minute, due `reprocessRequests/{sheetId}` → new sheet version + `ingest.sheet_version`
 * job (idempotent claims; see DependentsService). Cloud Scheduler job is created by `firebase deploy`.
 */
export const reprocessDependents = onSchedule(
  { schedule: 'every 1 minutes', region: 'europe-west1', timeZone: 'UTC', memory: '512MiB', timeoutSeconds: 120, retryCount: 0, secrets: [UPLOAD_TOKEN_SECRET] },
  async () => {
    const app = await jobsContext();
    await app.get(DependentsService, { strict: false }).runDue();
  },
);
