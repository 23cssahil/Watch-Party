import { useEffect, useRef } from 'react';

interface Props {
  /** True when the engine should run - effect is on AND the video is playing. */
  active: boolean;
}

const BPM = 122;
const MAX_PER_BANK = 22; // hard cap on how many bars fit on one side
const MIN_SLOT = 7; // px a bar (plus its gap) needs to stay legible
const MAX_PARTICLES = 80;

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
 * A synthetic, audio-free music visualiser that lives in the gutter.
 *
 * YouTube's player is a cross-origin iframe, so the Web Audio API can't read its
 * real frequencies - the browser blocks it. So this canvas fakes a beat instead of
 * detecting one: a fixed BPM drives a kick envelope, and a few out-of-phase
 * oscillators fill in a spectrum that looks lively.
 *
 * The canvas is a sibling behind the video frame, and each bar is drawn only in
 * the dark space to the left and right of the picture, never over it, so the video
 * stays clear. The gutter width is measured live from the frame's bounding box, so
 * it adapts to any window size and steps aside when there's no room beside it.
 *
 * Bubbles spawn off the top of a bar at each beat peak and rise to the top of the
 * video before dissolving. It's purely decorative (pointer-events: none,
 * aria-hidden), only runs during playback, parks itself once the energy fades, and
 * doesn't run at all under prefers-reduced-motion.
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

    // The canvas fills .stage; the video is .stage__frame on top of it. We read
    // that frame's box each frame to know where the gutters are.
    const stage = canvas.parentElement;
    const frameEl = stage?.querySelector('.stage__frame') as HTMLElement | null;

    const levels = new Float32Array(MAX_PER_BANK * 2);
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
    if (stage) ro.observe(stage);
    if (frameEl) ro.observe(frameEl);

    const tick = (now: number) => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const t = (now - clock) / 1000;

      const target = activeRef.current ? 1 : 0;
      energy += (target - energy) * 0.05;

      // Room's quiet and the energy's bled out: clear once and park. The `active`
      // effect above restarts us on the next beat.
      if (target === 0 && energy < 0.01) {
        particles.length = 0; // don't strand half-risen bubbles for the next play
        ctx.clearRect(0, 0, w, h);
        raf = 0;
        return;
      }

      // Measure the video frame against the canvas to find the two side gutters and
      // the vertical band the picture covers. Everything draws inside the gutters so
      // the video is never covered.
      let gLeft = 0;
      let gRight = 0;
      let vTop = 0;
      let vBot = h;
      if (frameEl) {
        const sr = canvas.getBoundingClientRect();
        const fr = frameEl.getBoundingClientRect();
        gLeft = fr.left - sr.left;
        gRight = sr.right - fr.right;
        vTop = fr.top - sr.top;
        vBot = fr.bottom - sr.top;
      }
      const baseline = vBot;
      const bankH = Math.max(24, vBot - vTop);

      const beatSec = 60 / BPM;
      const beatIndex = Math.floor(t / beatSec);
      const phase = (t % beatSec) / beatSec;
      const kick = Math.exp(-phase * 5.5);
      const strong = beatIndex % 4 === 0 ? 1 : beatIndex % 2 === 0 ? 0.75 : 0.55;
      const drop = beatIndex % 16 < 4 ? 1.18 : 1; // a recurring "chorus" lift
      const glow = kick * energy;

      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'lighter';

      // Crest points collected while drawing, reused as bubble spawn points.
      const spawn: { x: number; y: number }[] = [];

      // A soft stage bloom, clipped to one gutter so it never lifts over the video.
      const bloom = (cx: number, x0: number, gw: number) => {
        if (gw < 10) return;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, vTop, gw, bankH);
        ctx.clip();
        const g = ctx.createRadialGradient(cx, baseline, 0, cx, baseline, bankH * 0.9);
        g.addColorStop(0, `rgba(124, 92, 255, ${0.2 * glow})`);
        g.addColorStop(0.5, `rgba(255, 71, 87, ${0.11 * glow})`);
        g.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = g;
        ctx.fillRect(x0, vTop, gw, bankH);
        ctx.restore();
      };

      // One bank of equaliser bars, growing up from the video's bottom edge and
      // confined to [startX, startX + bankW]. The bar count adapts to the width.
      const drawBank = (startX: number, bankW: number, base: number) => {
        if (bankW < MIN_SLOT * 2) return; // no real room beside the video
        const count = Math.max(3, Math.min(MAX_PER_BANK, Math.floor(bankW / MIN_SLOT)));
        const slot = bankW / count;
        const barMax = bankH * 0.5;
        for (let j = 0; j < count; j++) {
          const i = base + j;
          const a = 0.5 + 0.5 * Math.sin(t * (1.6 + i * 0.33) + i * 0.7);
          const b = 0.5 + 0.5 * Math.sin(t * (0.6 + i * 0.11) + i * 1.7);
          const tilt = 0.55 + 0.45 * Math.sin((j / (count - 1)) * Math.PI); // arc per bank
          let level = (0.2 + 0.85 * a * b) * (0.45 + 0.95 * kick * strong) * drop * tilt;
          level = Math.min(1, level * energy);
          levels[i] += (level - levels[i]) * 0.35;
          const bh = Math.max(2, levels[i] * barMax);
          const x = startX + j * slot + slot * 0.18;
          const barW = slot * 0.64;
          const grad = ctx.createLinearGradient(0, baseline, 0, baseline - bh);
          grad.addColorStop(0, `rgba(46, 213, 115, ${0.85 * energy})`);
          grad.addColorStop(0.5, `rgba(124, 92, 255, ${0.9 * energy})`);
          grad.addColorStop(1, `rgba(255, 71, 87, ${0.95 * energy})`);
          ctx.fillStyle = grad;
          traceBar(ctx, x, baseline - bh, barW, bh, Math.min(barW / 2, 3));
          ctx.fill();
          spawn.push({ x: x + barW / 2, y: baseline - bh });
        }
      };

      bloom(gLeft / 2, 0, gLeft);
      bloom(w - gRight / 2, w - gRight, gRight);
      drawBank(0, gLeft, 0);
      drawBank(w - gRight, gRight, MAX_PER_BANK);

      // Bubbles - spawn off the top of a bar at each beat peak, then rise the full
      // height of the picture and dissolve at its top edge. No gravity pulls them
      // back, so a bubble always reaches the top instead of stalling halfway.
      if (beatIndex !== lastBeat) {
        lastBeat = beatIndex;
        if (energy > 0.25 && particles.length < MAX_PARTICLES && spawn.length) {
          const n = 2 + Math.floor(Math.random() * 3);
          for (let k = 0; k < n; k++) {
            const s = spawn[Math.floor(Math.random() * spawn.length)];
            particles.push({
              x: s.x,
              y: s.y,
              vx: (Math.random() - 0.5) * 0.04 * w,
              vy: -(0.5 + Math.random() * 0.4) * bankH, // clears the top in ~1.4-2s
              r: 1.6 + Math.random() * 2.6,
              life: 1,
              hue: 265 + Math.random() * 70, // violet -> pink
            });
          }
        }
      }
      const dt = 1 / 60;
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.life -= dt * 0.4;
        if (p.y < vTop - p.r || p.life <= 0) {
          particles.splice(i, 1);
          continue;
        }
        // Dissolve over the top ~22% of the picture so the bubble "disappears at
        // the top" instead of popping mid-flight.
        const fade = Math.max(0, Math.min(1, (p.y - vTop) / (bankH * 0.22)));
        ctx.fillStyle = `hsla(${p.hue}, 95%, 68%, ${p.life * 0.9 * energy * fade})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.globalCompositeOperation = 'source-over';
      raf = requestAnimationFrame(tick);
    };

    const wake = () => {
      if (raf) return;
      clock = performance.now();
      raf = requestAnimationFrame(tick);
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

/** Rounded-top bar path, drawn by hand so it works without the newer ctx.roundRect. */
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
