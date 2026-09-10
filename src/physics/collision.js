/* ============================================================
   collision.js — the static world: triangle soup + AABB proxies,
   a sparse uniform-grid broadphase, exact capsule/triangle contacts,
   and a DDA raycast.

   Everything the world builds gets flattened to triangles here. An
   AABB proxy is just 12 triangles with a `proxy` flag, so there is one
   narrowphase code path and no special cases. Boxes are cheap enough
   that the "cheap proxy" promise still holds: a box costs 12 tris and
   one grid insert, a mesh costs thousands.

   The broadphase is a sparse 3D hash grid (default 2 m cells). A city
   block plus terrain lands in the tens of thousands of triangles; the
   grid keeps every capsule query to a handful of cells.

   No allocation in any query path — callers pass result arrays and the
   scratch below is reused.
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { clamp } from '../core/contracts.js';

const EPS = 1e-8;

/* ------------------------------------------------------------------
   Narrowphase maths. All of these are allocation-free.
   ------------------------------------------------------------------ */

/** Closest point on triangle abc to point p. Writes `out`, returns it. */
export function closestPointOnTriangle(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz, out) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;

  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) { out.set(ax, ay, az); return out; }

  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) { out.set(bx, by, bz); return out; }

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    out.set(ax + abx * v, ay + aby * v, az + abz * v); return out;
  }

  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) { out.set(cx, cy, cz); return out; }

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    out.set(ax + acx * w, ay + acy * w, az + acz * w); return out;
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    out.set(bx + (cx - bx) * w, by + (cy - by) * w, bz + (cz - bz) * w); return out;
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  out.set(ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w);
  return out;
}

const _ss = { s: 0, t: 0 };
/** Closest points between segments p1q1 and p2q2. Fills _ss with params. */
function closestSegmentSegment(p1, q1, p2x, p2y, p2z, q2x, q2y, q2z) {
  const d1x = q1.x - p1.x, d1y = q1.y - p1.y, d1z = q1.z - p1.z;
  const d2x = q2x - p2x, d2y = q2y - p2y, d2z = q2z - p2z;
  const rx = p1.x - p2x, ry = p1.y - p2y, rz = p1.z - p2z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  let s, t;
  if (a <= EPS && e <= EPS) { _ss.s = 0; _ss.t = 0; return _ss; }
  if (a <= EPS) { s = 0; t = clamp(f / e, 0, 1); }
  else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= EPS) { t = 0; s = clamp(-c / a, 0, 1); }
    else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const denom = a * e - b * b;
      s = denom !== 0 ? clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); }
      else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
    }
  }
  _ss.s = s; _ss.t = t;
  return _ss;
}

const _cp = new THREE.Vector3();
const _cq = new THREE.Vector3();
const _best = new THREE.Vector3();
const _bestOn = new THREE.Vector3();

/**
 * Exact closest-approach between a capsule segment (a..b, radius r) and a
 * triangle. Returns penetration depth (>0 means overlapping) and writes the
 * separating normal + contact point.
 *
 * Exact, not the usual plane-projection approximation: we take the minimum
 * over point-vs-triangle at both caps and segment-vs-each-edge. Six cheap
 * tests, and it does not miss the edge cases where a capsule lands exactly
 * on a triangle edge — which is *every* step of a staircase.
 *
 * `eflags` is the internal-edge mask for this triangle (bit e set = edge e
 * is shared with a coplanar neighbour, i.e. it is a triangulation seam and
 * not a real crease). See _markInternalEdges: a contact that lands on such
 * a seam must report the FACE normal, never the radial one.
 */
export function capsuleTriangleContact(a, b, r, t, o, nx, ny, nz, out, eflags = 0) {
  const ax = t[o], ay = t[o + 1], az = t[o + 2];
  const bx = t[o + 3], by = t[o + 4], bz = t[o + 5];
  const cx = t[o + 6], cy = t[o + 7], cz = t[o + 8];

  /* Fast path: project the segment onto the triangle normal. If the whole
     segment sits further than r on one side, there is no contact. */
  const da = (a.x - ax) * nx + (a.y - ay) * ny + (a.z - az) * nz;
  const db = (b.x - ax) * nx + (b.y - ay) * ny + (b.z - az) * nz;
  if (da > r && db > r) return 0;
  if (da < -r && db < -r) return 0;

  let bestD2 = Infinity;

  /* Segment point whose projection lands inside the triangle (the common
     face contact) — parameterise where the segment crosses the plane. */
  let s = 0;
  if (Math.abs(da - db) > EPS) s = clamp(da / (da - db), 0, 1);
  else s = 0.5;
  for (let k = 0; k < 3; k++) {
    const u = k === 0 ? s : (k === 1 ? 0 : 1);
    _cp.set(a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u, a.z + (b.z - a.z) * u);
    closestPointOnTriangle(_cp.x, _cp.y, _cp.z, ax, ay, az, bx, by, bz, cx, cy, cz, _cq);
    /* Refine: pull back onto the segment from that triangle point. */
    const ss = closestSegmentSegment(a, b, _cq.x, _cq.y, _cq.z, _cq.x, _cq.y, _cq.z);
    _cp.set(a.x + (b.x - a.x) * ss.s, a.y + (b.y - a.y) * ss.s, a.z + (b.z - a.z) * ss.s);
    const d2 = _cp.distanceToSquared(_cq);
    if (d2 < bestD2) { bestD2 = d2; _best.copy(_cp); _bestOn.copy(_cq); }
  }

  /* Edges — required for stairs, kerbs and any capsule sliding along a seam. */
  for (let e = 0; e < 3; e++) {
    const ex = e === 0 ? ax : e === 1 ? bx : cx;
    const ey = e === 0 ? ay : e === 1 ? by : cy;
    const ez = e === 0 ? az : e === 1 ? bz : cz;
    const fx = e === 0 ? bx : e === 1 ? cx : ax;
    const fy = e === 0 ? by : e === 1 ? cy : ay;
    const fz = e === 0 ? bz : e === 1 ? cz : az;
    const ss = closestSegmentSegment(a, b, ex, ey, ez, fx, fy, fz);
    _cp.set(a.x + (b.x - a.x) * ss.s, a.y + (b.y - a.y) * ss.s, a.z + (b.z - a.z) * ss.s);
    _cq.set(ex + (fx - ex) * ss.t, ey + (fy - ey) * ss.t, ez + (fz - ez) * ss.t);
    const d2 = _cp.distanceToSquared(_cq);
    if (d2 < bestD2) { bestD2 = d2; _best.copy(_cp); _bestOn.copy(_cq); }
  }

  const d = Math.sqrt(bestD2);
  if (d >= r) return 0;

  out.point.copy(_bestOn);
  if (d > 1e-6) {
    out.normal.copy(_best).sub(_bestOn).divideScalar(d);
    /* Deep contacts can flip the sign; trust the face normal side. */
    if (out.normal.x * nx + out.normal.y * ny + out.normal.z * nz < 0 && (da + db) > 0) {
      out.normal.set(nx, ny, nz);
    }
  } else {
    out.normal.set(nx, ny, nz);
    if ((da + db) < 0) out.normal.multiplyScalar(-1);
  }

  /* ---- triangulation seams ----------------------------------------
     If the winning feature is the interior of an INTERNAL edge — the
     diagonal that splits a quad, the seam between two coplanar terrain
     tris — then the radial normal we just computed is a fiction: it
     tilts out of the face by however far the contact point sits from
     the seam, and a capsule resting against it gets a phantom sideways
     plane. Clip velocity against that phantom and the body creeps along
     the wall until it walks off the end of it. On a flat region the only
     correct separating direction is the face normal.
     (Depth is left as the radial one, which under-states the true face
     depth — the coplanar neighbour reports the exact value and the
     deepest contact wins, so this can never over-push.)              */
  if (eflags) {
    for (let e = 0; e < 3; e++) {
      if (!(eflags & (1 << e))) continue;
      const ex = t[o + e * 3], ey = t[o + e * 3 + 1], ez = t[o + e * 3 + 2];
      const f = (e + 1) % 3;
      const fx = t[o + f * 3], fy = t[o + f * 3 + 1], fz = t[o + f * 3 + 2];
      const sx = fx - ex, sy = fy - ey, sz = fz - ez;
      const ll = sx * sx + sy * sy + sz * sz;
      if (ll < EPS) continue;
      const u = ((_bestOn.x - ex) * sx + (_bestOn.y - ey) * sy + (_bestOn.z - ez) * sz) / ll;
      if (u <= 1e-4 || u >= 1 - 1e-4) continue;          // a corner, not a seam
      const qx = ex + sx * u - _bestOn.x, qy = ey + sy * u - _bestOn.y, qz = ez + sz * u - _bestOn.z;
      if (qx * qx + qy * qy + qz * qz > 1e-10) continue;  // not on this edge
      out.normal.set(nx, ny, nz);
      if ((da + db) < 0) out.normal.multiplyScalar(-1);
      break;
    }
  }
  return r - d;
}

/** Möller–Trumbore, double sided. Returns t along dir, or -1. */
function rayTriangle(ox, oy, oz, dx, dy, dz, t, o) {
  const ax = t[o], ay = t[o + 1], az = t[o + 2];
  const e1x = t[o + 3] - ax, e1y = t[o + 4] - ay, e1z = t[o + 5] - az;
  const e2x = t[o + 6] - ax, e2y = t[o + 7] - ay, e2z = t[o + 8] - az;
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (det > -EPS && det < EPS) return -1;
  const inv = 1 / det;
  const tx = ox - ax, ty = oy - ay, tz = oz - az;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < -1e-6 || u > 1 + 1e-6) return -1;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < -1e-6 || u + v > 1 + 1e-6) return -1;
  return (e2x * qx + e2y * qy + e2z * qz) * inv;
}

/* Grid key packing: +/- 1024 cells around the origin on each axis. */
const GK = (ix, iy, iz) => ((ix + 1024) * 2048 + (iy + 1024)) * 2048 + (iz + 1024);

/* ------------------------------------------------------------------
   CollisionWorld
   ------------------------------------------------------------------ */
export class CollisionWorld {
  constructor(opts = {}) {
    this.cellSize = opts.cellSize ?? 2.0;
    this.inv = 1 / this.cellSize;

    this.capacity = 1024;
    this.tri = new Float32Array(this.capacity * 9);
    this.nrm = new Float32Array(this.capacity * 3);
    this.body = new Int32Array(this.capacity);
    this.alive = new Uint8Array(this.capacity);
    /* Per triangle, 3 bits: edge AB / BC / CA is a triangulation seam
       (shared with a coplanar neighbour) rather than a real crease. */
    this.edge = new Uint8Array(this.capacity);
    this.count = 0;                 // SLOT high-water, never the live count

    this.grid = new Map();          // packed cell key -> Int32Array-backed list
    this.bodies = new Map();        // id -> record
    this._nextId = 1;

    /* ---- freed triangle spans ------------------------------------
       remove() used to clear alive[] and prune the grid and stop there,
       so every mount/dismount of a streamed body burned its slots for
       the rest of the session. Nothing got slower — a dead slot is
       skipped on `!alive[t]` and the grid no longer names it — but the
       backing arrays only ever double: 58 B a slot (tri 36, nrm 12,
       body 4, stamp 4, alive 1, edge 1). That ceiling is the whole
       budget on the mobile path, and it is why this list exists.

       Bucketed by span LENGTH, each entry the start index of a
       CONTIGUOUS run of dead slots. Contiguity is not an implementation
       detail: remove() walks [start, start+count) and _markInternalEdges
       walks [start, start+count), so a per-slot free list would silently
       break both. Exact size only — no splitting, no coalescing. Churn
       comes in a handful of fixed sizes (12 for a box proxy, one size
       per streamed chunk), so exact fits recycle all of it, and a split
       span leaves ragged sizes that never match anything again. */
    this._free = new Map();         // span length -> [startIndex, ...]
    this._freeSlots = 0;            // dead slots parked in _free
    this._live = 0;                 // ALIVE triangles

    /* Per-ray/query dedupe stamps so a triangle spanning many cells is
       only narrowphased once. */
    this.stamp = new Int32Array(this.capacity);
    this._stampId = 0;

    this.bounds = new THREE.Box3(
      new THREE.Vector3(Infinity, Infinity, Infinity),
      new THREE.Vector3(-Infinity, -Infinity, -Infinity),
    );

    /* Fallback ground. 'auto' means: act as an infinite plane at
       groundPlaneY only while no static geometry has been registered.
       world.js can pin it with setGroundPlane(y) or kill it with null. */
    this.groundPlane = opts.groundPlane ?? 'auto';
    this.groundPlaneY = opts.groundPlaneY ?? 0;

    this._contact = { point: new THREE.Vector3(), normal: new THREE.Vector3(), depth: 0, tri: -1, body: 0 };
    this._tmpA = new THREE.Vector3();
    this._tmpB = new THREE.Vector3();
  }

  /** ALIVE triangles. Not `count`: the moment anything has been removed
      the two differ, and every reader that printed `count` as "triangles"
      was quoting the slot high-water. */
  get triangleCount() { return this._live; }
  /** Slots ever handed out — the number the backing arrays are sized to. */
  get slotCount() { return this.count; }
  /** Dead slots parked in the free list, waiting for a same-size body. */
  get freeSlotCount() { return this._freeSlots; }

  /** A contiguous run of `n` dead slots, or -1 if none is parked. */
  _takeSpan(n) {
    const bucket = this._free.get(n);
    if (bucket === undefined || bucket.length === 0) return -1;
    const start = bucket.pop();
    this._freeSlots -= n;
    return start;
  }

  /** Park a contiguous run of `n` slots that are all dead. */
  _giveSpan(start, n) {
    if (!(n > 0)) return;
    let bucket = this._free.get(n);
    if (bucket === undefined) this._free.set(n, bucket = []);
    bucket.push(start);
    this._freeSlots += n;
  }

  /** True when the flat fallback plane is currently in effect. */
  get planeActive() {
    if (this.groundPlane === null) return false;
    if (this.groundPlane === 'auto') return this.count === 0;
    return true;
  }
  get planeY() {
    return typeof this.groundPlane === 'number' ? this.groundPlane : this.groundPlaneY;
  }
  setGroundPlane(y) {
    this.groundPlane = y === null ? null : (y === 'auto' ? 'auto' : y);
    if (typeof y === 'number') this.groundPlaneY = y;
    return this;
  }

  _grow(need) {
    if (need <= this.capacity) return;
    let cap = this.capacity;
    while (cap < need) cap *= 2;
    const tri = new Float32Array(cap * 9); tri.set(this.tri);
    const nrm = new Float32Array(cap * 3); nrm.set(this.nrm);
    const body = new Int32Array(cap); body.set(this.body);
    const alive = new Uint8Array(cap); alive.set(this.alive);
    const edge = new Uint8Array(cap); edge.set(this.edge);
    this.tri = tri; this.nrm = nrm; this.body = body; this.alive = alive; this.edge = edge;
    this.stamp = new Int32Array(cap);
    this._stampId = 0;
    this.capacity = cap;
  }

  _insert(index, minx, miny, minz, maxx, maxy, maxz, cells) {
    const i0 = Math.floor(minx * this.inv), i1 = Math.floor(maxx * this.inv);
    const j0 = Math.floor(miny * this.inv), j1 = Math.floor(maxy * this.inv);
    const k0 = Math.floor(minz * this.inv), k1 = Math.floor(maxz * this.inv);
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++)
        for (let k = k0; k <= k1; k++) {
          const key = GK(i, j, k);
          let list = this.grid.get(key);
          if (!list) { list = []; this.grid.set(key, list); }
          list.push(index);
          if (cells) cells.push(key);
        }
  }

  /**
   * Register raw triangles.
   * @param positions Float32Array|Array of xyz triples (already triangulated)
   * @param indices   optional index array
   * @param opts      { matrix, layer, name, walkable }
   */
  addTriangles(positions, indices = null, opts = {}) {
    const m = opts.matrix ?? null;
    const nTri = indices ? indices.length / 3 : positions.length / 9;
    const id = this._nextId++;
    /* Take back a span of exactly this size before growing the arrays.
       `w` is the write cursor either way, so the triangles land in one
       contiguous run and everything downstream keeps its assumption. */
    const reused = this._takeSpan(nTri);
    if (reused < 0) this._grow(this.count + nTri);
    let w = reused < 0 ? this.count : reused;

    const rec = { id, start: w, count: 0, span: nTri, cells: [], opts, aabb: new THREE.Box3() };
    const a = this._tmpA, b = this._tmpB, c = new THREE.Vector3();
    const ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3();

    for (let t = 0; t < nTri; t++) {
      let i0, i1, i2;
      if (indices) { i0 = indices[t * 3]; i1 = indices[t * 3 + 1]; i2 = indices[t * 3 + 2]; }
      else { i0 = t * 3; i1 = t * 3 + 1; i2 = t * 3 + 2; }
      a.set(positions[i0 * 3], positions[i0 * 3 + 1], positions[i0 * 3 + 2]);
      b.set(positions[i1 * 3], positions[i1 * 3 + 1], positions[i1 * 3 + 2]);
      c.set(positions[i2 * 3], positions[i2 * 3 + 1], positions[i2 * 3 + 2]);
      if (m) { a.applyMatrix4(m); b.applyMatrix4(m); c.applyMatrix4(m); }

      ab.copy(b).sub(a); ac.copy(c).sub(a);
      n.crossVectors(ab, ac);
      const len = n.length();
      if (len < 1e-12) continue;                    // degenerate — drop it
      n.divideScalar(len);

      const idx = w++;
      const o = idx * 9;
      this.tri[o] = a.x; this.tri[o + 1] = a.y; this.tri[o + 2] = a.z;
      this.tri[o + 3] = b.x; this.tri[o + 4] = b.y; this.tri[o + 5] = b.z;
      this.tri[o + 6] = c.x; this.tri[o + 7] = c.y; this.tri[o + 8] = c.z;
      this.nrm[idx * 3] = n.x; this.nrm[idx * 3 + 1] = n.y; this.nrm[idx * 3 + 2] = n.z;
      this.body[idx] = id;
      this.alive[idx] = 1;
      this.edge[idx] = 0;
      rec.count++;

      const minx = Math.min(a.x, b.x, c.x), maxx = Math.max(a.x, b.x, c.x);
      const miny = Math.min(a.y, b.y, c.y), maxy = Math.max(a.y, b.y, c.y);
      const minz = Math.min(a.z, b.z, c.z), maxz = Math.max(a.z, b.z, c.z);
      this._insert(idx, minx, miny, minz, maxx, maxy, maxz, rec.cells);
      rec.aabb.expandByPoint(a).expandByPoint(b).expandByPoint(c);
      this.bounds.min.set(Math.min(this.bounds.min.x, minx), Math.min(this.bounds.min.y, miny), Math.min(this.bounds.min.z, minz));
      this.bounds.max.set(Math.max(this.bounds.max.x, maxx), Math.max(this.bounds.max.y, maxy), Math.max(this.bounds.max.z, maxz));
    }

    /* Degenerate triangles are dropped, so a bump-allocated span can end
       short: rewind rather than park a ragged size that would never match
       another body. A reused span keeps its bucket size so it goes back
       into the same bucket on the next remove(). */
    if (reused < 0) { this.count = w; rec.span = rec.count; }
    this._live += rec.count;

    this._markInternalEdges(rec.start, rec.count);
    this.bodies.set(id, rec);
    return id;
  }

  /**
   * Flag every edge shared by two COPLANAR triangles of the same body.
   *
   * These are seams, not geometry: the diagonal that splits a quad face,
   * the shared edge between two flat terrain cells. The narrowphase must
   * not invent a separating plane there — see capsuleTriangleContact. A
   * capsule pressed against a wall otherwise collects a phantom contact
   * plane tilted out of the wall, and clipping its velocity against that
   * phantom walks the body sideways along the wall at a few cm/s until it
   * slides off the end and sails straight through. That is exactly how a
   * 90 m/s body "tunnels" a 0.30 m wall it had already stopped against.
   *
   * One pass at registration, keys hashed on the quantised endpoints, so
   * it costs nothing at query time.
   */
  _markInternalEdges(start, count) {
    if (count < 2) return;
    const map = new Map();
    const key = (o) => `${Math.round(this.tri[o] * 8192)},${Math.round(this.tri[o + 1] * 8192)},${Math.round(this.tri[o + 2] * 8192)}`;
    for (let t = start; t < start + count; t++) {
      const o = t * 9;
      const vk = [key(o), key(o + 3), key(o + 6)];
      for (let e = 0; e < 3; e++) {
        const ka = vk[e], kb = vk[(e + 1) % 3];
        const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        const prev = map.get(k);
        if (prev === undefined) { map.set(k, t * 4 + e); continue; }
        /* An edge shared by three or more faces is never a flat seam. */
        map.set(k, -1);
        if (prev < 0) continue;
        const pt = (prev / 4) | 0, pe = prev % 4;
        const dot = this.nrm[t * 3] * this.nrm[pt * 3]
                  + this.nrm[t * 3 + 1] * this.nrm[pt * 3 + 1]
                  + this.nrm[t * 3 + 2] * this.nrm[pt * 3 + 2];
        if (dot > 0.9995) { this.edge[t] |= 1 << e; this.edge[pt] |= 1 << pe; }
      }
    }
  }

  /** Register a Mesh / Group / BufferGeometry. World matrices are baked in. */
  addMesh(source, opts = {}) {
    const ids = [];
    const add = (geom, matrix) => {
      const pos = geom.getAttribute('position');
      if (!pos) return;
      const idx = geom.getIndex();
      ids.push(this.addTriangles(pos.array, idx ? idx.array : null, { ...opts, matrix }));
    };
    if (source.isBufferGeometry) add(source, opts.matrix ?? null);
    else if (source.isObject3D) {
      source.updateWorldMatrix(true, true);
      source.traverse((o) => {
        if (!o.isMesh || o.userData?.noCollide) return;
        add(o.geometry, o.matrixWorld);
      });
    }
    return ids.length === 1 ? ids[0] : ids;
  }

  /** AABB proxy: 12 triangles, one grid pass. The cheap option. */
  addBox(box, opts = {}) {
    const { min, max } = box;
    const v = [
      min.x, min.y, min.z, max.x, min.y, min.z, max.x, min.y, max.z, min.x, min.y, max.z,
      min.x, max.y, min.z, max.x, max.y, min.z, max.x, max.y, max.z, min.x, max.y, max.z,
    ];
    const idx = [
      0, 2, 1, 0, 3, 2,   // bottom (wound down)
      4, 5, 6, 4, 6, 7,   // top
      0, 1, 5, 0, 5, 4,   // -z
      1, 2, 6, 1, 6, 5,   // +x
      2, 3, 7, 2, 7, 6,   // +z
      3, 0, 4, 3, 4, 7,   // -x
    ];
    return this.addTriangles(v, idx, { ...opts, proxy: true });
  }

  remove(id) {
    const rec = this.bodies.get(id);
    if (!rec) return false;
    for (let i = rec.start; i < rec.start + rec.count; i++) this.alive[i] = 0;
    const seen = new Set(rec.cells);
    for (const key of seen) {
      const list = this.grid.get(key);
      if (!list) continue;
      const kept = list.filter((i) => this.alive[i]);
      if (kept.length) this.grid.set(key, kept); else this.grid.delete(key);
    }
    this.bodies.delete(id);
    this._live -= rec.count;
    /* Hand the SLOTS back, not just the alive flags. This is safe exactly
       because of the loop above: rec.cells names every cell any of these
       indices was inserted into, and each of those lists was just rebuilt
       without them, so no grid list anywhere can still name a dead slot.
       The next body of this size writes over them. */
    this._giveSpan(rec.start, rec.span ?? rec.count);
    return true;
  }

  clear() {
    this.count = 0;
    this.grid.clear();
    this.bodies.clear();
    this.alive.fill(0);
    /* The free list indexes slots that no longer exist — parking them
       across a clear() would hand out live indices above a count of 0,
       and queryAABB would early-out on that count while the grid held
       geometry. Drop it with everything else. */
    this._free.clear();
    this._freeSlots = 0;
    this._live = 0;
    this.bounds.min.set(Infinity, Infinity, Infinity);
    this.bounds.max.set(-Infinity, -Infinity, -Infinity);
  }

  /* ---------------------------------------------------------------
     Broadphase
     --------------------------------------------------------------- */
  /** Collect triangle indices whose cells overlap the AABB. Fills `out`. */
  queryAABB(minx, miny, minz, maxx, maxy, maxz, out) {
    out.length = 0;
    if (this.count === 0) return out;
    const s = ++this._stampId;
    const i0 = Math.floor(minx * this.inv), i1 = Math.floor(maxx * this.inv);
    const j0 = Math.floor(miny * this.inv), j1 = Math.floor(maxy * this.inv);
    const k0 = Math.floor(minz * this.inv), k1 = Math.floor(maxz * this.inv);
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++)
        for (let k = k0; k <= k1; k++) {
          const list = this.grid.get(GK(i, j, k));
          if (!list) continue;
          for (let n = 0; n < list.length; n++) {
            const t = list[n];
            if (this.stamp[t] === s || !this.alive[t]) continue;
            this.stamp[t] = s;
            out.push(t);
          }
        }
    return out;
  }

  /* ---------------------------------------------------------------
     Capsule contacts
     --------------------------------------------------------------- */
  /**
   * All contacts between capsule (a..b, r) and the world.
   * `out` is filled with {point, normal, depth, tri, body} records reused
   * from an internal pool — copy anything you keep past the next call.
   */
  capsuleContacts(a, b, r, out, scratch) {
    out.length = 0;
    const list = scratch || (this._qbuf ||= []);
    const minx = Math.min(a.x, b.x) - r, maxx = Math.max(a.x, b.x) + r;
    const miny = Math.min(a.y, b.y) - r, maxy = Math.max(a.y, b.y) + r;
    const minz = Math.min(a.z, b.z) - r, maxz = Math.max(a.z, b.z) + r;
    this.queryAABB(minx, miny, minz, maxx, maxy, maxz, list);

    this._pool ||= [];
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      const o = t * 9;
      const nx = this.nrm[t * 3], ny = this.nrm[t * 3 + 1], nz = this.nrm[t * 3 + 2];
      let c = this._pool[out.length];
      if (!c) c = this._pool[out.length] = { point: new THREE.Vector3(), normal: new THREE.Vector3(), depth: 0, tri: -1, body: 0 };
      const depth = capsuleTriangleContact(a, b, r, this.tri, o, nx, ny, nz, c, this.edge[t]);
      if (depth > 1e-6) { c.depth = depth; c.tri = t; c.body = this.body[t]; out.push(c); }
    }

    /* The fallback plane behaves like an infinite floor. */
    if (this.planeActive) {
      const y = this.planeY;
      const lowY = Math.min(a.y, b.y);
      const depth = (y + r) - lowY;
      if (depth > 1e-6) {
        let c = this._pool[out.length];
        if (!c) c = this._pool[out.length] = { point: new THREE.Vector3(), normal: new THREE.Vector3(), depth: 0, tri: -1, body: 0 };
        const lx = a.y < b.y ? a.x : b.x, lz = a.y < b.y ? a.z : b.z;
        c.point.set(lx, y, lz);
        c.normal.set(0, 1, 0);
        c.depth = depth; c.tri = -1; c.body = 0;
        out.push(c);
      }
    }
    return out;
  }

  /* ---------------------------------------------------------------
     Raycast — 3D DDA over the grid, exact per triangle.
     --------------------------------------------------------------- */
  /**
   * @returns {point, normal, distance, tri, body, plane} | null
   */
  raycast(origin, dir, maxDist = Infinity, out = null) {
    const hit = out || (this._rayHit ||= {
      point: new THREE.Vector3(), normal: new THREE.Vector3(),
      distance: 0, tri: -1, body: 0, plane: false,
    });
    let dx = dir.x, dy = dir.y, dz = dir.z;
    const dl = Math.hypot(dx, dy, dz);
    if (dl < EPS) return null;
    dx /= dl; dy /= dl; dz /= dl;

    let bestT = maxDist;
    let bestTri = -1;

    if (this.count > 0) {
      const cs = this.cellSize;
      let ix = Math.floor(origin.x * this.inv);
      let iy = Math.floor(origin.y * this.inv);
      let iz = Math.floor(origin.z * this.inv);
      const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
      const tdx = Math.abs(dx) < EPS ? Infinity : Math.abs(cs / dx);
      const tdy = Math.abs(dy) < EPS ? Infinity : Math.abs(cs / dy);
      const tdz = Math.abs(dz) < EPS ? Infinity : Math.abs(cs / dz);
      const bx = (ix + (stepX > 0 ? 1 : 0)) * cs;
      const by = (iy + (stepY > 0 ? 1 : 0)) * cs;
      const bz = (iz + (stepZ > 0 ? 1 : 0)) * cs;
      let tmx = Math.abs(dx) < EPS ? Infinity : (bx - origin.x) / dx;
      let tmy = Math.abs(dy) < EPS ? Infinity : (by - origin.y) / dy;
      let tmz = Math.abs(dz) < EPS ? Infinity : (bz - origin.z) / dz;

      const s = ++this._stampId;
      let travelled = 0;
      let guard = 0;
      const guardMax = 4096;

      while (travelled <= bestT && guard++ < guardMax) {
        const list = this.grid.get(GK(ix, iy, iz));
        if (list) {
          for (let n = 0; n < list.length; n++) {
            const t = list[n];
            if (this.stamp[t] === s || !this.alive[t]) continue;
            this.stamp[t] = s;
            const tt = rayTriangle(origin.x, origin.y, origin.z, dx, dy, dz, this.tri, t * 9);
            if (tt >= 0 && tt < bestT) { bestT = tt; bestTri = t; }
          }
        }
        /* Stop once we are past the closest hit's cell. */
        if (bestTri >= 0 && travelled > bestT) break;
        if (tmx < tmy) {
          if (tmx < tmz) { ix += stepX; travelled = tmx; tmx += tdx; }
          else { iz += stepZ; travelled = tmz; tmz += tdz; }
        } else {
          if (tmy < tmz) { iy += stepY; travelled = tmy; tmy += tdy; }
          else { iz += stepZ; travelled = tmz; tmz += tdz; }
        }
        if (!Number.isFinite(travelled)) break;
        if (ix < -1024 || ix > 1023 || iy < -1024 || iy > 1023 || iz < -1024 || iz > 1023) break;
      }
    }

    /* Infinite fallback plane. */
    let planeHit = false;
    if (this.planeActive && Math.abs(dy) > EPS) {
      const t = (this.planeY - origin.y) / dy;
      if (t >= 0 && t < bestT && t <= maxDist) { bestT = t; bestTri = -1; planeHit = true; }
    }

    if (bestTri < 0 && !planeHit) return null;

    hit.distance = bestT;
    hit.point.set(origin.x + dx * bestT, origin.y + dy * bestT, origin.z + dz * bestT);
    if (planeHit) {
      hit.normal.set(0, 1, 0); hit.tri = -1; hit.body = 0; hit.plane = true;
    } else {
      hit.normal.set(this.nrm[bestTri * 3], this.nrm[bestTri * 3 + 1], this.nrm[bestTri * 3 + 2]);
      if (hit.normal.x * dx + hit.normal.y * dy + hit.normal.z * dz > 0) hit.normal.multiplyScalar(-1);
      hit.tri = bestTri; hit.body = this.body[bestTri]; hit.plane = false;
    }
    return hit;
  }

  /**
   * Ground under (x, z). Cast from above the world bounds.
   * Always answers: with no geometry registered it reports the flat
   * fallback plane, so every consumer works before world.js exists.
   */
  groundAt(x, z, out = null, fromY = null, maxDist = null) {
    const res = out || (this._groundRes ||= { y: 0, normal: new THREE.Vector3(0, 1, 0), hit: false, plane: true, distance: 0, body: 0 });
    const top = fromY != null
      ? fromY
      : (Number.isFinite(this.bounds.max.y) ? this.bounds.max.y + 2 : this.planeY + 2);
    this._gOrigin ||= new THREE.Vector3();
    this._gDir ||= new THREE.Vector3(0, -1, 0);
    this._gOrigin.set(x, top, z);
    const md = maxDist != null ? maxDist : (Number.isFinite(this.bounds.min.y) ? (top - this.bounds.min.y) + 4 : 1e4);
    const h = this.raycast(this._gOrigin, this._gDir, md);
    if (h) {
      res.y = h.point.y; res.normal.copy(h.normal); res.hit = true;
      res.plane = h.plane; res.distance = top - h.point.y; res.body = h.body;
    } else {
      res.y = this.planeActive ? this.planeY : (Number.isFinite(this.bounds.min.y) ? this.bounds.min.y : 0);
      res.normal.set(0, 1, 0); res.hit = this.planeActive; res.plane = true; res.distance = top - res.y; res.body = 0;
    }
    return res;
  }
}

export function createCollisionWorld(opts) { return new CollisionWorld(opts); }
export default CollisionWorld;
