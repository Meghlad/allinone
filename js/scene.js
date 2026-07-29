/**
 * scene.js — the orbital-scan backdrop behind the hero.
 *
 * A rotating point-cloud globe with an orbiting satellite that periodically
 * fires a red scan laser at the surface. Where a laser lands, the splash is
 * anchored to the sphere itself: shockwave rings travel outward along the
 * surface as geodesic circles, and the swarm crawls across it — so both curve
 * with the globe, clip at the horizon, and rotate with the world beneath them.
 *
 * A laser that misses the globe (a click on empty space) falls back to a flat
 * splash in screen space.
 *
 * Rendered on a single fixed <canvas>. The loop is suspended once the hero
 * scrolls out of view, so it costs nothing while the rest of the page is read.
 */
(function () {
  'use strict';

  const canvas = document.getElementById('scene');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const readout = document.getElementById('readout');
  const hero = document.getElementById('about');
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ------------------------------------------------------------------ *
   * Configuration
   * ------------------------------------------------------------------ */

  const TILT = 0.42;  // globe axial tilt, radians
  const TWO_PI = Math.PI * 2;

  const CONFIG = {
    globePoints: 1500,
    swarmSize: 14,
    clickSwarmSize: 20,
    maxNodes: 170,
    linkDistanceSq: 11000,

    ringMaxAngle: 0.62,         // how far a shockwave travels, radians
    swarmSpread: [0.00012, 0.00028], // angular velocity per ms

    scanIntervalMs: [2600, 4800],
    frameCapMs: 48,

    // the load-in: grains detonate from the centre and settle into the globe
    introMs: 2200,
    introMaxDelay: 0.42         // fraction of the intro spent staggering grains
  };

  /**
   * Canvas colours live in css/style.css as --scene-* tokens so the light and
   * dark palettes stay in one place. Re-read whenever the theme flips.
   */
  const PALETTE = {
    ink: [10, 12, 15],
    far: [88, 100, 114],
    grain: [150, 158, 168],
    laser: [214, 40, 40],
    haze: 'rgba(10, 12, 15, 0.05)'
  };

  function readPalette() {
    const css = getComputedStyle(document.documentElement);

    const triplet = (name, fallback) => {
      const parts = css.getPropertyValue(name).split(',').map((n) => parseFloat(n));
      return parts.length === 3 && parts.every((n) => !Number.isNaN(n)) ? parts : fallback;
    };

    PALETTE.ink = triplet('--scene-ink', PALETTE.ink);
    PALETTE.far = triplet('--scene-far', PALETTE.far);
    PALETTE.grain = triplet('--scene-grain', PALETTE.grain);
    PALETTE.laser = triplet('--scene-laser', PALETTE.laser);
    PALETTE.haze = css.getPropertyValue('--scene-haze').trim() || PALETTE.haze;
  }

  /* ------------------------------------------------------------------ *
   * State
   * ------------------------------------------------------------------ */

  const mouse = { x: -1e4, y: -1e4, active: false };

  let width = 0;
  let height = 0;
  let radius = 0;
  let centreX = 0;
  let centreY = 0;

  let scans = [];
  let nodes = [];
  let rings = [];

  let yaw = 0;
  let satAngle = 0.7;
  let nextScanIn = 1200;

  let running = true;
  let rafId = null;
  let startedAt = performance.now();
  let lastFrameAt = startedAt;

  /** Unit sphere sampled with a fibonacci spiral — evenly spaced points. */
  const spherePoints = buildSphere(CONFIG.globePoints);

  /* ------------------------------------------------------------------ *
   * Colour helpers
   * ------------------------------------------------------------------ */

  function rgba(channels, alpha) {
    return `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, ${alpha})`;
  }

  const ink = (alpha) => rgba(PALETTE.ink, alpha);
  const far = (alpha) => rgba(PALETTE.far, alpha);
  const laser = (alpha) => rgba(PALETTE.laser, alpha);

  /* ------------------------------------------------------------------ *
   * Vector maths — the sphere lives in "model" space, which the current
   * yaw and tilt rotate into "view" space before projection.
   * ------------------------------------------------------------------ */

  function buildSphere(count) {
    const points = [];
    for (let i = 0; i < count; i++) {
      const y = 1 - (i / (count - 1)) * 2;
      const ring = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = i * 2.399963; // golden angle

      points.push({
        x: Math.cos(theta) * ring,
        y,
        z: Math.sin(theta) * ring,
        // per-grain intro seeds: when it launches, and how far it strays
        delay: Math.random() * CONFIG.introMaxDelay,
        driftX: (Math.random() - 0.5) * 0.5,
        driftY: (Math.random() - 0.5) * 0.5
      });
    }
    return points;
  }

  /** Overshoot easing — the grain flies past its resting radius, then settles. */
  function easeOutBack(x) {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
  }

  function easeOutCubic(x) {
    return 1 - Math.pow(1 - x, 3);
  }

  function clamp01(x) {
    return x < 0 ? 0 : x > 1 ? 1 : x;
  }

  function cross(a, b) {
    return {
      x: a.y * b.z - a.z * b.y,
      y: a.z * b.x - a.x * b.z,
      z: a.x * b.y - a.y * b.x
    };
  }

  function normalise(v) {
    const m = Math.hypot(v.x, v.y, v.z) || 1;
    return { x: v.x / m, y: v.y / m, z: v.z / m };
  }

  /** Two orthonormal vectors spanning the tangent plane at unit vector `c`. */
  function tangentBasis(c) {
    const helper = Math.abs(c.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
    const u = normalise(cross(c, helper));
    return { u, v: cross(c, u) };
  }

  /**
   * The point that sits `angle` radians away from `c` along the surface,
   * in the direction `bearing`. Sweeping bearing draws a circle on the sphere.
   */
  function surfacePoint(c, u, v, angle, bearing) {
    const sa = Math.sin(angle);
    const ca = Math.cos(angle);
    const du = Math.cos(bearing) * sa;
    const dv = Math.sin(bearing) * sa;

    return {
      x: c.x * ca + u.x * du + v.x * dv,
      y: c.y * ca + u.y * du + v.y * dv,
      z: c.z * ca + u.z * du + v.z * dv
    };
  }

  /** Project a model-space unit vector to the screen. `facing` > 0 is visible. */
  function modelToScreen(p) {
    const cosYaw = Math.cos(yaw);
    const sinYaw = Math.sin(yaw);
    const cosTilt = Math.cos(TILT);
    const sinTilt = Math.sin(TILT);

    const x1 = p.x * cosYaw + p.z * sinYaw;
    const z1 = -p.x * sinYaw + p.z * cosYaw;

    return {
      x: centreX + x1 * radius,
      y: centreY + (p.y * cosTilt - z1 * sinTilt) * radius,
      facing: p.y * sinTilt + z1 * cosTilt
    };
  }

  /**
   * Inverse of modelToScreen for a point known to lie on the sphere:
   * returns the model-space unit vector under a screen coordinate, or
   * null when the screen point misses the globe entirely.
   */
  function screenToModel(screenX, screenY) {
    const x1 = (screenX - centreX) / radius;
    const y2 = (screenY - centreY) / radius;
    const planar = x1 * x1 + y2 * y2;
    if (planar > 1) return null;

    const z2 = Math.sqrt(1 - planar); // near hemisphere

    const cosTilt = Math.cos(TILT);
    const sinTilt = Math.sin(TILT);
    const y = y2 * cosTilt + z2 * sinTilt;
    const z1 = -y2 * sinTilt + z2 * cosTilt;

    const cosYaw = Math.cos(yaw);
    const sinYaw = Math.sin(yaw);

    return {
      x: x1 * cosYaw - z1 * sinYaw,
      y,
      z: x1 * sinYaw + z1 * cosYaw
    };
  }

  /* ------------------------------------------------------------------ *
   * Sizing
   * ------------------------------------------------------------------ */

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const isWide = width > 820;
    radius = Math.min(width, height) * (isWide ? 0.42 : 0.36);
    centreX = isWide ? width * 0.7 : width * 0.5;
    centreY = isWide ? height * 0.52 : height * 0.66;
  }

  /* ------------------------------------------------------------------ *
   * Scans and splashes
   * ------------------------------------------------------------------ */

  function satellitePosition() {
    const orbit = radius * 1.38;
    return {
      x: centreX + Math.cos(satAngle) * orbit,
      y: centreY - radius * 0.34 + Math.sin(satAngle) * orbit * 0.3
    };
  }

  /** Launch a laser from the satellite toward (x, y). */
  function fireScan(x, y, swarmSize) {
    scans.push({
      x, y,
      t: 0,
      from: satellitePosition(),
      size: swarmSize || CONFIG.swarmSize,
      landed: false
    });
  }

  /**
   * Impact. If the laser landed on the globe the splash is anchored to the
   * sphere's surface; otherwise it falls back to a flat screen-space splash.
   */
  function splash(x, y, count) {
    const centre = screenToModel(x, y);
    if (centre) spawnSurfaceSplash(centre, count);
    else spawnFlatSplash(x, y, count);

    if (nodes.length > CONFIG.maxNodes) {
      nodes.splice(0, nodes.length - CONFIG.maxNodes);
    }
  }

  function spawnSurfaceSplash(centre, count) {
    const { u, v } = tangentBasis(centre);
    const [minSpread, maxSpread] = CONFIG.swarmSpread;

    for (let i = 0; i < count; i++) {
      nodes.push({
        onSurface: true,
        c: centre, u, v,
        bearing: (i / count) * TWO_PI + Math.random() * 0.6,
        angle: 0.02 + Math.random() * 0.05,
        spread: minSpread + Math.random() * (maxSpread - minSpread),
        phase: Math.random() * 6.28,
        life: 0,
        maxLife: 4200 + Math.random() * 2600
      });
    }

    rings.push({ onSurface: true, c: centre, u, v, t: 0, max: 1500 });
    rings.push({ onSurface: true, c: centre, u, v, t: -220, max: 1700 });
  }

  function spawnFlatSplash(x, y, count) {
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * TWO_PI + Math.random() * 0.6;
      const speed = 0.35 + Math.random() * 0.75;
      nodes.push({
        onSurface: false,
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed * 0.7,
        phase: Math.random() * 6.28,
        life: 0,
        maxLife: 4200 + Math.random() * 2600
      });
    }

    rings.push({ onSurface: false, x, y, t: 0, max: 1500, radius: radius * 0.55 });
    rings.push({ onSurface: false, x, y, t: -220, max: 1700, radius: radius * 0.8 });
  }

  /* ------------------------------------------------------------------ *
   * Render passes
   * ------------------------------------------------------------------ */

  function drawStarfield() {
    ctx.fillStyle = PALETTE.haze;
    for (let i = 0; i < 90; i++) {
      const x = (((i * 8161) % 1000) / 1000) * width;
      const y = (((i * 3733) % 997) / 997) * height;
      ctx.fillRect(x, y, 1.1, 1.1);
    }
  }

  /**
   * The globe. During the intro every grain starts at the centre as flat grey,
   * detonates outward past its resting radius, then settles onto the sphere and
   * takes its proper colour — `intro` runs 1 → 0 as that resolves.
   */
  function drawGlobe(intro) {
    const cosYaw = Math.cos(yaw);
    const sinYaw = Math.sin(yaw);
    const cosTilt = Math.cos(TILT);
    const sinTilt = Math.sin(TILT);

    const settling = intro < 1;
    const span = 1 - CONFIG.introMaxDelay;
    const [gr, gg, gb] = PALETTE.grain;

    for (let i = 0; i < spherePoints.length; i++) {
      const p = spherePoints[i];

      // rotate about Y, then tilt about X
      const x1 = p.x * cosYaw + p.z * sinYaw;
      const z1 = -p.x * sinYaw + p.z * cosYaw;
      const y2 = p.y * cosTilt - z1 * sinTilt;
      const z2 = p.y * sinTilt + z1 * cosTilt;

      const facing = (z2 + 1) / 2;
      let alpha = 0.07 + facing * facing * 0.85;
      let size = 1 + facing;
      let scale = 1;
      let driftX = 0;
      let driftY = 0;
      let grain = 0;

      if (settling) {
        const raw = clamp01((intro - p.delay) / span);
        scale = easeOutBack(raw);          // flies out, overshoots, settles
        grain = 1 - easeOutCubic(raw);     // 1 = raw grey, 0 = fully resolved
        driftX = p.driftX * grain * radius;
        driftY = p.driftY * grain * radius;
        alpha *= 0.35 + 0.65 * (1 - grain);
        size += grain * 0.8;               // grains read chunkier mid-flight
      }

      if (grain > 0.001) {
        // lerp from flat grey toward the grain's resting colour
        const near = z2 > 0.55;
        const tr = near ? PALETTE.ink[0] : PALETTE.far[0];
        const tg = near ? PALETTE.ink[1] : PALETTE.far[1];
        const tb = near ? PALETTE.ink[2] : PALETTE.far[2];
        ctx.fillStyle = `rgba(${Math.round(gr + (tr - gr) * (1 - grain))}, ` +
                        `${Math.round(gg + (tg - gg) * (1 - grain))}, ` +
                        `${Math.round(gb + (tb - gb) * (1 - grain))}, ${alpha})`;
      } else {
        ctx.fillStyle = z2 > 0.55 ? ink(alpha * 0.95) : far(alpha);
      }

      ctx.fillRect(
        centreX + x1 * radius * scale + driftX - size / 2,
        centreY + y2 * radius * scale + driftY - size / 2,
        size, size
      );
    }

    // limb + orbit rings — fade in behind the settling grains
    const framing = settling ? easeOutCubic(clamp01((intro - 0.55) / 0.45)) : 1;
    if (framing <= 0.001) return;

    ctx.lineWidth = 1;
    ctx.strokeStyle = ink(0.16 * framing);
    ctx.beginPath();
    ctx.arc(centreX, centreY, radius * 1.005, 0, TWO_PI);
    ctx.stroke();

    ctx.strokeStyle = far(0.35 * framing);
    ctx.beginPath();
    ctx.arc(centreX, centreY, radius * 1.38, 0, TWO_PI);
    ctx.stroke();
  }

  function drawSatellite() {
    const orbit = radius * 1.38;

    // fading trail
    for (let i = 1; i <= 16; i++) {
      const angle = satAngle - i * 0.028;
      ctx.fillStyle = ink(0.28 * (1 - i / 16));
      ctx.fillRect(
        centreX + Math.cos(angle) * orbit - 1,
        centreY - radius * 0.34 + Math.sin(angle) * orbit * 0.3 - 1,
        2, 2
      );
    }

    const pos = satellitePosition();

    ctx.save();
    ctx.translate(pos.x, pos.y);
    ctx.rotate(satAngle * 0.6);
    ctx.strokeStyle = ink(0.95);
    ctx.lineWidth = 1.2;
    ctx.strokeRect(-3.5, -3.5, 7, 7);
    ctx.beginPath();
    ctx.moveTo(-11, 0); ctx.lineTo(-4.5, 0);
    ctx.moveTo(4.5, 0);  ctx.lineTo(11, 0);
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = ink(0.08);
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, 9, 0, TWO_PI);
    ctx.fill();
  }

  function updateScans(dt) {
    for (let i = scans.length - 1; i >= 0; i--) {
      const scan = scans[i];
      scan.t += dt;

      const progress = Math.min(1, scan.t / 620);
      const x = scan.from.x + (scan.x - scan.from.x) * progress;
      const y = scan.from.y + (scan.y - scan.from.y) * progress;

      // the beam itself
      const gradient = ctx.createLinearGradient(scan.from.x, scan.from.y, scan.x, scan.y);
      gradient.addColorStop(0, laser(0.06));
      gradient.addColorStop(1, laser(0.8));
      ctx.strokeStyle = gradient;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(scan.from.x, scan.from.y);
      ctx.lineTo(x, y);
      ctx.stroke();

      // beam cone
      const spread = 9 * progress;
      ctx.fillStyle = laser(0.07 * (1 - progress * 0.4));
      ctx.beginPath();
      ctx.moveTo(scan.from.x, scan.from.y);
      ctx.lineTo(x - spread, y);
      ctx.lineTo(x + spread, y);
      ctx.closePath();
      ctx.fill();

      // leading edge
      ctx.fillStyle = laser(0.14);
      ctx.beginPath();
      ctx.arc(x, y, 5.5, 0, TWO_PI);
      ctx.fill();
      ctx.fillStyle = laser(0.95);
      ctx.beginPath();
      ctx.arc(x, y, 2, 0, TWO_PI);
      ctx.fill();

      if (progress >= 1 && !scan.landed) {
        scan.landed = true;
        splash(scan.x, scan.y, scan.size);
      }
      if (scan.t > 900) scans.splice(i, 1);
    }
  }

  /** A shockwave ring travelling outward across the globe's surface. */
  function strokeSurfaceRing(ring, angle) {
    const STEPS = 72;
    let penDown = false;

    ctx.beginPath();
    for (let i = 0; i <= STEPS; i++) {
      const bearing = (i / STEPS) * TWO_PI;
      const point = modelToScreen(surfacePoint(ring.c, ring.u, ring.v, angle, bearing));

      if (point.facing <= 0.02) {   // gone over the horizon
        penDown = false;
        continue;
      }
      if (penDown) ctx.lineTo(point.x, point.y);
      else { ctx.moveTo(point.x, point.y); penDown = true; }
    }
    ctx.stroke();
  }

  function updateRings(dt) {
    for (let i = rings.length - 1; i >= 0; i--) {
      const ring = rings[i];
      ring.t += dt;
      if (ring.t < 0) continue;

      const progress = ring.t / ring.max;
      if (progress >= 1) {
        rings.splice(i, 1);
        continue;
      }

      ctx.strokeStyle = laser(0.45 * (1 - progress));
      ctx.lineWidth = 1.2;

      if (ring.onSurface) {
        strokeSurfaceRing(ring, CONFIG.ringMaxAngle * progress);
      } else {
        ctx.beginPath();
        ctx.ellipse(ring.x, ring.y, ring.radius * progress, ring.radius * progress * 0.42, 0, 0, TWO_PI);
        ctx.stroke();
      }
    }
  }

  function updateSwarm(dt) {
    // advance, and resolve every node to a screen position
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      node.life += dt;
      if (node.life > node.maxLife) {
        nodes.splice(i, 1);
        continue;
      }

      node.phase += dt * 0.004;

      if (node.onSurface) {
        // crawl outward along the surface, wandering a little as it goes
        node.angle += node.spread * dt;
        node.bearing += Math.sin(node.phase) * 0.00016 * dt;

        const projected = modelToScreen(
          surfacePoint(node.c, node.u, node.v, node.angle, node.bearing)
        );
        node.sx = projected.x;
        node.sy = projected.y;
        node.visible = projected.facing > 0;
      } else {
        node.x += (node.vx + Math.cos(node.phase) * 0.14) * dt * 0.06;
        node.y += (node.vy + Math.sin(node.phase * 1.3) * 0.12) * dt * 0.06;
        node.vx *= 0.994;
        node.vy *= 0.994;

        if (mouse.active) {
          const dx = mouse.x - node.x;
          const dy = mouse.y - node.y;
          const dist = Math.hypot(dx, dy);
          if (dist > 60 && dist < 320) {
            node.vx += (dx / dist) * 0.006 * dt * 0.06;
            node.vy += (dy / dist) * 0.006 * dt * 0.06;
          }
        }

        node.sx = node.x;
        node.sy = node.y;
        node.visible = true;
      }

      node.fade = Math.min(1, node.life / 300) * (1 - node.life / node.maxLife);
    }

    // mesh links between near neighbours
    ctx.lineWidth = 0.7;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      if (!a.visible) continue;

      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        if (!b.visible) continue;

        const dx = a.sx - b.sx;
        const dy = a.sy - b.sy;
        const distSq = dx * dx + dy * dy;
        if (distSq >= CONFIG.linkDistanceSq) continue;

        ctx.strokeStyle = ink(0.3 * (1 - Math.sqrt(distSq) / 105) * a.fade * b.fade);
        ctx.beginPath();
        ctx.moveTo(a.sx, a.sy);
        ctx.lineTo(b.sx, b.sy);
        ctx.stroke();
      }
    }

    // node bodies
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (!node.visible) continue;

      ctx.fillStyle = ink(0.85 * node.fade);
      ctx.beginPath();
      ctx.arc(node.sx, node.sy, 1.6, 0, TWO_PI);
      ctx.fill();

      ctx.fillStyle = ink(0.08 * node.fade);
      ctx.beginPath();
      ctx.arc(node.sx, node.sy, 6, 0, TWO_PI);
      ctx.fill();
    }
  }

  function drawReticle(elapsed) {
    if (!mouse.active) return;

    ctx.save();
    ctx.translate(mouse.x, mouse.y);

    ctx.strokeStyle = ink(0.7);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-22, 0); ctx.lineTo(-7, 0);
    ctx.moveTo(7, 0);   ctx.lineTo(22, 0);
    ctx.moveTo(0, -22); ctx.lineTo(0, -7);
    ctx.moveTo(0, 7);   ctx.lineTo(0, 22);
    ctx.stroke();

    ctx.rotate(elapsed * 0.0006);
    ctx.strokeStyle = ink(0.35);
    for (let i = 0; i < 4; i++) {
      ctx.rotate(Math.PI / 2);
      ctx.beginPath();
      ctx.moveTo(13, 5);
      ctx.lineTo(13, 13);
      ctx.lineTo(5, 13);
      ctx.stroke();
    }
    ctx.restore();

    if (readout) {
      const lat = (90 - (mouse.y / height) * 180).toFixed(2);
      const lon = ((mouse.x / width) * 360 - 180).toFixed(2);
      readout.textContent = `LAT ${lat} LON ${lon}`;
    }
  }

  /* ------------------------------------------------------------------ *
   * Frame
   * ------------------------------------------------------------------ */

  function render(elapsed, dt) {
    ctx.clearRect(0, 0, width, height);

    // driven by elapsed time, not summed deltas — those are frame-capped
    const intro = prefersReducedMotion ? 1 : clamp01(elapsed / CONFIG.introMs);

    yaw += 0.00022 * dt;
    satAngle += 0.00042 * dt;

    drawStarfield();
    drawGlobe(intro);

    // the satellite arrives with the framing rings, once the grains have landed
    const framing = intro >= 1 ? 1 : easeOutCubic(clamp01((intro - 0.55) / 0.45));
    if (framing > 0.01) {
      ctx.save();
      ctx.globalAlpha = framing;
      drawSatellite();
      ctx.restore();
    }

    // no scanning until the globe has resolved
    if (intro >= 1) {
      nextScanIn -= dt;
      if (nextScanIn <= 0) {
        const [min, max] = CONFIG.scanIntervalMs;
        nextScanIn = min + Math.random() * (max - min);

        const angle = Math.random() * TWO_PI;
        const r = Math.sqrt(Math.random()) * radius * 0.82;
        fireScan(centreX + Math.cos(angle) * r, centreY + Math.sin(angle) * r * 0.92, CONFIG.swarmSize);
      }
    }

    updateScans(dt);
    updateRings(dt);
    updateSwarm(dt);
    drawReticle(elapsed);
  }

  function loop(now) {
    const dt = Math.min(CONFIG.frameCapMs, now - lastFrameAt);
    lastFrameAt = now;
    render(now - startedAt, dt);
    rafId = window.requestAnimationFrame(loop);
  }

  function start() {
    if (rafId !== null || prefersReducedMotion) return;
    lastFrameAt = performance.now();
    rafId = window.requestAnimationFrame(loop);
  }

  function stop() {
    if (rafId === null) return;
    window.cancelAnimationFrame(rafId);
    rafId = null;
  }

  /* ------------------------------------------------------------------ *
   * Wiring
   * ------------------------------------------------------------------ */

  window.addEventListener('resize', resize);

  window.addEventListener('pointermove', (event) => {
    mouse.x = event.clientX;
    mouse.y = event.clientY;
    mouse.active = true;
  }, { passive: true });

  window.addEventListener('pointerdown', (event) => {
    if (!running) return;
    if (event.target.closest && event.target.closest('a, button')) return;
    fireScan(event.clientX, event.clientY, CONFIG.clickSwarmSize);
  });

  // suspend the loop once the hero leaves the viewport
  if (hero && 'IntersectionObserver' in window) {
    new IntersectionObserver((entries) => {
      running = entries[0].isIntersecting;
      if (running) start();
      else stop();
    }, { threshold: 0 }).observe(hero);
  }

  // the theme controller in ui.js fires this after flipping data-theme
  window.addEventListener('themechange', () => {
    readPalette();
    if (rafId === null) render(CONFIG.introMs, 16); // repaint a suspended scene
  });

  readPalette();
  resize();

  if (prefersReducedMotion) {
    render(0, 16); // a single static frame
  } else {
    start();
  }
})();
