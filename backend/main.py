import asyncio
from datetime import date, datetime, time, timedelta, timezone
import os
import math
from typing import Any
from zoneinfo import ZoneInfo

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Wind Desk API", version="1.0.0")
cors_origins = [
    origin.strip()
    for origin in os.getenv(
        "CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"
    ).split(",")
    if origin.strip()
]
app.add_middleware(CORSMiddleware, allow_origins=cors_origins, allow_methods=["GET"], allow_headers=["*"])
BASE = os.getenv("ELEXON_BASE_URL", "https://data.elexon.co.uk/bmrs/api/v1").rstrip("/")
LONDON = ZoneInfo("Europe/London")
JAN_START = date(2026, 1, 1)
JAN_END = date(2026, 1, 31)
_RAW_CACHE: tuple[list[dict], list[dict]] | None = None
_RAW_LOCK = asyncio.Lock()


def parse_dt(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


def number(value: Any) -> float | None:
    try:
        result = float(value) if value is not None else None
        return result if result is not None and math.isfinite(result) else None
    except (ValueError, TypeError):
        return None


async def fetch_stream(code: str, start: date, end: date, extra: dict[str, str] | None = None) -> list[dict]:
    url = f"{BASE}/datasets/{code}/stream"
    # These dataset streams are windowed by publication time. The older generic
    # from/to parameters are ignored for these endpoints, which silently gives
    # the latest records instead of the requested historical delivery window.
    params = {
        "publishDateTimeFrom": f"{start.isoformat()}T00:00Z",
        "publishDateTimeTo": f"{(end + timedelta(days=1)).isoformat()}T00:00Z",
    }
    params.update(extra or {})
    async with httpx.AsyncClient(timeout=40) as client:
        response = await client.get(url, params=params)
        response.raise_for_status()
        payload = response.json()
    if isinstance(payload, dict):
        payload = payload.get("data", payload.get("results", []))
    return payload if isinstance(payload, list) else []


def key_time(row: dict) -> datetime | None:
    return parse_dt(row.get("startTime") or row.get("start_time"))


async def get_month_streams() -> tuple[list[dict], list[dict]]:
    """Fetch the fixed historical window once per API process; coalesce concurrent requests."""
    global _RAW_CACHE
    if _RAW_CACHE is not None:
        return _RAW_CACHE
    async with _RAW_LOCK:
        if _RAW_CACHE is not None:
            return _RAW_CACHE
        actuals, forecasts = await asyncio.gather(
            fetch_stream("FUELHH", JAN_START, JAN_END, {"fuelType": "WIND"}),
            fetch_stream("WINDFOR", JAN_START - timedelta(days=1), JAN_END),
        )
        _RAW_CACHE = (actuals, forecasts)
        return _RAW_CACHE


def forecast_for(dt: datetime, versions: list[dict], cutoff_hour: int) -> dict | None:
    local_delivery = dt.astimezone(LONDON)
    cutoff = datetime.combine(
        local_delivery.date() - timedelta(days=1), time(cutoff_hour), tzinfo=LONDON
    ).astimezone(timezone.utc)
    eligible = [v for v in versions if parse_dt(v["publishTime"]) <= cutoff]
    return max(eligible, key=lambda row: row["publishTime"], default=None)


def summarize(periods: list[dict], cutoff_hour: int) -> dict:
    comparable = []
    latest_publication = None
    forecast_coverage = 0
    imputed_coverage = 0
    reported_matches = 0
    imputed_matches = 0
    selected_by_time = {}
    for period in periods:
        dt = parse_dt(period["startTime"])
        selected = forecast_for(dt, period["forecasts"], cutoff_hour)
        selected_by_time[dt] = selected
        if selected:
            forecast_coverage += 1
            latest_publication = max(latest_publication or selected["publishTime"], selected["publishTime"])

    forecast_values = {
        dt: {"generation": selected["generation"], "imputed": False}
        for dt, selected in selected_by_time.items() if selected is not None
    }
    for dt, selected in selected_by_time.items():
        if selected is not None or dt.minute != 30:
            continue
        previous_hour = forecast_values.get(dt - timedelta(minutes=30))
        next_hour = forecast_values.get(dt + timedelta(minutes=30))
        if previous_hour is None or next_hour is None:
            continue
        forecast_values[dt] = {
            "generation": (previous_hour["generation"] + next_hour["generation"]) / 2,
            "imputed": True,
        }
        imputed_coverage += 1

    for period in periods:
        dt = parse_dt(period["startTime"])
        actual = period["actual"]
        forecast = forecast_values.get(dt)
        if actual is not None and forecast is not None:
            comparable.append((forecast["generation"] - actual))
            if forecast["imputed"]:
                imputed_matches += 1
            else:
                reported_matches += 1
    count = len(comparable)
    return {
        "periodCount": len(periods),
        "matchedCount": count,
        "actualCoverage": sum(period["actual"] is not None for period in periods),
        "forecastCoverage": forecast_coverage + imputed_coverage,
        "reportedForecastCount": forecast_coverage,
        "imputedForecastCount": imputed_coverage,
        "reportedMatchedCount": reported_matches,
        "imputedMatchedCount": imputed_matches,
        "mae": sum(abs(error) for error in comparable) / count if count else None,
        "rmse": (sum(error * error for error in comparable) / count) ** 0.5 if count else None,
        "meanBias": sum(comparable) / count if count else None,
        "latestPublishTime": latest_publication,
    }


@app.get("/api/health")
def health():
    return {"status": "ok", "service": "wind-desk-api"}


@app.get("/api/wind")
async def wind_data(
    start: date = Query(date(2026, 1, 1)),
    end: date = Query(date(2026, 1, 31)),
    cutoff_hour: int = Query(11, ge=9, le=15),
):
    if start != JAN_START or end != JAN_END:
        raise HTTPException(400, "This endpoint returns the fixed January 2026 delivery window")
    try:
        actual_rows, forecast_rows = await get_month_streams()
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(502, f"Elexon data request failed: {str(exc)[:240]}") from exc

    actuals: dict[datetime, float] = {}
    for row in actual_rows:
        if row.get("fuelType") != "WIND":
            continue
        dt, value = key_time(row), number(row.get("generation"))
        if is_settlement_start(dt) and start <= dt.astimezone(LONDON).date() <= end and value is not None:
            actuals[dt] = value

    forecasts: dict[datetime, list[tuple[datetime, float]]] = {}
    for row in forecast_rows:
        dt = key_time(row)
        published = parse_dt(row.get("publishTime") or row.get("publish_time"))
        value = number(row.get("generation"))
        if (
            is_settlement_start(dt)
            and start <= dt.astimezone(LONDON).date() <= end
            and published
            and value is not None
        ):
            forecasts.setdefault(dt, []).append((published, value))

    periods = []
    for dt in sorted(set(actuals) | set(forecasts)):
        local_delivery = dt.astimezone(LONDON)
        versions = [
            {"publishTime": published.isoformat(), "generation": value}
            for published, value in sorted(forecasts.get(dt, []))
        ]
        periods.append({
            "startTime": dt.isoformat(), "localTime": local_delivery.strftime("%d %b %H:%M"),
            "actual": actuals.get(dt), "forecasts": versions,
        })
    summaries_by_range: dict[str, dict] = {}
    date_ranges = [(JAN_START, JAN_END)]
    date_ranges.extend((date(2026, 1, day), date(2026, 1, day)) for day in range(1, 32))
    date_ranges.extend(
        (date(2026, 1, day), date(2026, 1, min(day + 6, JAN_END.day)))
        for day in range(1, 32, 7)
    )
    for range_start, range_end in date_ranges:
        scoped = [
            period for period in periods
            if range_start <= parse_dt(period["startTime"]).astimezone(LONDON).date() <= range_end
        ]
        key = f"{range_start.isoformat()}_{range_end.isoformat()}"
        summaries_by_range[key] = {str(hour): summarize(scoped, hour) for hour in range(9, 16)}
    month_key = f"{JAN_START.isoformat()}_{JAN_END.isoformat()}"
    return {
        "periods": periods,
        "summaryByCutoff": summaries_by_range[month_key],
        "summaryByRange": summaries_by_range,
        "summary": summaries_by_range[month_key][str(cutoff_hour)],
        "source": "Elexon BMRS FUELHH (WIND) and WINDFOR",
        "cutoff": f"{cutoff_hour:02d}:00 Europe/London on the preceding day",
    }


def is_settlement_start(dt: datetime | None) -> bool:
    return bool(dt and dt.second == 0 and dt.microsecond == 0 and dt.minute in (0, 30))
