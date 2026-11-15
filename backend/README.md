# DDIN TC backend

This folder contains the API Gateway, Auth, Agents, Visits and Reports services, shared backend modules, Prisma schema and migrations, import data, and Docker files. The backend builds and runs from this folder without reading frontend or repository-root files. PostgreSQL remains an external dependency and must be reachable from the containers.

## Run the backend with Docker

Copy `.env.example` to `.env`. Set `DATABASE_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET` and `PII_ENCRYPTION_KEY`; configure any optional external API credentials as needed. Keep `FRONTEND_URL` set to the exact browser origin or comma-separated origins allowed to call the API. The local defaults allow the frontend at `http://localhost:8080` and the Vite development server at `http://localhost:5173`.

From this folder, run:

```bash
docker compose up --build -d
```

Compose builds all backend services from this folder, applies Prisma migrations before starting the API services, and exposes the API Gateway on port `3000`. Visit photos persist in the `visit-photos` Docker volume. The database is not created by this Compose file; point `DATABASE_URL` to a PostgreSQL database available to the containers.

## Backend contents

- `ApiGateway/` routes browser requests to the backend services.
- `AuthService/`, `AgentsService/`, `VisitsService/` and `ReportsService/` hold their service source and package manifests.
- `shared/`, `prisma/`, `scripts/` and `data/` contain modules and inputs used by the backend; they are all inside this folder.
- `compose.yaml` and the service Dockerfiles build the backend independently of the frontend.

To build locally without Compose, install the backend root dependencies and each service's dependencies from this folder, then generate the Prisma client and apply migrations with `npx prisma migrate deploy`. For a complete local stack, Docker Compose is the simplest run path.
