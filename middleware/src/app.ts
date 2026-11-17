/**
 * Builds the Express application from a Container.
 *
 * WHY a function that RETURNS the app (instead of starting a server here): tests call createApp()
 * and send requests in memory with supertest. No port, no network, fast and isolated.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import type { Container } from './container';
import { authenticate, errorHandler, requestContext, requestLogger } from './api/http';
import { apRoutes } from './api/routes/ap';
import { arRoutes } from './api/routes/ar';
import { devRoutes } from './api/routes/dev';
import { healthRoutes } from './api/routes/health';
import { integrationRoutes } from './api/routes/integration';
import { masterDataRoutes } from './api/routes/master-data';
import { portalRoutes } from './api/routes/portal';
import { reconciliationRoutes } from './api/routes/reconciliation';
import { webhookRoutes } from './api/routes/webhooks';
import { NotFoundError } from './shared/errors';

const OPENAPI_PATH = resolve(__dirname, '../openapi.yaml');
const PORTAL_DIR = resolve(__dirname, '../../portal/local-prototype');

export function createApp(c: Container): express.Express {
  const app = express();
  app.disable('x-powered-by'); // don't advertise the framework to attackers
  app.set('trust proxy', 1); // behind one load balancer in the cloud

  app.use(requestContext());
  app.use(requestLogger(c.logger));

  // Health checks are public: load balancers call them without credentials.
  app.use(healthRoutes(c));

  // Webhooks authenticate by signature (not bearer token) and need the raw body, so they are mounted
  // before the JSON parser and the token check.
  app.use(webhookRoutes(c));

  // Customer portal prototype (static files). A Content-Security-Policy allows only our own scripts,
  // so even if HTML injection happened, injected inline <script> would not run.
  app.use(
    '/portal',
    (_req, res, next) => {
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'",
      );
      res.setHeader('X-Content-Type-Options', 'nosniff');
      next();
    },
    express.static(PORTAL_DIR),
  );
  if (c.config.NODE_ENV !== 'production') app.use(devRoutes(c)); // simulated checkout: never in production

  app.get('/api/v1/openapi.yaml', (_req, res) => {
    res.type('application/yaml').send(readFileSync(OPENAPI_PATH, 'utf8'));
  });

  // Everything under /api/v1 needs a valid token. Small JSON limit: our payloads are small, and a
  // limit protects against memory exhaustion from huge bodies.
  const api = express.Router();
  api.use(express.json({ limit: '256kb' }));
  api.use(authenticate(c.config.API_TOKENS));
  api.use(masterDataRoutes(c));
  api.use(integrationRoutes(c));
  api.use(apRoutes(c));
  api.use(arRoutes(c));
  api.use(portalRoutes(c));
  api.use(reconciliationRoutes(c));
  app.use('/api/v1', api);

  app.use((req, _res, next) => next(new NotFoundError(`Route ${req.method} ${req.path}`)));
  app.use(errorHandler(c.logger));
  return app;
}
