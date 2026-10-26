# Wind Desk

> **A transparent January 2026 day-ahead wind forecast evaluation for Great Britain**

Wind Desk compares Elexon BMRS wind forecasts with actual generation. It is designed to make the delivery window, forecast cutoff, data resolution, and forecast revisions easy to inspect.

## 1. What the dashboard does

- Reads actual generation from Elexon `FUELHH`, retaining only `fuelType == "WIND"`.
- Reads forecast snapshots from Elexon `WINDFOR`.
- Restricts delivery periods to January 1–31, 2026 and aligns records on their UTC `startTime`.
- Selects the latest forecast published by the chosen cutoff on the preceding UK day. The default cutoff is 11:00 GMT; the dashboard can compare 09:00–15:00.
- Shows January, selectable week, and selectable day views with a forecast/actual chart, MAE, RMSE, mean bias, peak summaries, a residual distribution, and a publication audit.
- Loads the historical source streams in parallel and caches them once per backend process. Changing the view or cutoff does not fetch the data again.

## 2. Data resolution and forecast estimates

Actual `FUELHH` observations are half-hourly. `WINDFOR` forecast snapshots are generally hourly, so an exact forecast may not exist at every half-hour delivery start.

For a missing half-hour forecast, Wind Desk now uses the arithmetic mean of the two adjacent hourly forecast values **when both values are available by the selected cutoff**:

```text
half-hour estimate = (preceding hourly forecast + following hourly forecast) / 2
```

An existing forecast at the half-hour timestamp takes precedence. Wind Desk does not carry values forward or extrapolate at the beginning/end of a delivery day. If either neighboring hourly forecast is unavailable by cutoff, the forecast stays blank and that period is excluded from the error metrics. The footer explains the estimate method; the chart tooltip, CSV export, and revision audit identify the estimates. Delivery Periods keeps the forecast values clean without a per-row estimate label. Summary payloads distinguish reported forecast counts from arithmetic-mean estimates.

The residual convention is `forecast − actual`: positive means over-forecasting; negative means under-forecasting. MAE, RMSE, mean bias, and the residual histogram use comparable actual/forecast pairs, including clearly labeled arithmetic-mean estimates.

## 3. Architecture and file map

```text
Energy/
├── backend/
│   ├── main.py              # FastAPI routes, Elexon fetch/cache, filtering, cutoff and metrics
│   ├── test_main.py         # API, cutoff, source filtering and half-hour mean tests
│   ├── requirements.txt     # Python dependencies
│   └── Dockerfile           # Backend container
├── frontend/
│   ├── src.jsx              # Landing page, dashboard, chart, histogram, audit and table
│   ├── style.css            # Responsive styling and contrast adjustments
│   ├── index.html           # Page title, SEO description and theme metadata
│   ├── public/robots.txt    # Crawler rules
│   ├── vite.config.js       # Development/preview API proxy
│   ├── package.json         # React and Vite dependencies/scripts
│   ├── package-lock.json    # Reproducible frontend dependency versions
│   ├── vercel.json          # Vercel security response headers
│   └── Dockerfile           # Builds and serves the optimized Vite bundle
├── .gitignore               # Excludes local secrets, build output and challenge brief
├── docker-compose.yml       # Local frontend + backend services
├── render.yaml              # Render Python web service blueprint
└── README.md                # Setup, method, verification and deployment guide
```

## 4. Run locally

### Docker Compose

Requires Docker Desktop with Docker Compose.

```bash
docker compose up --build
```

- Landing page and dashboard: http://localhost:5173
- Backend health check: http://localhost:8000/api/health
- FastAPI OpenAPI docs: http://localhost:8000/docs

The frontend container builds and serves Vite's production bundle on port 5173. Its preview proxy sends `/api` requests to the backend container.

### Run services separately

Backend (Python 3.12+):

```bash
cd backend
python -m pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

Frontend (Node.js 20+), in a second terminal:

```bash
cd frontend
npm ci
npm run dev
```

The Vite development server proxies `/api` to `http://backend:8000`, which is the Compose service name. For running Vite directly on the host, change the proxy target in `frontend/vite.config.js` to `http://localhost:8000`.

## 5. Live deployment

- **Frontend:** [https://dniwku.vercel.app](https://dniwku.vercel.app)
- **Backend API:** [https://wind-forecast-vby2.onrender.com](https://wind-forecast-vby2.onrender.com)
- **Backend health:** [https://wind-forecast-vby2.onrender.com/api/health](https://wind-forecast-vby2.onrender.com/api/health)

The frontend is hosted on Vercel and calls the Render API using `VITE_API_BASE`. The Render service is a Docker web service rooted at `backend/` and uses `backend/Dockerfile`.

The included `render.yaml` is an alternative Native Python Blueprint configuration; the live service was created with the Docker runtime.

Render environment variables:

| Setting | Value |
|---|---|
| Root Directory | `backend` |
| Runtime | Docker |
| `PORT` | `8000` (matches the backend container command) |
| Health Check Path | `/api/health` |
| `ELEXON_BASE_URL` | `https://data.elexon.co.uk/bmrs/api/v1` |
| `CORS_ORIGINS` | `https://dniwku.vercel.app` |

`ELEXON_BASE_URL` has the same default in the backend and may be omitted. `PORT` is set to 8000 because the Docker image's Uvicorn command listens on that port. `CORS_ORIGINS` must contain the exact deployed frontend origin; separate multiple origins with commas. The source cache is in process memory, so a Render restart/cold start fetches both historical Elexon streams again.

## 6. Deploy the frontend to Vercel

The live frontend is deployed at [https://dniwku.vercel.app](https://dniwku.vercel.app). To reproduce or update the deployment:

1. Import the GitHub repository in Vercel and set **Root Directory** to `frontend`.
2. Use the Vite build command `npm run build`, output directory `dist`, and install command `npm ci`.
3. Set this environment variable for Production (and Preview if needed):

   ```text
   VITE_API_BASE=https://wind-forecast-vby2.onrender.com
   ```

4. Deploy and check the browser network panel for the `/api/wind` request. If you use another Vercel hostname, add its exact origin to Render's `CORS_ORIGINS` and redeploy the API.

`VITE_API_BASE` is embedded at frontend build time. Set or change it in Vercel before redeploying. The included `frontend/vercel.json` adds security response headers; the frontend metadata includes a description and a valid `robots.txt`.

## 7. Verification

Run the backend suite in the Compose container:

```bash
docker compose exec backend python -m unittest -v test_main
```

Build the frontend:

```bash
docker compose exec frontend npm run build
```

## 8. AI disclosure

OpenAI Codex was used to interpret the challenge brief and assist with testing, UI changes, and documentation.

## 9. Deployment status

The frontend and backend are deployed at the links in the Live deployment section above. The project can also be started locally with Docker Compose.
