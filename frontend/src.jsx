import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  ArrowDownRight,
  ArrowRight,
  Check,
  Download,
  TriangleAlert,
  Wind,
} from 'lucide-react';
import './style.css';

const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '');
const CUTOFFS = [9, 10, 11, 12, 13, 14, 15];
const PAGE_SIZE = 24;
const WEEKS = [
  { start: '2026-01-01', end: '2026-01-07', label: 'Week 1 · Jan 1–7' },
  { start: '2026-01-08', end: '2026-01-14', label: 'Week 2 · Jan 8–14' },
  { start: '2026-01-15', end: '2026-01-21', label: 'Week 3 · Jan 15–21' },
  { start: '2026-01-22', end: '2026-01-28', label: 'Week 4 · Jan 22–28' },
  { start: '2026-01-29', end: '2026-01-31', label: 'Week 5 · Jan 29–31' },
];
const DAYS = Array.from({ length: 31 }, (_, index) => {
  const value = `2026-01-${String(index + 1).padStart(2, '0')}`;
  const label = new Date(`${value}T12:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    timeZone: 'Europe/London',
  });
  return { value, label };
});
const fmt = (value, digits = 0) =>
  value == null
    ? '—'
    : new Intl.NumberFormat('en-GB', { maximumFractionDigits: digits }).format(
        value
      );
const scopeKey = (start, end) => `${start}_${end}`;

function atCutoff(period, cutoffHour) {
  const delivery = new Date(period.startTime);
  const cutoff = Date.UTC(
    delivery.getUTCFullYear(),
    delivery.getUTCMonth(),
    delivery.getUTCDate() - 1,
    cutoffHour
  );
  const eligible = (period.forecasts || []).filter(
    (item) => Date.parse(item.publishTime) <= cutoff
  );
  const latest = eligible.reduce(
    (best, item) =>
      !best || item.publishTime > best.publishTime ? item : best,
    null
  );
  const forecast = latest?.generation ?? null;
  const error =
    forecast == null || period.actual == null ? null : forecast - period.actual;
  return {
    ...period,
    forecast,
    forecastType: latest ? 'published' : null,
    publishTime: latest?.publishTime ?? null,
    error,
  };
}

function App() {
  const [dashboardActive, setDashboardActive] = useState(false);
  const [view, setView] = useState('month');
  const [weekStart, setWeekStart] = useState(WEEKS[2].start);
  const [day, setDay] = useState('2026-01-15');
  const [cutoff, setCutoff] = useState(11);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState(null);
  const [hovered, setHovered] = useState(null);
  const [page, setPage] = useState(0);

  useEffect(() => {
    if (!dashboardActive || data) return undefined;
    let active = true;
    setLoading(true);
    setError('');
    fetch(`${API_BASE}/api/wind?start=2026-01-01&end=2026-01-31&cutoff_hour=11`)
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            (await response.json()).detail || 'Could not load Elexon data'
          );
        return response.json();
      })
      .then((payload) => {
        if (active) setData(payload);
      })
      .catch((reason) => {
        if (active) {
          setData(null);
          setError(reason.message);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [retry, dashboardActive]);

  useEffect(() => {
    setPage(0);
    setSelected(null);
  }, [view, weekStart, day, cutoff]);

  const dates = useMemo(() => {
    if (view === 'month') return ['2026-01-01', '2026-01-31'];
    if (view === 'day') return [day, day];
    const week = WEEKS.find((item) => item.start === weekStart) || WEEKS[0];
    return [week.start, week.end];
  }, [view, weekStart, day]);
  const periods = useMemo(() => {
    const selectedForecasts = (data?.periods || [])
      .filter(
        (period) =>
          period.startTime.slice(0, 10) >= dates[0] &&
          period.startTime.slice(0, 10) <= dates[1]
      )
      .map((period) => atCutoff(period, cutoff));
    const byTime = new Map(
      selectedForecasts.map((point) => [Date.parse(point.startTime), point])
    );
    return selectedForecasts.map((point) => {
      const timestamp = Date.parse(point.startTime);
      if (point.forecast != null || new Date(timestamp).getUTCMinutes() !== 30)
        return point;
      const previousHour = byTime.get(timestamp - 30 * 60 * 1000);
      const nextHour = byTime.get(timestamp + 30 * 60 * 1000);
      if (previousHour?.forecast == null || nextHour?.forecast == null)
        return point;
      const forecast = (previousHour.forecast + nextHour.forecast) / 2;
      return {
        ...point,
        forecast,
        forecastType: 'arithmetic-mean',
        forecastSources: [previousHour, nextHour],
        publishTime: null,
        error: point.actual == null ? null : forecast - point.actual,
      };
    });
  }, [data, dates, cutoff]);
  const summary =
    data?.summaryByRange?.[scopeKey(...dates)]?.[String(cutoff)] || null;
  const pageCount = Math.max(1, Math.ceil(periods.length / PAGE_SIZE));
  const visiblePeriods = periods.slice(
    page * PAGE_SIZE,
    (page + 1) * PAGE_SIZE
  );
  const selectedPoint =
    periods.find((point) => point.startTime === selected) || null;
  const revisions = useMemo(() => {
    if (!selectedPoint) return [];
    const sourcePeriods = selectedPoint.forecastSources || [selectedPoint];
    return sourcePeriods.flatMap((source) => {
      const delivery = new Date(source.startTime);
      const cutoffTime = Date.UTC(
        delivery.getUTCFullYear(),
        delivery.getUTCMonth(),
        delivery.getUTCDate() - 1,
        cutoff
      );
      return [...(source.forecasts || [])]
        .sort((left, right) =>
          left.publishTime.localeCompare(right.publishTime)
        )
        .map((item) => ({
          ...item,
          sourceTime: source.localTime,
          eligible: Date.parse(item.publishTime) <= cutoffTime,
          selected: item.publishTime === source.publishTime,
        }));
    });
  }, [selectedPoint, cutoff]);
  const residuals = useMemo(
    () =>
      periods
        .filter((point) => point.error != null)
        .map((point) => point.error),
    [periods]
  );
  const residualExtent = Math.max(
    1,
    ...residuals.map((value) => Math.abs(value))
  );
  const residualBins = useMemo(() => {
    const bins = Array.from({ length: 16 }, (_, index) => ({
      index,
      count: 0,
    }));
    residuals.forEach((value) => {
      const index = Math.min(
        bins.length - 1,
        Math.floor(
          ((value + residualExtent) / (2 * residualExtent)) * bins.length
        )
      );
      bins[index].count += 1;
    });
    return bins;
  }, [residuals, residualExtent]);
  const maxBinCount = Math.max(1, ...residualBins.map((bin) => bin.count));
  const chart = useMemo(
    () => periods.filter((_, index) => view !== 'month' || index % 6 === 0),
    [periods, view]
  );
  const max = Math.max(
    1000,
    ...chart.flatMap((point) => [point.actual || 0, point.forecast || 0])
  );
  const chartX = (index) =>
    chart.length < 2 ? 500 : (index / (chart.length - 1)) * 1000;
  const chartY = (value) => 194 - (value / max) * 184;
  const chartPath = (field) => {
    let previousTime = null;
    const maxGap = view === 'month' ? 3.1 * 3600000 : 1.1 * 3600000;
    return chart
      .map((point, index) => {
        const value = point[field];
        if (value == null) return '';
        const timestamp = Date.parse(point.startTime);
        const command =
          previousTime == null || timestamp - previousTime > maxGap ? 'M' : 'L';
        previousTime = timestamp;
        return `${command}${chartX(index).toFixed(1)},${chartY(value).toFixed(1)}`;
      })
      .filter(Boolean)
      .join(' ');
  };
  const peakActual = periods.reduce(
    (best, point) =>
      point.actual != null && (!best || point.actual > best.actual)
        ? point
        : best,
    null
  );
  const peakForecast = periods.reduce(
    (best, point) =>
      point.forecast != null && (!best || point.forecast > best.forecast)
        ? point
        : best,
    null
  );
  const rangeLabel =
    view === 'month'
      ? 'January 2026'
      : view === 'day'
        ? new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', {
            day: 'numeric',
            month: 'long',
            timeZone: 'Europe/London',
          })
        : WEEKS.find((item) => item.start === weekStart)?.label;

  function exportCsv() {
    const rows = [
      [
        'Delivery time',
        'Forecast MW',
        'Forecast basis',
        'Forecast source delivery periods',
        'Forecast published',
        'Actual generation MW',
        'Error MW',
      ],
      ...periods.map((point) => [
        point.startTime,
        point.forecast ?? '',
        point.forecastType || '',
        (point.forecastSources || [])
          .map((source) => source.startTime)
          .join(' | '),
        point.publishTime ??
          (point.forecastSources || [])
            .map((source) => source.publishTime)
            .join(' | '),
        point.actual ?? '',
        point.error ?? '',
      ]),
    ];
    const blob = new Blob(
      [
        rows
          .map((row) =>
            row
              .map((value) => `"${String(value).replaceAll('"', '""')}"`)
              .join(',')
          )
          .join('\n'),
      ],
      { type: 'text/csv' }
    );
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `wind-desk-${view}-${dates[0]}-${dates[1]}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function selectPeriod(point) {
    setSelected(point.startTime);
    const index = periods.findIndex(
      (item) => item.startTime === point.startTime
    );
    if (index >= 0) setPage(Math.floor(index / PAGE_SIZE));
  }

  if (!dashboardActive)
    return <LandingPage onOpen={() => setDashboardActive(true)} />;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brandmark">
            <Wind size={20} />
          </div>
          <div>
            Wind Desk<span>DAY AHEAD</span>
          </div>
        </div>
        <div className="sidebar-source">
          <span className="live-dot" /> ELEXON BMRS
        </div>
      </aside>
      <main>
        <header>
          <div className="crumb">
            GB POWER <span>/</span> <b>WIND FORECAST</b>
          </div>
          <button
            className="back-home"
            onClick={() => setDashboardActive(false)}
          >
            <Wind size={14} /> About this analysis
          </button>
        </header>
        <section className="intro">
          <div>
            <div className="eyebrow">
              <span className="live-dot" /> JANUARY 2026 <span>·</span>{' '}
              {rangeLabel?.toUpperCase()}
            </div>
            <h1>Wind forecast desk</h1>
            <p>
              Compare the day-ahead wind outlook with actual generation for each
              half-hour delivery period.
            </p>
          </div>
        </section>
        <section className="toolbar">
          <div className="tabs">
            <button
              className={view === 'month' ? 'on' : ''}
              onClick={() => {
                setView('month');
                setSelected(null);
              }}
            >
              January overview
            </button>
            <button
              className={view === 'week' ? 'on' : ''}
              onClick={() => {
                setView('week');
                setSelected(null);
              }}
            >
              Week view
            </button>
            <button
              className={view === 'day' ? 'on' : ''}
              onClick={() => {
                setView('day');
                setSelected(null);
              }}
            >
              Day view
            </button>
          </div>
          <div className="tools">
            {view === 'week' && (
              <label className="period-select">
                Week{' '}
                <select
                  value={weekStart}
                  onChange={(event) => {
                    setWeekStart(event.target.value);
                    setSelected(null);
                  }}
                >
                  {WEEKS.map((week) => (
                    <option key={week.start} value={week.start}>
                      {week.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {view === 'day' && (
              <label className="period-select">
                Delivery day{' '}
                <select
                  value={day}
                  onChange={(event) => {
                    setDay(event.target.value);
                    setSelected(null);
                  }}
                >
                  {DAYS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="cutoff">
              Decision cutoff{' '}
              <select
                value={cutoff}
                onChange={(event) => setCutoff(Number(event.target.value))}
              >
                {CUTOFFS.map((hour) => (
                  <option key={hour} value={hour}>
                    {String(hour).padStart(2, '0')}:00 GMT
                  </option>
                ))}
              </select>
            </label>
            <button
              className="iconbtn"
              title="Export selected delivery periods"
              onClick={exportCsv}
            >
              <Download size={15} />
              <span>Export</span>
            </button>
          </div>
        </section>
        {error && (
          <div className="notice">
            <TriangleAlert size={17} />
            <div>
              <b>Elexon data unavailable</b>
              <span>{error}. No other data is shown.</span>
            </div>
            <button
              onClick={() => {
                setData(null);
                setRetry((value) => value + 1);
              }}
            >
              Retry
            </button>
          </div>
        )}
        <section className="metrics">
          <Metric
            label="FORECAST MAE"
            value={fmt(summary?.mae)}
            unit="MW"
            sub="Direct + hourly-mean estimates"
            tone="amber"
            loading={loading}
          />
          <Metric
            label="FORECAST RMSE"
            value={fmt(summary?.rmse)}
            unit="MW"
            sub="Larger misses weigh more"
            tone="violet"
            loading={loading}
          />
          <Metric
            label="MEAN BIAS"
            value={fmt(summary?.meanBias)}
            unit="MW"
            sub="Positive means over-forecast"
            tone="blue"
            loading={loading}
          />
          <Metric
            label="ACTUAL WIND PEAK"
            value={fmt(peakActual?.actual)}
            unit="MW"
            sub={peakActual?.localTime || 'Peak delivery period'}
            tone="green"
            loading={loading}
          />
        </section>
        <section className="panel chart-panel">
          <div className="panel-head">
            <div>
              <div className="section-kicker">GENERATION OUTLOOK</div>
              <h2>
                Forecast vs actual <span className="unit">MW</span>
              </h2>
              <p>
                Hover or focus a chart interval for exact values. Select it to
                highlight its table row.
              </p>
            </div>
            <div className="legend">
              <span>
                <i className="forecast-dot" /> Forecast
              </span>
              <span>
                <i className="actual-dot" /> Actual
              </span>
            </div>
          </div>
          {loading ? (
            <div className="loading">
              <div className="skeleton" />
              <span>Loading January Elexon history once…</span>
            </div>
          ) : chart.length ? (
            <>
              <div className="chart">
                <div className="ylabels">
                  <span>{fmt(max)}</span>
                  <span>{fmt(max * 0.66)}</span>
                  <span>{fmt(max * 0.33)}</span>
                  <span>0</span>
                </div>
                <div className="plot">
                  <div className="gridlines">
                    <i />
                    <i />
                    <i />
                    <i />
                  </div>
                  <svg
                    className="line-chart"
                    viewBox="0 0 1000 200"
                    preserveAspectRatio="none"
                    role="img"
                    aria-label="Interactive wind generation forecast and actual line chart"
                  >
                    <path className="forecast-line" d={chartPath('forecast')} />
                    <path className="actual-line" d={chartPath('actual')} />
                    {chart.map((point, index) => (
                      <g
                        key={point.startTime}
                        className="chart-point"
                        onMouseEnter={() => setHovered({ point, index })}
                        onMouseLeave={() => setHovered(null)}
                        onFocus={() => setHovered({ point, index })}
                        onBlur={() => setHovered(null)}
                        onClick={() => selectPeriod(point)}
                      >
                        <title>{`${point.localTime}: forecast ${fmt(point.forecast)} MW · actual ${fmt(point.actual)} MW`}</title>
                        <rect
                          className="chart-hit"
                          x={(index / chart.length) * 1000}
                          y="0"
                          width={1000 / chart.length}
                          height="194"
                          tabIndex="0"
                          role="button"
                          aria-label={`${point.localTime}, forecast ${fmt(point.forecast)} MW, actual ${fmt(point.actual)} MW`}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              selectPeriod(point);
                            }
                          }}
                        />
                      </g>
                    ))}
                  </svg>
                  {hovered && (
                    <div
                      className="chart-tooltip"
                      style={{
                        left: `${Math.min(92, Math.max(8, (hovered.index / Math.max(1, chart.length - 1)) * 100))}%`,
                      }}
                    >
                      <b>{hovered.point.localTime}</b>
                      <span>
                        <i className="forecast-dot" />{' '}
                        {hovered.point.forecastType === 'arithmetic-mean'
                          ? 'Forecast mean'
                          : 'Forecast'}{' '}
                        <strong>{fmt(hovered.point.forecast)} MW</strong>
                      </span>
                      {hovered.point.forecastType === 'arithmetic-mean' && (
                        <small>
                          Mean of adjacent eligible hourly forecasts
                        </small>
                      )}
                      <span>
                        <i className="actual-dot" /> Actual{' '}
                        <strong>{fmt(hovered.point.actual)} MW</strong>
                      </span>
                      <span>
                        Error{' '}
                        <strong>
                          {hovered.point.error == null
                            ? '—'
                            : `${hovered.point.error > 0 ? '+' : ''}${fmt(hovered.point.error)} MW`}
                        </strong>
                      </span>
                      {hovered.point.publishTime && (
                        <small>
                          Published{' '}
                          {new Date(hovered.point.publishTime).toLocaleString(
                            'en-GB',
                            {
                              day: '2-digit',
                              month: 'short',
                              hour: '2-digit',
                              minute: '2-digit',
                              timeZone: 'Europe/London',
                            }
                          )}{' '}
                          GMT
                        </small>
                      )}
                    </div>
                  )}
                  <div className="xlabels">
                    <span>{chart[0]?.localTime}</span>
                    <span>
                      {chart[Math.floor(chart.length * 0.25)]?.localTime}
                    </span>
                    <span>
                      {chart[Math.floor(chart.length * 0.5)]?.localTime}
                    </span>
                    <span>
                      {chart[Math.floor(chart.length * 0.75)]?.localTime}
                    </span>
                    <span>{chart.at(-1)?.localTime}</span>
                  </div>
                </div>
              </div>
              <div className="chart-foot">
                Forecast cutoff: {String(cutoff).padStart(2, '0')}:00 GMT on the
                preceding day{' '}
                <span>
                  {rangeLabel} · actuals are half-hourly; forecasts are
                  published hourly
                </span>
              </div>
            </>
          ) : (
            <div className="empty">
              {error
                ? 'Waiting for Elexon data. Use Retry to try again.'
                : 'No Elexon delivery periods for this selection.'}
            </div>
          )}
        </section>
        <section className="peak-row">
          <Peak label="Actual peak" point={peakActual} valueKey="actual" />
          <Peak
            label="Forecast peak"
            point={peakForecast}
            valueKey="forecast"
          />
          <div className="peak-note">
            <Activity size={16} />
            <span>
              {summary?.matchedCount
                ? `${fmt(summary.matchedCount)} comparisons · ${fmt(summary.imputedMatchedCount || 0)} use half-hour arithmetic means`
                : 'Peak values use the selected cutoff and delivery window'}
            </span>
          </div>
        </section>
        <details className="panel analysis-details">
          <summary>
            <span>
              <b>Advanced analysis</b>
              <small>Residual distribution and forecast revision audit</small>
            </span>
            <span className="details-action">Open analysis</span>
          </summary>
          <div className="analysis-content">
            <section className="analysis-block">
              <div className="analysis-heading">
                <div>
                  <div className="section-kicker">ERROR SHAPE</div>
                  <h2>Forecast residual distribution</h2>
                  <p>
                    Error = forecast − actual. Negative values are
                    under-forecasts; positive values are over-forecasts.
                  </p>
                </div>
                <span className="count">
                  {fmt(residuals.length)} MATCHED PERIODS
                </span>
              </div>
              {residuals.length ? (
                <>
                  <div className="histogram-wrap">
                    <svg
                      className="histogram"
                      viewBox="0 0 640 190"
                      role="img"
                      aria-label={`Histogram of forecast errors across ${residuals.length} matched half-hour periods`}
                    >
                      <line
                        x1="20"
                        y1="164"
                        x2="620"
                        y2="164"
                        className="hist-axis"
                      />
                      <line
                        x1={20 + 600 / 2}
                        y1="12"
                        x2={20 + 600 / 2}
                        y2="164"
                        className="hist-zero"
                      />
                      {residualBins.map((bin) => {
                        const x = 20 + bin.index * (600 / residualBins.length);
                        const height = (bin.count / maxBinCount) * 132;
                        const leftEdge =
                          -residualExtent +
                          (bin.index * residualExtent * 2) /
                            residualBins.length;
                        const rightEdge =
                          -residualExtent +
                          ((bin.index + 1) * residualExtent * 2) /
                            residualBins.length;
                        return (
                          <rect
                            key={bin.index}
                            className={
                              leftEdge + rightEdge >= 0
                                ? 'hist-bar over'
                                : 'hist-bar under'
                            }
                            x={x + 2}
                            y={164 - height}
                            width={600 / residualBins.length - 4}
                            height={height}
                            rx="2"
                          >
                            <title>{`${fmt(leftEdge)} to ${fmt(rightEdge)} MW: ${bin.count} periods`}</title>
                          </rect>
                        );
                      })}
                      <text x="20" y="184">
                        −{fmt(residualExtent)} MW
                      </text>
                      <text x="320" y="184" textAnchor="middle">
                        0
                      </text>
                      <text x="620" y="184" textAnchor="end">
                        +{fmt(residualExtent)} MW
                      </text>
                    </svg>
                    <div className="hist-legend">
                      <span>
                        <i className="under-key" /> Under-forecast
                      </span>
                      <span>
                        <i className="over-key" /> Over-forecast
                      </span>
                    </div>
                  </div>
                </>
              ) : (
                <div className="analysis-empty">
                  No matched forecast and actual periods for this selection.
                </div>
              )}
            </section>
            <section className="analysis-block audit-block">
              <div className="analysis-heading">
                <div>
                  <div className="section-kicker">PUBLICATION AUDIT</div>
                  <h2>Forecast revision history</h2>
                  <p>
                    See which snapshots were available by the selected
                    preceding-day cutoff.
                  </p>
                  {selectedPoint?.forecastType === 'arithmetic-mean' && (
                    <p className="audit-mean-note">
                      This half-hour estimate uses both adjacent hourly
                      forecasts.
                    </p>
                  )}
                </div>
                {selectedPoint && (
                  <span className="count">{selectedPoint.localTime}</span>
                )}
              </div>
              {selectedPoint ? (
                <div className="audit-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>SOURCE DELIVERY</th>
                        <th>PUBLISHED (GMT)</th>
                        <th>FORECAST</th>
                        <th>CUTOFF STATUS</th>
                      </tr>
                    </thead>
                    <tbody>
                      {revisions.map((item) => (
                        <tr
                          key={`${item.sourceTime}-${item.publishTime}`}
                          className={item.selected ? 'selected-row' : ''}
                        >
                          <td>{item.sourceTime}</td>
                          <td>
                            {new Date(item.publishTime).toLocaleString(
                              'en-GB',
                              {
                                day: '2-digit',
                                month: 'short',
                                year: 'numeric',
                                hour: '2-digit',
                                minute: '2-digit',
                                timeZone: 'Europe/London',
                              }
                            )}
                          </td>
                          <td>
                            {fmt(item.generation)} <small>MW</small>
                          </td>
                          <td>
                            {item.selected
                              ? selectedPoint.forecastType === 'arithmetic-mean'
                                ? 'Mean input'
                                : 'Selected forecast'
                              : item.eligible
                                ? 'Eligible'
                                : 'After cutoff'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!revisions.length && (
                    <div className="analysis-empty">
                      No forecast revisions were published for this interval or
                      its source hours.
                    </div>
                  )}
                </div>
              ) : (
                <div className="analysis-empty">
                  Select a chart interval or delivery row to inspect its
                  forecast revisions.
                </div>
              )}
            </section>
          </div>
        </details>
        <section className="panel table-panel">
          <div className="panel-head compact">
            <div>
              <div className="section-kicker">DELIVERY PERIODS</div>
              <h2>{rangeLabel} · half-hourly detail</h2>
            </div>
            <span className="count">{fmt(periods.length)} PERIODS</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>DELIVERY (GMT)</th>
                  <th>FORECAST</th>
                  <th>ACTUAL</th>
                  <th>ERROR</th>
                </tr>
              </thead>
              <tbody>
                {visiblePeriods.map((point) => (
                  <tr
                    key={point.startTime}
                    className={
                      selected === point.startTime ? 'selected-row' : ''
                    }
                    onClick={() => selectPeriod(point)}
                  >
                    <td>{point.localTime}</td>
                    <td>
                      {fmt(point.forecast)} <small>MW</small>
                    </td>
                    <td>
                      {fmt(point.actual)} <small>MW</small>
                    </td>
                    <td
                      className={
                        point.error == null
                          ? ''
                          : point.error > 0
                            ? 'positive'
                            : 'negative'
                      }
                    >
                      {point.error == null
                        ? '—'
                        : `${point.error > 0 ? '+' : ''}${fmt(point.error)}`}{' '}
                      <small>MW</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!periods.length && !loading && (
              <div className="table-empty">No periods for this view.</div>
            )}
          </div>
          <div className="table-pagination">
            <span>
              Showing {periods.length ? page * PAGE_SIZE + 1 : 0}–
              {Math.min((page + 1) * PAGE_SIZE, periods.length)} of{' '}
              {fmt(periods.length)} half-hour periods
            </span>
            <div>
              <button
                disabled={page === 0}
                onClick={() => setPage((value) => Math.max(0, value - 1))}
              >
                Previous
              </button>
              <span>
                Page {page + 1} of {pageCount}
              </span>
              <button
                disabled={page + 1 >= pageCount}
                onClick={() =>
                  setPage((value) => Math.min(pageCount - 1, value + 1))
                }
              >
                Next
              </button>
            </div>
          </div>
          <div className="table-note">
            Missing half-hour forecasts use the arithmetic mean of the adjacent
            hourly WINDFOR values when both are available by cutoff. Estimates
            are labeled; unmatched periods remain blank and are excluded from
            metrics. Source: Elexon BMRS · FUELHH (WIND) + WINDFOR.
          </div>
        </section>
        <footer>
          <span>
            WIND DESK <i>·</i> ELEXON BMRS
          </span>
          <span>January 2026 · UK times shown in GMT</span>
        </footer>
      </main>
    </div>
  );
}

function LandingPage({ onOpen }) {
  return (
    <main className="landing-shell">
      <header className="landing-header">
        <a
          className="landing-brand"
          href="#home"
          onClick={(event) => event.preventDefault()}
        >
          <span className="landing-mark">
            <Wind size={19} />
          </span>{' '}
          Wind Desk
        </a>
        <span className="landing-source">
          <i /> ELEXON BMRS DATA
        </span>
      </header>
      <section className="landing-hero">
        <div className="landing-copy">
          <div className="landing-eyebrow">
            <span className="live-dot" /> JANUARY 2026 · GREAT BRITAIN
          </div>
          <h1>Was the wind forecast ready for the day?</h1>
          <p>
            A focused review of day-ahead wind forecasts against actual
            generation, using Elexon’s published data and a clear delivery-time
            cutoff.
          </p>
          <button className="landing-cta" onClick={onOpen}>
            Explore January 2026 <ArrowRight size={16} />
          </button>
          <div className="landing-proof">
            <Check size={14} /> Elexon only <span /> Half-hour delivery periods{' '}
            <span /> Forecast publication times shown
          </div>
        </div>
        <div
          className="landing-visual"
          aria-label="Illustration of forecast and actual wind generation"
        >
          <div className="visual-top">
            <span>JAN 2026</span>
            <span>FORECAST / ACTUAL</span>
          </div>
          <svg
            viewBox="0 0 440 200"
            role="img"
            aria-label="Illustrative wind generation lines"
          >
            <path
              className="visual-grid"
              d="M0 40H440M0 90H440M0 140H440M0 190H440"
            />
            <path
              className="visual-forecast"
              d="M0 138 C34 123 44 97 75 105 S123 145 156 122 S206 69 239 83 S280 128 315 105 S371 50 402 64 S427 69 440 48"
            />
            <path
              className="visual-actual"
              d="M0 158 C34 147 48 121 78 124 S121 158 159 145 S205 97 240 101 S282 143 317 128 S366 79 403 84 S430 95 440 72"
            />
          </svg>
          <div className="visual-legend">
            <span>
              <i className="forecast-dot" /> Forecast at cutoff
            </span>
            <span>
              <i className="actual-dot" /> Actual generation
            </span>
          </div>
          <div className="visual-note">
            <ArrowDownRight size={15} /> Compare at each settlement period
          </div>
        </div>
      </section>
      <section className="landing-method">
        <div>
          <span className="landing-step">01 / SOURCE</span>
          <b>One source, stated clearly</b>
          <p>Actuals from FUELHH (WIND); forecasts from WINDFOR.</p>
        </div>
        <div>
          <span className="landing-step">02 / TIMING</span>
          <b>Day-ahead cutoff applied</b>
          <p>
            Default is 11:00 GMT on the preceding day. Change the cutoff in the
            dashboard to compare publication windows.
          </p>
        </div>
        <div>
          <span className="landing-step">03 / METHOD</span>
          <b>Hourly forecast, half-hour view</b>
          <p>
            Missing half-hour forecasts use the mean of adjacent eligible hourly
            values; the dashboard labels those estimates.
          </p>
        </div>
      </section>
      <footer className="landing-footer">
        <span>
          Wind Desk <i>·</i> Elexon BMRS
        </span>
        <span>Historical analysis · January 2026</span>
      </footer>
    </main>
  );
}

function Metric({ label, value, unit, sub, tone, loading }) {
  return (
    <div className={`metric ${tone}`}>
      <div className="metric-top">
        <span>{label}</span>
        <i />
      </div>
      <div className="metric-value">
        {loading ? <span className="shimmer" /> : value}
        <small>{unit}</small>
      </div>
      <div className="metric-sub">{sub}</div>
    </div>
  );
}
function Peak({ label, point, valueKey }) {
  return (
    <div className="peak-item">
      <span>{label}</span>
      <b>
        {fmt(point?.[valueKey])}
        <small> MW</small>
      </b>
      <small>{point?.localTime || '—'}</small>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
