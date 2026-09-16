import 'reflect-metadata';
import { Logger, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { randomUUID } from 'node:crypto';
import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const logger = new Logger('bootstrap');

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      // A request id on every request and every error body, so a cashier's
      // screenshot of an error maps to exactly one log line.
      genReqId: () => randomUUID(),
      // Trust the proxy only when explicitly configured. Trusting it blindly
      // lets a client spoof X-Forwarded-For and defeat per-IP rate limiting.
      trustProxy: process.env.TRUST_PROXY === 'true',
      // Was 8 MiB, sized for the JSON bodies every other route sends. Raised
      // to fit an uploaded invoice (a scanned PDF or a phone photo) through
      // the same connection-level ceiling every route shares -- Fastify
      // checks this before any body parser runs, so a per-route override
      // can't let a large upload through a smaller global limit. The actual
      // per-file cap for uploads is `@fastify/multipart`'s own `fileSize`
      // limit below, set tighter than this.
      bodyLimit: 20 * 1024 * 1024,
    }),
    { bufferLogs: true },
  );

  await app.register(helmet, {
    // The API serves JSON, never HTML, so a restrictive CSP costs nothing.
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
  });

  await app.register(multipart, {
    limits: {
      // Two, not one: a product photo is uploaded together with the thumbnail
      // the browser scaled from it, so that a picture and its thumbnail can
      // never get out of step with each other. Every other upload in the API
      // sends a single file and is unaffected; the point of the limit is to
      // refuse someone posting fifty, and it still does.
      files: 2,
      fileSize: 15 * 1024 * 1024,
    },
  });

  await app.register(rateLimit, {
    max: Number(process.env.RATE_LIMIT_MAX ?? 300),
    timeWindow: '1 minute',
    // Keyed by authenticated user where possible, so one busy register cannot
    // exhaust the budget for every other register behind the same shop IP.
    keyGenerator: (request: { headers: Record<string, unknown>; ip: string }) => {
      const auth = request.headers['authorization'] as string | undefined;
      return auth ? `t:${auth.slice(-32)}` : `ip:${request.ip}`;
    },
  });

  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.setGlobalPrefix('api', { exclude: ['health', 'health/ready'] });

  const origins = process.env.CORS_ORIGINS?.split(',').filter(Boolean);
  if (origins?.length) {
    app.enableCors({ origin: origins, credentials: true });
  }

  // Drain in-flight requests before exit. A sale upload cut off mid transaction
  // would be retried anyway, but a clean shutdown avoids the noise.
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ port, host: '0.0.0.0' });

  logger.log(`SnapPOS API listening on :${port}`);
}

void bootstrap();
