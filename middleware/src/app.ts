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
import { healthRoutes } from './api/routes/health';
import { masterDataRoutes } from './api/routes/master-data';
import { NotFoundError } from './shared/errors';

const OPENAPI_PATH = resolve(__dirname, '../openapi.yaml');

export function createApp(c: Container): express.Express {
  const app = express();
  app.disable('x-powered-by'); // don't advertise the framework to attackers
  app.set('trust proxy', 1); // behind one load balancer in the cloud

  app.use(requestContext());
  app.use(requestLogger(c.logger));

  // Health checks are public: load balancers call them without credentials.
  app.use(healthRoutes(c));

  app.get('/api/v1/openapi.yaml', (_req, res) => {
    res.type('application/yaml').send(readFileSync(OPENAPI_PATH, 'utf8'));
  });

  // Everything under /api/v1 needs a valid token. Small JSON limit: our payloads are small, and a
  // limit protects against memory exhaustion from huge bodies.
  const api = express.Router();
  api.use(express.json({ limit: '256kb' }));
  api.use(authenticate(c.config.API_TOKENS));
  api.use(masterDataRoutes(c));
  app.use('/api/v1', api);

  app.use((req, _res, next) => next(new NotFoundError(`Route ${req.method} ${req.path}`)));
  app.use(errorHandler(c.logger));
  return app;
}
