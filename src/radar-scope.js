// Radar scope look for the local map. Runs INSIDE the tar1090 page (main.js injects it when the
// "Radar scope" map style is chosen): hides the normal map, and draws coastlines and borders as a
// green wireframe on black, with range rings and a rotating sweep. Each stretch of outline goes to
// full brightness as the sweep passes over it, then fades to 15% before the next pass.
// The sweep is decoration: the receiver hears every aircraft all the time.
// Inputs set by main.js before this runs: window.__radarOutlines ({coast, borders} as flat
// [lon, lat, lon, lat, ...] lines) and window.__radarConfig ({rings, ringUnit, metresPerUnit}).
(() => {
  if (window.__radarScope) return;
  window.__radarScope = true;

  const SECTORS = 120;           // the circle is cut into this many slices; each slice fades on its own
  const SWEEP_SECONDS = 5;       // one full turn
  const FADE_TO = 0.15;          // how dim the outline gets just before the sweep comes round again
  const FRAME_MS = 33;           // about 30 frames a second, to go easy on the Pi
  const GREEN = '57, 255, 122';
  const R = 6378137;             // web-mercator earth radius, metres

  const mercator = (lon, lat) => [(lon * Math.PI / 180) * R, Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)) * R];
  // Convert every line once: mercator points plus a bounding box for quick "is it on screen" checks.
  const prepare = (lines) => lines.map((flat) => {
    const points = new Float64Array(flat.length);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < flat.length; i += 2) {
      const [x, y] = mercator(flat[i], Math.max(-85, Math.min(85, flat[i + 1])));
      points[i] = x; points[i + 1] = y;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    return { points, minX, minY, maxX, maxY };
  });

  const waiting = setInterval(() => {
    if (typeof OLMap === 'undefined' || !OLMap.getViewport || !OLMap.getSize()) return;
    clearInterval(waiting);
    start();
  }, 300);

  function start() {
    const coast = prepare(window.__radarOutlines.coast);
    const borders = prepare(window.__radarOutlines.borders);
    const config = window.__radarConfig || {};
    const viewport = OLMap.getViewport();
    viewport.style.background = '#000';

    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:0';
    viewport.insertBefore(canvas, viewport.firstChild); // behind the aircraft, which tar1090 draws in later elements
    const ctx = canvas.getContext('2d');

    // The ordinary map tiles are switched off (and kept off if the page turns them back on).
    const hideBaseMaps = () => {
      const visit = (layer) => {
        if (layer.getLayers) layer.getLayers().forEach(visit);
        else if (layer.get('type') === 'base' && layer.getVisible()) layer.setVisible(false);
      };
      OLMap.getLayers().forEach(visit);
    };
    hideBaseMaps();
    setInterval(hideBaseMaps, 2000);

    // Where the receiver is: tar1090's own site position, else wherever the map is centred at the start.
    const startCentre = OLMap.getView().getCenter();
    const site = () => (typeof SiteLat === 'number' && typeof SiteLon === 'number' ? mercator(SiteLon, SiteLat) : startCentre);

    let viewKey = '', sectors = [], dimSectors = [], rings = [], sitePx = [0, 0], reach = 0;

    // Rebuilt only when the map is moved, zoomed or resized: every on-screen piece of outline is
    // sorted into the slice of the circle it lies in, as seen from the receiver.
    function rebuild() {
      const view = OLMap.getView();
      const [width, height] = OLMap.getSize();
      const [cx, cy] = view.getCenter();
      const res = view.getResolution();
      const key = [width, height, cx, cy, res, site().join()].join();
      if (key === viewKey) return;
      viewKey = key;

      const scale = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      ctx.setTransform(scale, 0, 0, scale, 0, 0);

      const px = (x, y) => [(x - cx) / res + width / 2, (cy - y) / res + height / 2];
      sitePx = px(...site());
      reach = Math.hypot(Math.max(sitePx[0], width - sitePx[0]), Math.max(sitePx[1], height - sitePx[1]));
      const left = cx - (width / 2) * res, right = cx + (width / 2) * res;
      const bottom = cy - (height / 2) * res, top = cy + (height / 2) * res;

      const bucket = (lines) => {
        const paths = Array.from({ length: SECTORS }, () => null);
        for (const line of lines) {
          if (line.maxX < left || line.minX > right || line.maxY < bottom || line.minY > top) continue;
          const p = line.points;
          let [ax, ay] = px(p[0], p[1]);
          for (let i = 2; i < p.length; i += 2) {
            const [bx, by] = px(p[i], p[i + 1]);
            if (Math.max(ax, bx) >= 0 && Math.min(ax, bx) <= width && Math.max(ay, by) >= 0 && Math.min(ay, by) <= height) {
              // Compass bearing of the segment's middle from the receiver: 0 = up, clockwise.
              const bearing = Math.atan2((ax + bx) / 2 - sitePx[0], sitePx[1] - (ay + by) / 2);
              const index = Math.floor(((bearing + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI) * SECTORS) % SECTORS;
              (paths[index] ||= new Path2D()).moveTo(ax, ay);
              paths[index].lineTo(bx, by);
            }
            ax = bx; ay = by;
          }
        }
        return paths;
      };
      sectors = bucket(coast);
      dimSectors = bucket(borders);

      // Ring radius on screen: true distance, stretched by the map projection at the receiver's latitude.
      const siteLat = 2 * Math.atan(Math.exp(site()[1] / R)) - Math.PI / 2;
      rings = (config.rings || []).map((distance) => ({
        label: `${distance} ${config.ringUnit || ''}`.trim(),
        radius: (distance * (config.metresPerUnit || 1000)) / (res * Math.cos(siteLat)),
      }));
    }

    let lastFrame = 0;
    function frame(now) {
      requestAnimationFrame(frame);
      if (now - lastFrame < FRAME_MS) return;
      lastFrame = now;
      rebuild();
      const [width, height] = OLMap.getSize();
      ctx.clearRect(0, 0, width, height);

      const turn = (now / 1000 / SWEEP_SECONDS) % 1; // 0..1, clockwise from north
      // Brightness of a slice: 100% as the sweep passes, easing down to FADE_TO just before it returns.
      const glow = (index) => {
        const since = (turn - (index + 0.5) / SECTORS + 1) % 1;
        return FADE_TO + (1 - FADE_TO) * Math.pow(1 - since, 2.2);
      };

      ctx.lineJoin = 'round';
      ctx.lineWidth = 1.4;
      for (let i = 0; i < SECTORS; i++) {
        if (sectors[i]) { ctx.strokeStyle = `rgba(${GREEN}, ${glow(i)})`; ctx.stroke(sectors[i]); }
        if (dimSectors[i]) { ctx.strokeStyle = `rgba(${GREEN}, ${glow(i) * 0.45})`; ctx.stroke(dimSectors[i]); }
      }

      // Range rings and their labels.
      ctx.lineWidth = 1;
      ctx.strokeStyle = `rgba(${GREEN}, 0.35)`;
      ctx.fillStyle = `rgba(${GREEN}, 0.75)`;
      ctx.font = '11px ui-monospace, monospace';
      ctx.textAlign = 'center';
      for (const ring of rings) {
        ctx.beginPath(); ctx.arc(sitePx[0], sitePx[1], ring.radius, 0, 2 * Math.PI); ctx.stroke();
        ctx.fillText(ring.label, sitePx[0], sitePx[1] + ring.radius - 4);
      }

      // The sweep: a bright leading edge with a short fading tail behind it.
      const angle = turn * 2 * Math.PI - Math.PI / 2; // canvas angles start at "east"
      const tail = ctx.createConicGradient(angle - 0.5, sitePx[0], sitePx[1]);
      tail.addColorStop(0, `rgba(${GREEN}, 0)`);
      tail.addColorStop(0.5 / (2 * Math.PI), `rgba(${GREEN}, 0.22)`);
      tail.addColorStop(0.5 / (2 * Math.PI) + 0.0001, `rgba(${GREEN}, 0)`);
      ctx.fillStyle = tail;
      ctx.beginPath(); ctx.moveTo(sitePx[0], sitePx[1]); ctx.arc(sitePx[0], sitePx[1], reach, angle - 0.5, angle); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = `rgba(${GREEN}, 0.9)`;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(sitePx[0], sitePx[1]);
      ctx.lineTo(sitePx[0] + Math.cos(angle) * reach, sitePx[1] + Math.sin(angle) * reach); ctx.stroke();

      ctx.fillStyle = `rgb(${GREEN})`;
      ctx.beginPath(); ctx.arc(sitePx[0], sitePx[1], 3, 0, 2 * Math.PI); ctx.fill();
    }
    requestAnimationFrame(frame);
  }
})();
