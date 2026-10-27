"use client";

import { Fragment, useEffect, useRef, useState } from "react";

import { count, dayLabel, plural, spend, usd } from "@/components/format";
import type { DailySpend } from "@/core/web/types";

const HEIGHT = 230;
const MARGIN = { top: 20, right: 12, bottom: 26, left: 58 };

/** A round axis top just above `maxValue`, with four or five evenly spaced ticks. */
function axisScale(maxValue: number): { top: number; step: number; decimals: number } {
  if (!(maxValue > 0)) return { top: 1, step: 0.25, decimals: 2 };
  const magnitude = 10 ** Math.floor(Math.log10(maxValue));
  const lead = maxValue / magnitude;
  const [nice, stepFactor] = lead <= 1 ? [1, 0.2] : lead <= 2 ? [2, 0.5] : lead <= 5 ? [5, 1] : [10, 2];
  const step = stepFactor * magnitude;
  return { top: nice * magnitude, step, decimals: Math.min(6, Math.max(2, -Math.floor(Math.log10(step) + 1e-9))) };
}

/** Spend per budget day as bars, with the daily cap drawn when it fits the scale. */
export function CostChart({ daily, capUsd }: { daily: DailySpend[]; capUsd: number }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [active, setActive] = useState<number | null>(null);

  // The SVG is drawn in real pixels so text stays crisp; redraw when the card resizes.
  useEffect(() => {
    const element = wrap.current;
    if (!element) return;
    const measure = () => setWidth(Math.max(320, element.clientWidth || 720));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const innerWidth = width - MARGIN.left - MARGIN.right;
  const innerHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const base = MARGIN.top + innerHeight;
  const peak = Math.max(0, ...daily.map((day) => day.costUsd));
  const scale = axisScale(peak);
  const y = (value: number): number => base - (value / scale.top) * innerHeight;
  const band = innerWidth / daily.length;
  const barWidth = Math.min(24, Math.max(3, band - 4));
  const labelEvery = band >= 46 ? 1 : band >= 23 ? 2 : 4;
  const centre = (index: number): number => MARGIN.left + band * index + band / 2;
  const calls = (day: DailySpend): string => `${count(day.calls)} ${plural(day.calls, "call", "calls")}`;

  const ticks: number[] = [];
  for (let value = 0; value <= scale.top + scale.step / 2; value += scale.step) ticks.push(value);
  const shown = active === null ? null : daily[active];

  return (
    <div className="chart" ref={wrap}>
      <svg viewBox={`0 0 ${width} ${HEIGHT}`} height={HEIGHT} role="group" aria-label="Spend per day">
        {ticks.map((value) => (
          <Fragment key={value}>
            <line
              className={value === 0 ? "baseline" : "gridline"}
              x1={MARGIN.left}
              x2={width - MARGIN.right}
              y1={y(value)}
              y2={y(value)}
            />
            <text className="tick" x={MARGIN.left - 8} y={y(value) + 4} textAnchor="end">
              {usd(value, scale.decimals)}
            </text>
          </Fragment>
        ))}
        {capUsd > 0 && capUsd <= scale.top ? (
          <>
            <line className="cap-line" x1={MARGIN.left} x2={width - MARGIN.right} y1={y(capUsd)} y2={y(capUsd)} />
            <text className="tick" x={width - MARGIN.right} y={y(capUsd) - 5} textAnchor="end">
              daily cap {usd(capUsd)}
            </text>
          </>
        ) : null}
        {daily.map((day, index) => {
          const barHeight = Math.max(1, (day.costUsd / scale.top) * innerHeight);
          const left = centre(index) - barWidth / 2;
          const right = centre(index) + barWidth / 2;
          const top = base - barHeight;
          const radius = Math.min(4, barWidth / 2, barHeight);
          return (
            <Fragment key={day.day}>
              {/* The hit area is the whole column, so a thin or empty bar is still easy to point at.
                  It must come straight before its bar: the stylesheet highlights `.hit:hover + .bar`. */}
              <rect
                className="hit"
                x={MARGIN.left + band * index}
                y={MARGIN.top}
                width={band}
                height={innerHeight}
                tabIndex={0}
                role="img"
                aria-label={`${dayLabel(day.day)}: ${spend(day.costUsd)} across ${calls(day)}`}
                onPointerEnter={() => setActive(index)}
                onPointerLeave={() => setActive(null)}
                onFocus={() => setActive(index)}
                onBlur={() => setActive(null)}
              />
              {day.costUsd > 0 ? (
                <path
                  className="bar"
                  d={
                    `M${left},${base}V${top + radius}Q${left},${top} ${left + radius},${top}` +
                    `H${right - radius}Q${right},${top} ${right},${top + radius}V${base}Z`
                  }
                />
              ) : null}
              {day.costUsd > 0 && day.costUsd === peak ? (
                <text className="value-label" x={centre(index)} y={top - 6} textAnchor="middle">
                  {spend(day.costUsd)}
                </text>
              ) : null}
              {(daily.length - 1 - index) % labelEvery === 0 ? (
                <text className="tick" x={centre(index)} y={HEIGHT - 8} textAnchor="middle">
                  {dayLabel(day.day)}
                </text>
              ) : null}
            </Fragment>
          );
        })}
      </svg>
      {shown && active !== null ? (
        <div
          className="tooltip"
          style={{ left: Math.min(Math.max(centre(active), 70), width - 70), top: y(shown.costUsd) - 8 }}
        >
          <strong>{spend(shown.costUsd)}</strong>
          {dayLabel(shown.day)} · {calls(shown)}
        </div>
      ) : null}
    </div>
  );
}
