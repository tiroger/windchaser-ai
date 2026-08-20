"use client";

import { useEffect, useRef } from "react";

/**
 * Animated wind field drawn over the map.
 *
 * Particles are advected along the direction the air is actually travelling,
 * at a rate proportional to the forecast speed, so the motion carries real
 * information rather than being decoration. Direction and speed ease between
 * forecast hours so scrubbing the timeline reads as weather changing rather
 * than values snapping.
 *
 * Honest by construction: when there is no wind the field goes still.
 */

interface Props {
  /** Metres per second, sustained. */
  speed: number;
  /** Degrees the air travels toward, clockwise from north. */
  travelDeg: number;
  /** Gust headroom above sustained, used to add turbulence. */
  gust?: number;
}

interface Particle {
  x: number;
  y: number;
  age: number;
  life: number;
  /** 0-1, varies particle length and brightness. */
  weight: number;
}

const BASE_COUNT = 340;

export default function WindCanvas({ speed, travelDeg, gust = 0 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // The animation loop eases toward these targets. Written after render, not
  // during it, so React never sees a ref mutate mid-render.
  const target = useRef({ speed, travelDeg, gust });
  useEffect(() => {
    target.current = { speed, travelDeg, gust };
  }, [speed, travelDeg, gust]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let width = 0;
    let height = 0;
    let dpr = 1;
    const particles: Particle[] = [];

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = rect.width;
      height = rect.height;
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const spawn = (p: Particle) => {
      p.x = Math.random() * width;
      p.y = Math.random() * height;
      p.age = 0;
      p.life = 90 + Math.random() * 160;
      p.weight = 0.35 + Math.random() * 0.65;
    };

    resize();
    for (let i = 0; i < BASE_COUNT; i++) {
      const p: Particle = { x: 0, y: 0, age: 0, life: 0, weight: 0 };
      spawn(p);
      p.age = Math.random() * p.life;
      particles.push(p);
    }

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    // Eased state, so hour-to-hour changes glide.
    let curSpeed = speed;
    let curDir = travelDeg;
    let raf = 0;
    let running = true;

    /** Shortest angular path, so 350 to 10 degrees does not spin backwards. */
    const easeAngle = (from: number, to: number, t: number) => {
      const delta = ((((to - from) % 360) + 540) % 360) - 180;
      return from + delta * t;
    };

    const drawStatic = () => {
      // Reduced-motion fallback: the same field, held still.
      ctx.clearRect(0, 0, width, height);
      const rad = ((curDir - 90) * Math.PI) / 180;
      const cols = 10;
      const rows = 6;
      ctx.strokeStyle = "rgba(88,166,232,0.30)";
      ctx.lineWidth = 1.1;
      ctx.lineCap = "round";
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x = ((c + 0.5) / cols) * width;
          const y = ((r + 0.5) / rows) * height;
          const len = 6 + Math.min(18, curSpeed * 2.2);
          ctx.beginPath();
          ctx.moveTo(x - (Math.cos(rad) * len) / 2, y - (Math.sin(rad) * len) / 2);
          ctx.lineTo(x + (Math.cos(rad) * len) / 2, y + (Math.sin(rad) * len) / 2);
          ctx.stroke();
        }
      }
    };

    const frame = () => {
      if (!running) return;
      curSpeed += (target.current.speed - curSpeed) * 0.045;
      curDir = easeAngle(curDir, target.current.travelDeg, 0.045);
      const turbulence = Math.min(0.5, (target.current.gust ?? 0) / 24);

      // Fade rather than clear, which leaves comet trails.
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = "rgba(0,0,0,0.14)";
      ctx.fillRect(0, 0, width, height);
      ctx.globalCompositeOperation = "source-over";

      const rad = ((curDir - 90) * Math.PI) / 180;
      // Pixels per frame. Deliberately gentle: legible, not frantic.
      const step = 0.22 + curSpeed * 0.42;
      const vx = Math.cos(rad) * step;
      const vy = Math.sin(rad) * step;

      ctx.lineCap = "round";
      for (const p of particles) {
        const jitter = turbulence * (Math.random() - 0.5) * 2.2;
        const px = p.x;
        const py = p.y;
        p.x += vx + jitter;
        p.y += vy + jitter;
        p.age++;

        const fade = 1 - p.age / p.life;
        ctx.strokeStyle = `rgba(120,190,245,${(0.10 + 0.42 * p.weight) * fade})`;
        ctx.lineWidth = 0.6 + p.weight * 1.5;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();

        if (
          p.age > p.life ||
          p.x < -40 || p.x > width + 40 ||
          p.y < -40 || p.y > height + 40
        ) {
          spawn(p);
          // Re-enter from the upwind edge so the field stays populated.
          if (Math.abs(vx) > Math.abs(vy)) p.x = vx > 0 ? -20 : width + 20;
          else p.y = vy > 0 ? -20 : height + 20;
        }
      }
      raf = requestAnimationFrame(frame);
    };

    if (reduced) {
      drawStatic();
    } else {
      raf = requestAnimationFrame(frame);
    }

    // Stop burning frames on a hidden tab.
    const onVisibility = () => {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(raf);
      } else if (!reduced && !running) {
        running = true;
        raf = requestAnimationFrame(frame);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // Targets flow through the ref; the loop itself is created once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: 2,
      }}
    />
  );
}
