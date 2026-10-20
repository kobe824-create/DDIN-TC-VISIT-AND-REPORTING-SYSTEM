# DDIN TC Agent Visit & Reporting System

This application manages TC assignments, agent registration, GPS-verified field visits, photo evidence and visit reports. PostgreSQL stores the operational data. The browser application is a PWA for TC field work and can save visits to a device while disconnected.

## Services

| Service | Responsibility | Local port |
| --- | --- | ---: |
| API Gateway | Routes authenticated API traffic | 3000 |
| AuthService | Login, token refresh, users, roles and audit events | 3001 |
| AgentsService | Agents, territories, TC assignments and location history | 3002 |
| VisitsService | GPS check-in, photos, reports, check-out and visit history | 3003 |
| ReportsService | Dashboards, reports, CSV exports, audit logs and system settings | 3004 |
| Frontend | React PWA served by Nginx | 5173 |

All application services use the shared schema in `prisma/schema.prisma`. PostgreSQL is external to Compose. The current visit-photo volume is local to one Docker host.

## Offline field workflow

TCs must sign in while connected once so the app can cache the application shell, their assigned territories, agents, checklist and geofence setting. Before field work, a TC selects the district and optional sectors, cells or villages to visit that day. At an agent's first visit, the TC records the agent's sector, cell, village and precise GPS point. That first-visit location can be captured locally and is verified by the server during sync; it is locked afterward. If an agent moved to another district before the first visit, the current TC requests a handoff to a TC assigned there, who records the new location. Administrators handle relocations after the first visit. Photos and reports are saved in browser IndexedDB. The app syncs completed visits when the connection returns, with foreground retries and Background Sync where the browser supports it.

The offline agent package is refreshed at login and when a connection returns. A TC switching devices must download their field package on each device. Keep the browser's site data until pending visits have synchronized. Browser GPS, camera access and service-worker installation require HTTPS in deployed environments; `localhost` is allowed for local use.

## Visit photo uploads and request logs

Visit evidence is uploaded with `PUT /api/v1/visits/:visitId/photo`. The API Gateway forwards it to `visits-service`, which writes the file under `/app/VisitsService/uploads`; Compose persists that directory in the `visit-photos` named volume. The file itself is not stored in PostgreSQL. The frontend scales camera captures to at most 1280 pixels and shows upload progress. Failed uploads include a request ID that can be matched to service logs.

Follow slow requests, errors and photo uploads with:

```bash
docker compose logs -f --tail=200 api-gateway visits-service
```

Gateway log entries include the request ID, upstream service, status, duration and request size. VisitsService adds the photo byte count and separate time spent receiving the upload, looking up the visit and saving photo metadata. For larger deployments, replace the host-local `visit-photos` volume with shared object storage and serve images through a CDN before scaling VisitsService across hosts.

Compose container checks use the lightweight `/health` liveness endpoints so repeated probes do not compete with application traffic for PostgreSQL connections. The `/ready` endpoints remain available when an operator or load balancer needs a database-readiness check.

## Local setup

1. Copy `.env.example` to `.env` and set `DATABASE_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `PII_ENCRYPTION_KEY` and the browser-facing `FRONTEND_URL`. Generate the PII key with `openssl rand -base64 32`, store it in a secrets manager and keep a secure backup. Use separate random JWT secrets outside development. Ensure the database hostname is reachable from the containers, and enable TLS for hosted PostgreSQL.
2. Install dependencies in the repository root, each service directory and `frontend` with `npm ci`.
3. Apply pending migrations to the selected database:

   ```bash
   npx prisma migrate deploy
   ```

4. Start the services with `./start-dev.sh`. It uses ports 3000–3004 and 5173 and exits if a port is occupied.

The demo seed script is blocked when `NODE_ENV=production`. It creates two demo TCs, each with a separate demo district and agent, plus the demo Admin if one does not exist. Run it only against a database reserved for demos: `DEMO_SEED_ENABLED=true npm run seed:demo`. New TC accounts use `TC_INITIAL_PASSWORD`, must change it at first sign-in, and the temporary password expires after 24 hours.

`npm run reset:demo` defaults to a dry run. It reports the demo records in scope and stops if another active TC or visit is linked to a demo territory. To apply a reviewed reset in a non-production demo environment, set `DEMO_RESET_ENABLED=true`, pass `--apply`, and set `DEMO_PHOTO_STORAGE_DIR` to the visit-photo volume path. The reset keeps `demo-admin`, removes the old demo records and photo files, then creates two new TC accounts with different territories and agents. Never run it against a shared or production database.

## Docker Compose

Set `.env` with a PostgreSQL URL reachable from the containers. Compose binds the frontend to `127.0.0.1:${FRONTEND_PORT:-5173}` and the gateway to `127.0.0.1:3000`; neither is exposed to the public interface by default.

```bash
npx prisma migrate deploy
docker compose up --build -d
```

Open `http://localhost:5173`. Compose includes service health checks, restart policies and a persistent visit-photo volume. A one-shot initializer repairs the volume directory ownership before VisitsService starts; application containers run as non-root users. Keep the app behind an HTTPS reverse proxy or load balancer for field devices; point `FRONTEND_URL` at the public origin and restrict direct access to the host ports.

## Bulk registration and source workbook notes

An Admin can upload `.xlsx` or `.csv` files from **Bulk registration**. Preview displays rows ready to import, existing matches, warnings and held records before a separate commit. Agent rows create province/district/sector hierarchy and create cells and villages when those columns are present; rows are inserted in chunks. Repeat imports skip matching existing agent IDs and fill in missing contact and personal details. In the supplied March agent roster, valid Rwanda mobile numbers in `AGENT USERNAME` populate the agent phone field; explicit agent phone columns take priority, and next-of-kin phone stays separate. National IDs and next-of-kin details are encrypted with AES-256-GCM before storage, are only decrypted for Admin agent-detail views, and are removed from other API responses. Preserve `PII_ENCRYPTION_KEY` in a secrets manager and a secure backup; losing it makes those values unreadable. TC imports require existing districts and `TC_INITIAL_PASSWORD` to be configured in the server environment. Incoming TCs without confirmed contacts may use a blank phone and a reserved `@ddin.test` email; update their profile once their details are known. All TCs created by one or more imports share that temporary password, which is shown once, expires after 24 hours and must be changed at first sign-in. Deliver it securely and have each TC set a different private password.

The supplied agent workbook has more rows than its filename suggests and 77 repeated agent-code groups whose records conflict. The importer holds every row in those groups for review rather than choosing a person automatically. Blank sector values are imported without a sector and need correction before the agent can have a visit. The supplied TC list covers 25 districts; it does not assign a TC to five districts found in the agent workbook. Province spellings and the likely `Gastibo`/`Gatsibo` typo are normalized during import.

## Deployment and capacity

Before a public launch:

1. Use a managed PostgreSQL deployment with high availability, encrypted backups and point-in-time recovery. Apply Prisma migrations as a one-off release step, never from each app replica.
2. Put a TLS-terminating load balancer/reverse proxy in front of the frontend and API gateway. Keep internal service ports private and set the allowed browser origin.
3. Move uploaded visit photos from the Compose named volume to shared object storage before running more than one VisitsService replica. The current local volume is suitable for a single host only.
4. Run the stateless API containers on a managed container platform; add resource requests/limits, autoscaling, log aggregation, alerting and deployment health checks. Keep JWT/database and PII encryption secrets in a secrets manager. Back up the PII key separately from the database.
5. Verify database connection pooling and run capacity tests against the expected number of TCs and visits before setting production replica counts or an availability target.

The PDF also proposes Redis, Elasticsearch, object storage and a Kubernetes/Terraform/CI/CD path. This repository currently implements PostgreSQL, the Compose container setup, local photo storage, query indexes and application health checks; Redis, Elasticsearch, cloud object storage, infrastructure-as-code, CI/CD, automated blue/green deployment and load-test evidence are not configured here. Do not treat the PDF's 99.9% availability, 500 concurrent-user or response-time targets as verified for this codebase yet.

## Access levels

- **Admin:** user and territory administration, bulk registration, visit settings and audit trail.
- **Manager:** assigned management views and authorized agent/territory administration.
- **TC:** agents and visits in assigned districts; may register agents and record visits.
- **Champion:** agents and visit records linked to their assigned sector.
- **Agent:** own account profile in the current web app.

The API enforces roles and territory permissions independently of frontend navigation. Keep `.env` files and one-time credential exports out of source control. Rotate any secret that has been shared or exposed.
