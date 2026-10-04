import { useEffect, useRef } from 'react';

interface Props {
  /** True when the engine should run — the effect is switched on AND the video is playing. */
  active: boolean;
}

const BAR_COUNT = 56;
const BPM = 122;
const MAX_PARTICLES = 70;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  life: number;
  hue: number;
}

/**
 * A synthetic, audio-free music visualiser.
 *
 * YouTube's player is a cross-origin iframe, so the Web Audio API can never read
 * its real frequencies — the browser blocks it by design. This canvas therefore
 * *models* a beat rather than detecting one: a fixed BPM drives a kick envelope,
 * and a few out-of-phase oscillators fill in a spectrum that looks alive. It is
 * gated on playback (bars rise while the video plays and settle the instant it
 * pauses), fully decorative — `pointer-events: none`, `aria-hidden` — and it does
 * not run at all under `prefers-reduced-motion`.
 *
 * The animation loop parks itself once the energy has decayed to nothing, so an
 * idle or paused tab costs no CPU; flipping `active` back on wakes it instantly.
 */
export default function BeatVisualizer({ active }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const activeRef = useRef(active);
  const wakeRef = useRef<(() => void) | null>(null);

  // Keep the loop's notion of "should be on" fresh, and nudge a parked loop back
  // to life the moment playback resumes.
  useEffect(() => {
    activeRef.current = active;
    wakeRef.current?.();
  }, [active]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const levels = new Float32Array(BAR_COUNT);
    const particles: Particle[] = [];
    let energy = 0;
    let raf = 0;
    let clock = performance.now();
    let lastBeat = -1;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const frame = (now: number) => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const t = (now - clock) / 1000;

      const target = activeRef.current ? 1 : 0;
      energy += (target - energy) * 0.05;

      // Room gone quiet and the last of the energy has bled out: clear once and
      // park. The `active` effect above restarts us on the next beat.
      if (target === 0 && energy < 0.01) {
        ctx.clearRect(0, 0, w, h);
        raf = 0;
        return;
      }

      const beatSec = 60 / BPM;
      const beatIndex = Math.floor(t / beatSec);
      const phase = (t % beatSec) / beatSec;
      const kick = Math.exp(-phase * 5.5);
      const strong = beatIndex % 4 === 0 ? 1 : beatIndex % 2 === 0 ? 0.75 : 0.55;
      const drop = beatIndex % 16 < 4 ? 1.18 : 1; // a recurring "chorus" lift
      const glow = kick * energy;

      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'lighter';

      // 1. Stage light — a warm radial bloom that swells on every kick.
      const light = ctx.createRadialGradient(w / 2, h, 0, w / 2, h, h * 0.9);
      light.addColorStop(0, `rgba(124, 92, 255, ${0.22 * glow})`);
      light.addColorStop(0.5, `rgba(255, 71, 87, ${0.12 * glow})`);
      light.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = light;
      ctx.fillRect(0, 0, w, h);

      // 2. Equalizer bars — each a blend of oscillators so the shape wanders like
      //    a real spectrum instead of repeating a fixed pattern.
      const bw = w / BAR_COUNT;
      const barMax = h * 0.44;
      for (let i = 0; i < BAR_COUNT; i++) {
        const a = 0.5 + 0.5 * Math.sin(t * (1.6 + i * 0.33) + i * 0.7);
        const b = 0.5 + 0.5 * Math.sin(t * (0.6 + i * 0.11) + i * 1.7);
        const tilt = 0.55 + 0.45 * Math.sin((i / BAR_COUNT) * Math.PI); // brighter mid
        let level = (0.2 + 0.85 * a * b) * (0.45 + 0.95 * kick * strong) * drop * tilt;
        level = Math.min(1, level * energy);
        levels[i] += (level - levels[i]) * 0.35;
        const bh = Math.max(2, levels[i] * barMax);
        const x = i * bw + bw * 0.18;
        const barW = bw * 0.64;
        const grad = ctx.createLinearGradient(0, h, 0, h - bh);
        grad.addColorStop(0, `rgba(46, 213, 115, ${0.85 * energy})`);
        grad.addColorStop(0.5, `rgba(124, 92, 255, ${0.9 * energy})`);
        grad.addColorStop(1, `rgba(255, 71, 87, ${0.95 * energy})`);
        ctx.fillStyle = grad;
        traceBar(ctx, x, h - bh, barW, bh, Math.min(barW / 2, 3));
        ctx.fill();
      }

      // 3. Sparks — emitted on the beat, rising and fading: the concert layer.
      if (beatIndex !== lastBeat) {
        lastBeat = beatIndex;
        if (energy > 0.25 && particles.length < MAX_PARTICLES) {
          const n = 2 + Math.floor(Math.random() * 3);
          for (let k = 0; k < n; k++) {
            particles.push({
              x: Math.random() * w,
              y: h - 4,
              vx: (Math.random() - 0.5) * 20,
              vy: -(50 + Math.random() * 90),
              r: 1 + Math.random() * 2.4,
              life: 1,
              hue: 265 + Math.random() * 70, // violet → pink
            });
          }
        }
      }
      const dt = 1 / 60;
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy += 12 * dt; // a touch of gravity eases them back down
        p.life -= dt * 0.7;
        if (p.life <= 0 || p.y < 0) {
          particles.splice(i, 1);
          continue;
        }
        ctx.fillStyle = `hsla(${p.hue}, 95%, 68%, ${p.life * 0.9 * energy})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.globalCompositeOperation = 'source-over';
      raf = requestAnimationFrame(frame);
    };

    const wake = () => {
      if (raf) return;
      clock = performance.now();
      raf = requestAnimationFrame(frame);
    };
    wakeRef.current = wake;
    wake();

    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      wakeRef.current = null;
    };
  }, []);

  return <canvas ref={canvasRef} className="beat" aria-hidden="true" />;
}

/** Rounded-top bar path, drawn manually so it works without the newer ctx.roundRect. */
function traceBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const radius = Math.min(r, w / 2, h);
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.arcTo(x + w, y, x + w, y + radius, radius);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
}
