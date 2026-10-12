/**
 * Cloud Functions (2nd gen) entry point — `firebase deploy --only functions`
 * with source `apps/api` (package.json "main": "dist/function.js").
 * Firebase Hosting rewrites `/api/**` to this function (same origin, ADR 0008).
 */
import 'reflect-metadata';
import express, { type Express } from 'express';
import { defineSecret } from 'firebase-functions/params';
import { onRequest } from 'firebase-functions/v2/https';
import { createApp } from './bootstrap';
import { loadConfig } from './config/config';

const UPLOAD_TOKEN_SECRET = defineSecret('UPLOAD_TOKEN_SECRET');

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
