# DDIN TC frontend

The React application is self-contained in this folder. It needs a reachable DDIN API Gateway; it does not read files from the repository root or from `backend/` at build time.

## Run locally

Install dependencies and start Vite:

```bash
npm ci
npm run dev -- --host 0.0.0.0
```

By default, Vite forwards `/api` and `/uploads` requests to `http://localhost:3000`. Set `VITE_API_URL` in `.env` when the API Gateway is hosted at another address. The backend must allow the frontend origin in `FRONTEND_URL` when the browser calls a different origin directly.

## Run this folder with Docker

Copy `.env.example` to `.env`, set `VITE_API_URL` to the browser-reachable API Gateway URL, then run:

```bash
docker compose up --build -d
```

Open `http://localhost:8080`. `VITE_API_URL` is included in the static bundle at build time, so rebuild the image after changing it. Set the backend's `FRONTEND_URL` to `http://localhost:8080` for local use, or to the deployed frontend origin.

To build without Docker, run `npm ci` and `npm run build`; the static bundle is written to `dist/`.
