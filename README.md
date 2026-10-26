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
npm install
npm run dev
```

The Vite development server proxies `/api` to `http://backend:8000`, which is the Compose service name. For running Vite directly on the host, change the proxy target in `frontend/vite.config.js` to `http://localhost:8000`.

## 5. Deploy the backend to Render

The repository includes [`render.yaml`](render.yaml) with the service root, Python build/start commands, and health check. You can deploy with the Blueprint flow or enter the same settings manually.

### Blueprint flow

1. Push this repository to GitHub.
2. In Render, choose **New → Blueprint** and connect the repository.
3. Review the `wind-desk-api` web service settings from `render.yaml` and create the service.
4. Set the prompted `CORS_ORIGINS` value to the exact Vercel origin after creating the frontend (for example, `https://your-project.vercel.app`). Multiple origins can be comma-separated.
5. Wait for the deploy to finish and check `https://<render-service>.onrender.com/api/health`. It should return `{"status":"ok","service":"wind-desk-api"}`.

Equivalent manual Web Service settings:

| Setting | Value |
|---|---|
| Root Directory | `backend` |
| Runtime | Python 3 |
| Build Command | `pip install -r requirements.txt` |
| Start Command | `uvicorn main:app --host 0.0.0.0 --port $PORT` |
| Health Check Path | `/api/health` |
| `ELEXON_BASE_URL` | `https://data.elexon.co.uk/bmrs/api/v1` |
| `CORS_ORIGINS` | Exact deployed frontend origin(s), comma-separated |

The source cache is in process memory. A Render restart/cold start fetches the two historical Elexon streams again; concurrent requests within one process share the cached fetch.

## 6. Deploy the frontend to Vercel

1. In Vercel, choose **Add New → Project** and import the GitHub repository.
2. Set **Root Directory** to `frontend`.
3. Use the Vite defaults: build command `npm run build`, output directory `dist`, install command `npm ci`.
4. Add the environment variable below, using the Render URL from the previous section:

   ```text
   VITE_API_BASE=https://<render-service>.onrender.com
   ```

5. Deploy and open the generated Vercel URL. Check the browser network panel for `GET <Render URL>/api/wind` and confirm it succeeds without a CORS error.
6. If Vercel assigned a different production/preview hostname, add each intended frontend origin to Render's `CORS_ORIGINS`, then redeploy/restart the API.

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

Browser/data checks:

1. Opening the landing page makes no history request. Opening the dashboard fetches the history once; switching view/cutoff or returning to the dashboard reuses it.
2. January, week and day selectors show the expected 1,488, 336 (full week), and 48 half-hour rows. The last partial January week contains 144 periods.
3. Actuals are `FUELHH` WIND only. No delivery dates outside January 2026 or off-settlement 15-minute observations appear.
4. Forecast versions published after the selected D-1 cutoff are excluded. A version published exactly at cutoff remains eligible.
5. Missing half-hour forecasts use the mean of the two neighboring hourly values only when both are cutoff-eligible. The UI marks these estimates; it leaves unbracketed periods blank.
6. Reported and estimated forecasts are distinguished in the CSV and publication audit. The audit identifies the two source hours used by an estimated half-hour value.
7. MAE, RMSE and mean bias reflect the comparable forecast/actual intervals, including the disclosed estimates; residual signs follow `forecast − actual`.
8. Unavailable Elexon data shows an error state without substitute data.
9. `robots.txt` is available at `/robots.txt`; page title and meta description are present. Run Lighthouse against the production Compose page at `http://localhost:5173/`, not Vite's development server.
10. After deployment, verify `/api/health`, the Vercel-to-Render API request, and CORS for the exact Vercel origin.

## 8. AI disclosure

OpenAI Codex was used to interpret the challenge brief and assist with implementation, testing, UI changes, and documentation. The data source, cutoff, filtering, alignment, imputation, and metric conventions are stated above for review.

## 9. Deployment status

The Render/Vercel configuration and steps are prepared, but no hosted deployment has been created from this workspace yet. Add the live URLs here after deployment.
