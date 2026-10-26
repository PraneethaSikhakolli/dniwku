import unittest
from datetime import date
from unittest.mock import AsyncMock, patch

import httpx

import main as main_module
from main import app


class WindApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        main_module._RAW_CACHE = None
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")

    async def asyncTearDown(self):
        await self.client.aclose()

    async def test_rejects_delivery_outside_january_2026(self):
        response = await self.client.get("/api/wind", params={"start": "2025-12-31", "end": "2026-01-02"})
        self.assertEqual(response.status_code, 400)
        self.assertIn("January 2026", response.json()["detail"])

    async def test_cors_allows_configured_local_frontend_only(self):
        allowed = await self.client.options(
            "/api/health",
            headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "GET"},
        )
        rejected = await self.client.options(
            "/api/health",
            headers={"Origin": "https://unconfigured.example", "Access-Control-Request-Method": "GET"},
        )
        self.assertEqual(allowed.headers.get("access-control-allow-origin"), "http://localhost:5173")
        self.assertNotIn("access-control-allow-origin", rejected.headers)

    async def test_filters_wind_aligns_half_hours_and_excludes_late_forecasts(self):
        actuals = [
            {"fuelType": "WIND", "startTime": "2026-01-01T00:00:00Z", "generation": 100},
            {"fuelType": "CCGT", "startTime": "2026-01-01T00:00:00Z", "generation": 999},
            {"fuelType": "WIND", "startTime": "2026-01-01T00:15:00Z", "generation": 300},
            {"fuelType": "WIND", "startTime": "2026-01-01T00:30:00Z", "generation": 200},
            {"fuelType": "WIND", "startTime": "2026-02-01T00:00:00Z", "generation": 400},
        ]
        forecasts = [
            {"startTime": "2026-01-01T00:00:00Z", "publishTime": "2025-12-31T08:59:00Z", "generation": 100},
            {"startTime": "2026-01-01T00:00:00Z", "publishTime": "2025-12-31T10:59:00Z", "generation": 110},
            {"startTime": "2026-01-01T00:00:00Z", "publishTime": "2025-12-31T11:00:00Z", "generation": 120},
            {"startTime": "2026-01-01T00:00:00Z", "publishTime": "2025-12-31T11:01:00Z", "generation": 999},
            {"startTime": "2026-01-01T00:30:00Z", "publishTime": "2025-12-31T10:30:00Z", "generation": 160},
            {"startTime": "2026-01-01T00:15:00Z", "publishTime": "2025-12-31T10:00:00Z", "generation": 500},
        ]
        with patch("main.fetch_stream", new=AsyncMock(side_effect=[actuals, forecasts])) as fetch:
            response = await self.client.get("/api/wind", params={"start": "2026-01-01", "end": "2026-01-31"})
            repeat_response = await self.client.get(
                "/api/wind",
                params={"start": "2026-01-01", "end": "2026-01-31"},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(repeat_response.status_code, 200)
        self.assertEqual(fetch.await_count, 2, "The second request should reuse both cached source streams")
        self.assertEqual([call.args[0] for call in fetch.await_args_list], ["FUELHH", "WINDFOR"])
        self.assertEqual(fetch.await_args_list[0].args[1:3], (date(2026, 1, 1), date(2026, 1, 31)))
        self.assertEqual(fetch.await_args_list[0].args[3], {"fuelType": "WIND"})
        payload = response.json()
        self.assertEqual(len(payload["periods"]), 2)
        first, second = payload["periods"]
        self.assertEqual(first["actual"], 100)
        self.assertEqual([v["generation"] for v in first["forecasts"]], [100, 110, 120, 999])
        summary = payload["summaryByCutoff"]["11"]
        self.assertEqual(summary["matchedCount"], 2)
        self.assertEqual(summary["mae"], 30)
        self.assertAlmostEqual(summary["rmse"], 1000 ** 0.5)
        self.assertEqual(summary["meanBias"], -10)
        self.assertEqual(payload["summaryByCutoff"]["9"]["matchedCount"], 1)
        self.assertEqual(payload["summaryByCutoff"]["9"]["mae"], 0)

    def test_imputes_missing_half_hour_with_mean_of_eligible_neighbor_hours(self):
        periods = [
            {
                "startTime": "2026-01-02T00:00:00+00:00",
                "actual": 90,
                "forecasts": [
                    {"publishTime": "2026-01-01T10:00:00+00:00", "generation": 100},
                    {"publishTime": "2026-01-01T11:01:00+00:00", "generation": 1000},
                ],
            },
            {"startTime": "2026-01-02T00:30:00+00:00", "actual": 180, "forecasts": []},
            {
                "startTime": "2026-01-02T01:00:00+00:00",
                "actual": 310,
                "forecasts": [
                    {"publishTime": "2026-01-01T10:30:00+00:00", "generation": 300},
                    {"publishTime": "2026-01-01T11:01:00+00:00", "generation": 2000},
                ],
            },
        ]

        summary = main_module.summarize(periods, 11)

        self.assertEqual(summary["matchedCount"], 3)
        self.assertEqual(summary["reportedMatchedCount"], 2)
        self.assertEqual(summary["imputedMatchedCount"], 1)
        self.assertEqual(summary["imputedForecastCount"], 1)
        self.assertAlmostEqual(summary["mae"], 40 / 3)
        self.assertAlmostEqual(summary["rmse"], 200 ** 0.5)
        self.assertAlmostEqual(summary["meanBias"], 20 / 3)


if __name__ == "__main__":
    unittest.main()
