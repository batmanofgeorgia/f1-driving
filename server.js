const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// World and Track constants (world size is mutable in v7: standard 1600x900, large 2400x1350)
let WORLD_W = 1600;
let WORLD_H = 900;
const MAP_SIZES = { standard: { w: 1600, h: 900 }, large: { w: 2400, h: 1350 } };
const TRACK_N = 360;
const ROAD_HALF = 58;
const MIN_TRACK_LENGTH = 700;
const MIN_SELF_DIST = 96;
const CHECKPOINTS = [45, 90, 135, 180, 225, 270, 315];
const TOTAL_LAPS = 3;

// Physics constants
const TICK_HZ = 60;
const BROADCAST_HZ = 60;
const DT = 1 / TICK_HZ;
const MAX_SPEED = 376;
const OFF_SPEED = 260;
const ACCEL = 380;
const TURN_RATE = 9; // rad/s
const CAR_COLLISION_DIST = 26;
const COUNTDOWN_DURATION = 3.2;

const PLAYER_COLORS = ['#e11d2e', '#2563eb', '#f5c518', '#22c55e', '#f97316', '#a855f7', '#06b6d4', '#ec4899'];
const SPEED_SCALES = {
  slow: 0.7,
  normal: 1.0,
  fast: 1.3
};
const VALID_MODES = ['time', 'elimination', 'explosion'];
const VALID_SPEEDS = ['slow', 'normal', 'fast'];
const VALID_WEATHERS = ['sunny', 'rain', 'foggy'];
const VALID_BOT_DIFFICULTIES = ['easy', 'medium', 'hard', 'mixed'];
const BOT_DRIVER_NAMES = [
  '[BOT] Verstappen',
  '[BOT] Hamilton',
  '[BOT] Leclerc',
  '[BOT] Norris',
  '[BOT] Alonso',
  '[BOT] Piastri',
  '[BOT] Sainz',
  '[BOT] Russell'
];
const BOT_DIFFICULTY_PROFILES = {
  easy: { speedFactor: 0.78, cornerSpeedFactor: 0.62, lookAhead: 14, wobbleAmp: 12, reactionRate: 4.5 },
  medium: { speedFactor: 0.90, cornerSpeedFactor: 0.76, lookAhead: 11, wobbleAmp: 6, reactionRate: 7.0 },
  hard: { speedFactor: 0.99, cornerSpeedFactor: 0.89, lookAhead: 9, wobbleAmp: 2, reactionRate: 10.0 }
};

// Game state in memory
let nextPlayerId = 1;
let players = []; // Array of connected & joined players (and AI bots)
let botCountTarget = 0; // 0..7 AI bots configured by host
let botDifficulty = 'medium'; // 'easy' | 'medium' | 'hard' | 'mixed'
let gameMode = 'time';
let gameSpeed = 'normal';
let gameWeather = 'sunny';
let mapSize = 'standard';
let qualifyingEnabled = false;
let isQualifyingRace = false;
let qualifyingOrder = null;
let qualPauseUntil = 0;
let gamePhase = 'lobby'; // 'lobby' | 'countdown' | 'race' | 'finish' | 'qualPause'
let trackData = null; // { center, left, right, poly, tangents, length }
let countdownT = 0;
let raceTime = 0;
let currentEliminationLap = 1;
let explosionOrderCounter = 0;
let eliminationOrderCounter = 0;
let lastResults = [];

// Helper: normalize angle to [-PI, PI]
function normalizeAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

// Helper: circular index distance on TRACK_N = 360
function circularIndexDist(a, b) {
  const diff = Math.abs(a - b);
  return Math.min(diff, TRACK_N - diff);
}

// Helper: signed circular index delta from a to b in [-180, 180]
function signedCircularDelta(fromIdx, toIdx) {
  let d = toIdx - fromIdx;
  while (d > TRACK_N / 2) d -= TRACK_N;
  while (d < -TRACK_N / 2) d += TRACK_N;
  return d;
}

// Helper: distance from point P to segment AB
function distPointToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projX = ax + t * dx;
  const projY = ay + t * dy;
  return Math.hypot(px - projX, py - projY);
}

// Helper: proper 2D segment intersection
function segmentsIntersect(a, b, c, d) {
  function ccw(p1, p2, p3) {
    return (p3.y - p1.y) * (p2.x - p1.x) > (p2.y - p1.y) * (p3.x - p1.x);
  }
  const d1 = (d.x - c.x) * (a.y - c.y) - (d.y - c.y) * (a.x - c.x);
  const d2 = (d.x - c.x) * (b.y - c.y) - (d.y - c.y) * (b.x - c.x);
  const d3 = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d4 = (b.x - a.x) * (d.y - a.y) - (b.y - a.y) * (d.x - a.x);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  return ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d) &&
         Math.abs(d1) > 1e-9 && Math.abs(d2) > 1e-9 && Math.abs(d3) > 1e-9 && Math.abs(d4) > 1e-9;
}

// Resample closed loop of points into N uniformly spaced points
function resampleClosedLoop(pts, N) {
  const M = pts.length;
  const cumLen = [0];
  let totalLen = 0;
  for (let i = 0; i < M; i++) {
    const p1 = pts[i];
    const p2 = pts[(i + 1) % M];
    totalLen += Math.hypot(p2.x - p1.x, p2.y - p1.y);
    cumLen.push(totalLen);
  }
  if (totalLen < 1e-3) {
    return { points: [], length: 0 };
  }
  const out = [];
  let segIdx = 0;
  for (let k = 0; k < N; k++) {
    const target = (k * totalLen) / N;
    while (segIdx < M - 1 && cumLen[segIdx + 1] < target) {
      segIdx++;
    }
    const segStart = cumLen[segIdx];
    const segEnd = cumLen[segIdx + 1];
    const segLen = segEnd - segStart;
    const t = segLen > 1e-6 ? (target - segStart) / segLen : 0;
    const p1 = pts[segIdx];
    const p2 = pts[(segIdx + 1) % M];
    out.push({
      x: p1.x + t * (p2.x - p1.x),
      y: p1.y + t * (p2.y - p1.y)
    });
  }
  return { points: out, length: totalLen };
}

// Process, smooth, and validate raw drawn points
function buildAndValidateTrack(rawPoints) {
  const errors = [];
  if (!Array.isArray(rawPoints) || rawPoints.length < 6) {
    return { ok: false, errors: ['Nakreslená trať obsahuje příliš málo bodů.'] };
  }

  // Filter valid points and remove consecutive duplicates
  const cleaned = [];
  for (const pt of rawPoints) {
    if (!pt || typeof pt.x !== 'number' || typeof pt.y !== 'number' || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) {
      continue;
    }
    const x = Math.max(ROAD_HALF + 8, Math.min(WORLD_W - ROAD_HALF - 8, pt.x));
    const y = Math.max(ROAD_HALF + 8, Math.min(WORLD_H - ROAD_HALF - 8, pt.y));
    if (cleaned.length === 0 || Math.hypot(x - cleaned[cleaned.length - 1].x, y - cleaned[cleaned.length - 1].y) >= 2) {
      cleaned.push({ x, y });
    }
  }

  // If last point is very close to first point, drop last point before closing loop
  while (cleaned.length > 3 && Math.hypot(cleaned[cleaned.length - 1].x - cleaned[0].x, cleaned[cleaned.length - 1].y - cleaned[0].y) < 5) {
    cleaned.pop();
  }

  if (cleaned.length < 4) {
    return { ok: false, errors: ['Trať je příliš krátká (minimum je 700 jednotek).'] };
  }

  // Initial resample to TRACK_N
  let resampled = resampleClosedLoop(cleaned, TRACK_N);
  if (resampled.length < 100) {
    return { ok: false, errors: [`Trať je příliš krátká (${Math.round(resampled.length)} jednotek, minimum je ${MIN_TRACK_LENGTH} jednotek).`] };
  }

  // Smooth the closed loop with circular moving average (10 passes), then resample uniformly to TRACK_N
  let pts = resampled.points;
  const smoothPasses = 10;
  for (let pass = 0; pass < smoothPasses; pass++) {
    const next = [];
    for (let i = 0; i < TRACK_N; i++) {
      const pPrev2 = pts[(i - 2 + TRACK_N) % TRACK_N];
      const pPrev1 = pts[(i - 1 + TRACK_N) % TRACK_N];
      const pCur = pts[i];
      const pNext1 = pts[(i + 1) % TRACK_N];
      const pNext2 = pts[(i + 2) % TRACK_N];
      next.push({
        x: Math.max(ROAD_HALF + 6, Math.min(WORLD_W - ROAD_HALF - 6,
          0.1 * pPrev2.x + 0.225 * pPrev1.x + 0.35 * pCur.x + 0.225 * pNext1.x + 0.1 * pNext2.x)),
        y: Math.max(ROAD_HALF + 6, Math.min(WORLD_H - ROAD_HALF - 6,
          0.1 * pPrev2.y + 0.225 * pPrev1.y + 0.35 * pCur.y + 0.225 * pNext1.y + 0.1 * pNext2.y))
      });
    }
    pts = next;
  }

  // Final uniform resample to TRACK_N = 360
  const finalResampled = resampleClosedLoop(pts, TRACK_N);
  const center = finalResampled.points;
  const totalLength = finalResampled.length;

  // Compute cumulative arc length along the 360 points for distance validation
  const arcAt = [0];
  let accLen = 0;
  for (let i = 0; i < TRACK_N; i++) {
    const p1 = center[i];
    const p2 = center[(i + 1) % TRACK_N];
    accLen += Math.hypot(p2.x - p1.x, p2.y - p1.y);
    arcAt.push(accLen);
  }

  // 1. Validate total length >= 700
  if (totalLength < MIN_TRACK_LENGTH) {
    errors.push(`Trať je příliš krátká (${Math.round(totalLength)} jednotek, minimum je ${MIN_TRACK_LENGTH} jednotek).`);
  }

  // 2. Validate self-intersection and minimum self-distance (96 units)
  let crossesSelf = false;
  let tooClose = false;

  const minArcSeparation = Math.max(MIN_SELF_DIST * 1.65, 165);

  for (let i = 0; i < TRACK_N; i++) {
    const a1 = center[i];
    const a2 = center[(i + 1) % TRACK_N];
    for (let j = i + 2; j < TRACK_N; j++) {
      if (i === 0 && j === TRACK_N - 1) continue;

      const b1 = center[j];
      const b2 = center[(j + 1) % TRACK_N];

      if (!crossesSelf && segmentsIntersect(a1, a2, b1, b2)) {
        crossesSelf = true;
      }

      const directArc = Math.abs(arcAt[j] - arcAt[i]);
      const loopArc = Math.min(directArc, totalLength - directArc);
      if (loopArc >= minArcSeparation) {
        const d = Math.min(
          Math.hypot(a1.x - b1.x, a1.y - b1.y),
          distPointToSegment(a1.x, a1.y, b1.x, b1.y, b2.x, b2.y),
          distPointToSegment(b1.x, b1.y, a1.x, a1.y, a2.x, a2.y)
        );
        if (d < MIN_SELF_DIST) {
          tooClose = true;
        }
      }
    }
  }

  if (crossesSelf) {
    errors.push('Trať kříží sama sebe. Nakreslete okruh bez křížení.');
  }
  if (tooClose) {
    errors.push(`Části trati jsou příliš blízko u sebe (překryv silnice, minimum je ${MIN_SELF_DIST} jednotek).`);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // Compute tangents, normals, left and right road edges, and polygon
  const left = [];
  const right = [];
  const tangents = [];
  for (let i = 0; i < TRACK_N; i++) {
    const pPrev = center[(i - 1 + TRACK_N) % TRACK_N];
    const pNext = center[(i + 1) % TRACK_N];
    const dx = pNext.x - pPrev.x;
    const dy = pNext.y - pPrev.y;
    const len = Math.hypot(dx, dy) || 1;
    const tx = dx / len;
    const ty = dy / len;
    const nx = -ty;
    const ny = tx;
    tangents.push({ tx, ty, angle: Math.atan2(ty, tx) });
    left.push({
      x: Math.round((center[i].x + nx * ROAD_HALF) * 10) / 10,
      y: Math.round((center[i].y + ny * ROAD_HALF) * 10) / 10
    });
    right.push({
      x: Math.round((center[i].x - nx * ROAD_HALF) * 10) / 10,
      y: Math.round((center[i].y - ny * ROAD_HALF) * 10) / 10
    });
  }

  const roundedCenter = center.map(p => ({
    x: Math.round(p.x * 10) / 10,
    y: Math.round(p.y * 10) / 10
  }));

  const poly = [...left, ...right.slice().reverse()];

  return {
    ok: true,
    track: {
      center: roundedCenter,
      left,
      right,
      poly,
      tangents,
      length: Math.round(totalLength * 10) / 10
    }
  };
}

// Find nearest track index and distance to road centerline
function findNearestTrackPoint(x, y) {
  if (!trackData || !trackData.center) {
    return { idx: 0, dist: 0 };
  }
  const pts = trackData.center;
  let bestIdx = 0;
  let bestDistSq = Infinity;

  for (let i = 0; i < TRACK_N; i++) {
    const dx = x - pts[i].x;
    const dy = y - pts[i].y;
    const dSq = dx * dx + dy * dy;
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      bestIdx = i;
    }
  }

  const prevIdx = (bestIdx - 1 + TRACK_N) % TRACK_N;
  const nextIdx = (bestIdx + 1) % TRACK_N;
  const dPrev = distPointToSegment(x, y, pts[prevIdx].x, pts[prevIdx].y, pts[bestIdx].x, pts[bestIdx].y);
  const dNext = distPointToSegment(x, y, pts[bestIdx].x, pts[bestIdx].y, pts[nextIdx].x, pts[nextIdx].y);
  const exactDist = Math.min(Math.sqrt(bestDistSq), dPrev, dNext);

  return { idx: bestIdx, dist: exactDist };
}

// Check if a car has reached or crossed the start/finish line plane at index 0
function hasCrossedStartLinePlane(x, y) {
  if (!trackData || !trackData.center || !trackData.tangents) return true;
  const c0 = trackData.center[0];
  const t0 = trackData.tangents[0];
  const along = (x - c0.x) * t0.tx + (y - c0.y) * t0.ty;
  // Require the car center to be at or past the start/finish line (along >= 0)
  return along >= 0;
}

// Snap a car cleanly onto the finish line at index 0 preserving its lateral offset on the road
function snapCarToFinishLine(car) {
  if (!trackData || !trackData.center || !trackData.tangents) return;
  const c0 = trackData.center[0];
  const t0 = trackData.tangents[0];
  const nx = -t0.ty;
  const ny = t0.tx;
  const lat = Math.max(-(ROAD_HALF - 10), Math.min(ROAD_HALF - 10, (car.x - c0.x) * nx + (car.y - c0.y) * ny));
  // Place car right on the finish line (+4 units past center of the line so the nose/body sits visibly on/past the line)
  car.x = c0.x + nx * lat + t0.tx * 4;
  car.y = c0.y + ny * lat + t0.ty * 4;
}

// Synchronize AI bots in `players` array so that humans + bots <= 8
function getBotProfileForIndex(botSlotIdx) {
  if (botDifficulty === 'mixed') {
    const tiers = ['hard', 'medium', 'easy', 'hard', 'medium', 'easy', 'medium'];
    const tier = tiers[botSlotIdx % tiers.length];
    return { ...BOT_DIFFICULTY_PROFILES[tier], tier };
  }
  const tier = BOT_DIFFICULTY_PROFILES[botDifficulty] ? botDifficulty : 'medium';
  return { ...BOT_DIFFICULTY_PROFILES[tier], tier };
}

function syncBots() {
  const humans = players.filter(p => !p.isBot);
  if (humans.length === 0) {
    players = [];
    return;
  }
  const maxBots = Math.max(0, 8 - humans.length);
  const actualBotCount = Math.max(0, Math.min(botCountTarget, maxBots));
  const existingBots = players.filter(p => p.isBot);

  const usedColors = new Set(humans.map(h => h.color));
  const usedNames = new Set(humans.map(h => h.name));

  const newBots = [];
  for (let i = 0; i < actualBotCount; i++) {
    let bot = existingBots[i];
    if (!bot) {
      const color = PLAYER_COLORS.find(c => !usedColors.has(c)) || PLAYER_COLORS[(humans.length + i) % 8];
      usedColors.add(color);
      const name = BOT_DRIVER_NAMES.find(n => !usedNames.has(n)) || `[BOT] Pilot ${i + 1}`;
      usedNames.add(name);
      bot = {
        id: nextPlayerId++,
        name,
        color,
        isHost: false,
        isBot: true,
        botSlotIdx: i,
        botProfile: getBotProfileForIndex(i),
        botLaneOffset: (i % 2 === 0 ? -1 : 1) * (6 + (i % 3) * 4),
        ws: null,
        car: null,
        inputHeading: 0,
        inputGas: false
      };
    } else {
      bot.botSlotIdx = i;
      bot.botProfile = getBotProfileForIndex(i);
      if (usedColors.has(bot.color)) {
        bot.color = PLAYER_COLORS.find(c => !usedColors.has(c)) || PLAYER_COLORS[(humans.length + i) % 8];
      }
      usedColors.add(bot.color);
      usedNames.add(bot.name);
    }
    newBots.push(bot);
  }

  players = humans.concat(newBots);
}

// Broadcast JSON message to all joined human players
function broadcast(msgObj) {
  const data = JSON.stringify(msgObj);
  for (const p of players) {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(data);
    }
  }
}

// Send JSON message to a single ws client
function sendTo(ws, msgObj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msgObj));
  }
}

// Broadcast lobby state
function broadcastLobby() {
  if (gamePhase === 'lobby') {
    syncBots();
  }
  const lobbyPlayers = players.map(p => ({
    id: p.id,
    name: p.name,
    color: p.color,
    isHost: p.isHost,
    isBot: Boolean(p.isBot)
  }));
  broadcast({
    type: 'lobby',
    players: lobbyPlayers,
    botCount: botCountTarget,
    botDifficulty: botDifficulty,
    mode: gameMode,
    speed: gameSpeed,
    weather: gameWeather,
    mapSize: mapSize,
    qualifying: qualifyingEnabled,
    worldW: WORLD_W,
    worldH: WORLD_H,
    hasTrack: Boolean(trackData),
    phase: gamePhase
  });
}

// Get lateral offsets for player count (2, 3, or 4 players)
function getLateralOffsets(count) {
  if (count === 2) return [-16, 16];
  if (count === 3) return [-30, 0, 30];
  if (count >= 4) return [-42, -14, 14, 42];
  return [0];
}

// Initialize cars on the start line.
// 1-4 hraci: jedna rada na startu, presne jako drive.
// 5-8 hracu: dve rady, prvni 4 na startu, zbytek o 16 bodu trati za startem.
// 16 bodu je asi 75 jednotek, tedy vic nez kolizni vzdalenost 26, a pritom mala nevyhoda.
// Druha rada ma stejny smer trati v bode 344, kola se pocitaji az po checkpointoch, takze
// start za carou kolo nezkresli.
function setupRaceStart(gridOrder) {
  if (!trackData) return;
  const rowBehindIdx = (TRACK_N - 16 + TRACK_N) % TRACK_N;
  const rowA = getLateralOffsets(4);
  const rowB = getLateralOffsets(Math.max(1, players.length - 4));
  // v7 kvalifikacni rost: 2 auta v rade, kazda dalsi rada o tolik bodu trati zpet,
  // aby byla vzdalenost alespon 60 jednotek (a alespon 8 bodu). Poradi = kvalifikace.
  let orderedPlayers = players;
  if (Array.isArray(gridOrder) && gridOrder.length > 0) {
    const byId = new Map(players.map(p => [p.id, p]));
    orderedPlayers = gridOrder.map(id => byId.get(id)).filter(Boolean);
    players.forEach(p => { if (!orderedPlayers.includes(p)) orderedPlayers.push(p); });
  }
  countdownT = COUNTDOWN_DURATION;
  raceTime = 0;
  currentEliminationLap = 1;
  explosionOrderCounter = 0;
  eliminationOrderCounter = 0;
  lastResults = [];

  orderedPlayers.forEach((p, idx) => {
    let startIdx, lat;
    if (Array.isArray(gridOrder) && gridOrder.length > 0) {
      const row = Math.floor(idx / 2);
      const col = idx % 2;
      const perIdx = trackData.length / TRACK_N || 1;
      const rowSpacing = Math.max(8, Math.ceil(60 / perIdx));
      startIdx = (TRACK_N - row * rowSpacing + TRACK_N) % TRACK_N;
      lat = col === 0 ? -20 : 20;
    } else if (players.length <= 4) {
      startIdx = 0;
      lat = getLateralOffsets(players.length)[idx] !== undefined ? getLateralOffsets(players.length)[idx] : 0;
    } else if (idx < 4) {
      startIdx = 0;
      lat = rowA[idx];
    } else {
      startIdx = rowBehindIdx;
      lat = rowB[idx - 4] !== undefined ? rowB[idx - 4] : 0;
    }
    const startPt = trackData.center[startIdx];
    const tang = trackData.tangents[startIdx];
    const startHeading = tang.angle;
    const nx = -tang.ty;
    const ny = tang.tx;
    const x = startPt.x + nx * lat;
    const y = startPt.y + ny * lat;
    p.car = {
      id: p.id,
      name: p.name,
      color: p.color,
      x,
      y,
      vx: 0,
      vy: 0,
      heading: startHeading,
      targetHeading: startHeading,
      gas: false,
      lap: 1,
      lapTime: 0,
      elapsed: 0,
      lapTimes: [],
      finished: false,
      eliminated: false,
      exploded: false,
      explosionOrder: 0,
      eliminationOrder: 0,
      off: false,
      offSecondsLap: 0,
      offSecondsTotal: 0,
      maxSpeedKmh: 0,
      speedKmh: 0,
      nextCheckpointIdx: 0,
      trackIdx: startIdx,
      lapDistance: 0,
      progress: 0,
      rank: idx + 1,
      collisionCooldowns: {}
    };
    p.inputHeading = startHeading;
    p.inputGas = false;
  });
}

// Determine if car is active on the track
function isCarActive(car) {
  return car && !car.finished && !car.eliminated && !car.exploded;
}

// Update rankings across all cars
function updateCarRankings() {
  const cars = players.map(p => p.car).filter(Boolean);
  cars.forEach(c => {
    if (c.finished) {
      c.progress = TOTAL_LAPS * TRACK_N;
    } else {
      c.progress = (c.lap - 1) * TRACK_N + c.lapDistance;
    }
  });

  const sorted = cars.slice().sort((a, b) => {
    if (a.finished && b.finished) return a.elapsed - b.elapsed;
    if (a.finished !== b.finished) return a.finished ? -1 : 1;

    const aActive = isCarActive(a);
    const bActive = isCarActive(b);
    if (aActive !== bActive) return aActive ? -1 : 1;

    if (!aActive && !bActive) {
      if (a.exploded && b.exploded) return b.explosionOrder - a.explosionOrder;
      if (a.eliminated && b.eliminated) return b.eliminationOrder - a.eliminationOrder;
      return b.progress - a.progress;
    }

    if (Math.abs(b.progress - a.progress) > 0.01) {
      return b.progress - a.progress;
    }
    return a.id - b.id;
  });

  sorted.forEach((c, idx) => {
    c.rank = idx + 1;
  });
}

// Finish the race and broadcast results
function finishRace() {
  if (gamePhase === 'finish') return;
  gamePhase = 'finish';
  updateCarRankings();

  const cars = players.map(p => p.car).filter(Boolean);
  const sorted = cars.slice().sort((a, b) => a.rank - b.rank);

  const winnerTime = sorted.find(c => c.finished) ? sorted.find(c => c.finished).elapsed : null;
  lastResults = sorted.map((c, idx) => {
    let status = 'finished';
    if (c.exploded) status = 'exploded';
    else if (c.eliminated) status = 'eliminated';
    else if (!c.finished) status = 'finished';
    const lapTimesR = c.lapTimes.map(t => Math.round(t * 100) / 100);
    return {
      position: idx + 1,
      id: c.id,
      name: c.name,
      color: c.color,
      status,
      totalTime: c.finished ? Math.round(c.elapsed * 100) / 100 : (c.elapsed ? Math.round(c.elapsed * 100) / 100 : Math.round(raceTime * 100) / 100),
      lapTimes: lapTimesR,
      bestLap: lapTimesR.length > 0 ? Math.min.apply(null, lapTimesR) : null,
      maxSpeedKmh: c.maxSpeedKmh || 0,
      offSecondsTotal: Math.round((c.offSecondsTotal || 0) * 100) / 100,
      gapToWinner: (c.finished && winnerTime !== null) ? Math.round((c.elapsed - winnerTime) * 100) / 100 : null
    };
  });
  // Po hlavnim zavode se kvalifikace pro pristi zavod resetuje, aby se jela znovu.
  isQualifyingRace = false;
  qualifyingOrder = null;

  broadcastState();
  broadcast({
    type: 'finish',
    mode: gameMode,
    results: lastResults
  });
  broadcastLobby();
}

// v7: ukonceni kvalifikace (1 kolo, bez vyrazovani a vybuchu).
// Poradi: nejdrive dojeti podle casu, pak nedojeti podle postupu na trati.
function finishQualifying() {
  if (gamePhase !== 'race' || !isQualifyingRace) return;
  const cars = players.map(p => p.car).filter(Boolean);
  const finished = cars.filter(c => c.finished).sort((a, b) => a.elapsed - b.elapsed);
  const unfinished = cars.filter(c => !c.finished).sort((a, b) => b.progress - a.progress);
  const ordered = finished.concat(unfinished);
  qualifyingOrder = ordered.map(c => c.id);
  const qualResults = ordered.map((c, idx) => ({
    position: idx + 1,
    id: c.id,
    name: c.name,
    color: c.color,
    status: c.finished ? 'finished' : 'unfinished',
    totalTime: c.finished ? Math.round(c.elapsed * 100) / 100 : null,
    progress: Math.round(c.progress * 10) / 10,
    lapTimes: c.lapTimes.map(t => Math.round(t * 100) / 100)
  }));
  gamePhase = 'qualPause';
  broadcast({
    type: 'qualFinish',
    results: qualResults
  });
  broadcastLobby();
  // Po 6 s automaticky hlavni zavod s rost podle kvalifikace.
  setTimeout(() => {
    if (gamePhase !== 'qualPause') return;
    if (!trackData || players.length < 1) { gamePhase = 'lobby'; broadcastLobby(); return; }
    isQualifyingRace = false;
    gamePhase = 'countdown';
    setupRaceStart(qualifyingOrder);
    broadcastLobby();
    broadcastState();
  }, 6000);
}

// Check if race end conditions are met
function checkRaceEndConditions() {
  if (gamePhase !== 'race') return;
  const cars = players.map(p => p.car).filter(Boolean);
  if (cars.length === 0) {
    if (isQualifyingRace) finishQualifying(); else finishRace();
    return;
  }
  if (isQualifyingRace) {
    const activeCars = cars.filter(isCarActive);
    if (activeCars.length === 0) finishQualifying();
    return;
  }

  const activeCars = cars.filter(isCarActive);

  if (gameMode === 'time') {
    if (activeCars.length === 0) {
      finishRace();
    }
  } else if (gameMode === 'elimination') {
    if (activeCars.length === 0 || (activeCars.length === 1 && cars.filter(c => c.finished).length === 0)) {
      if (activeCars.length === 1) {
        const winner = activeCars[0];
        winner.finished = true;
        winner.elapsed = raceTime;
      }
      finishRace();
    }
  } else if (gameMode === 'explosion') {
    const finishedCount = cars.filter(c => c.finished).length;
    if (activeCars.length === 0 || (activeCars.length === 1 && finishedCount === 0)) {
      if (activeCars.length === 1 && finishedCount === 0) {
        const survivor = activeCars[0];
        survivor.finished = true;
        survivor.elapsed = raceTime;
      }
      finishRace();
    }
  }
}

// Compute steering and throttle for AI bot cars (60 Hz)
function updateBotAI(botPlayer, maxRoadSpeed) {
  const c = botPlayer.car;
  if (!c || !isCarActive(c) || !trackData || !trackData.center || !trackData.tangents) return;

  const profile = botPlayer.botProfile || BOT_DIFFICULTY_PROFILES.medium;
  const center = trackData.center;
  const tangents = trackData.tangents;
  const curIdx = c.trackIdx || 0;

  // 1. Evaluate upcoming curvature across short, mid, and far lookahead windows
  const idxNear = (curIdx + 7) % TRACK_N;
  const idxMid = (curIdx + 15) % TRACK_N;
  const idxFar = (curIdx + 25) % TRACK_N;

  const angCur = tangents[curIdx].angle;
  const angNear = tangents[idxNear].angle;
  const angMid = tangents[idxMid].angle;
  const angFar = tangents[idxFar].angle;

  const curveNear = Math.abs(normalizeAngle(angNear - angCur));
  const curveMid = Math.abs(normalizeAngle(angMid - angNear));
  const curveFar = Math.abs(normalizeAngle(angFar - angMid));
  const maxCurve = Math.max(curveNear, curveMid * 0.9, curveFar * 0.7);

  // 2. Overtaking & lateral collision avoidance against active cars ahead
  let targetLateral = botPlayer.botLaneOffset || 0;
  // Add gentle organic weaving on easy/medium
  if (profile.wobbleAmp > 0) {
    targetLateral += Math.sin(raceTime * 1.7 + botPlayer.id * 2.3) * profile.wobbleAmp;
  }

  let speedBlocked = false;
  for (const otherP of players) {
    if (otherP.id === botPlayer.id || !otherP.car || !isCarActive(otherP.car)) continue;
    const oc = otherP.car;
    const dx = oc.x - c.x;
    const dy = oc.y - c.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 130 && dist > 1) {
      const tang = tangents[curIdx];
      const forwardProj = dx * tang.tx + dy * tang.ty;
      const latProj = dx * (-tang.ty) + dy * tang.tx;
      // Car is ahead of us within ~115 units
      if (forwardProj > -8 && forwardProj < 115 && Math.abs(latProj) < 34) {
        // Steer to the side with more room on the road
        const evadeDir = latProj >= 0 ? -1 : 1;
        targetLateral += evadeDir * 26;
        if (forwardProj < 48 && Math.abs(latProj) < 22) {
          speedBlocked = true;
        }
      }
    }
  }

  // Clamp lateral offset safely inside road bounds
  const safeRoadHalf = ROAD_HALF - 16;
  targetLateral = Math.max(-safeRoadHalf, Math.min(safeRoadHalf, targetLateral));

  // If bot is off-track, aim tighter to centerline to recover quickly
  if (c.off) {
    targetLateral *= 0.25;
  }

  // 3. Compute lookahead target point along track
  const curSpd = Math.hypot(c.vx, c.vy);
  const speedRatio = Math.min(1, curSpd / Math.max(1, maxRoadSpeed));
  const lookAheadSteps = Math.round(profile.lookAhead + speedRatio * 6);
  const targetIdx = (curIdx + lookAheadSteps) % TRACK_N;
  const targetPt = center[targetIdx];
  const targetTang = tangents[targetIdx];
  const nx = -targetTang.ty;
  const ny = targetTang.tx;

  const aimX = targetPt.x + nx * targetLateral;
  const aimY = targetPt.y + ny * targetLateral;
  const desiredHeading = Math.atan2(aimY - c.y, aimX - c.x);

  // Smoothly update bot's inputHeading according to reactionRate
  const prevInput = typeof botPlayer.inputHeading === 'number' ? botPlayer.inputHeading : c.heading;
  const diffH = normalizeAngle(desiredHeading - prevInput);
  const maxStep = profile.reactionRate * DT;
  if (Math.abs(diffH) <= maxStep) {
    botPlayer.inputHeading = desiredHeading;
  } else {
    botPlayer.inputHeading = normalizeAngle(prevInput + Math.sign(diffH) * maxStep);
  }

  // 4. Throttle / Corner speed control
  let desiredSpeed = maxRoadSpeed * profile.speedFactor;
  if (maxCurve > 0.22) {
    // Sharpness factor between 0 and 1
    const severity = Math.min(1, (maxCurve - 0.22) / 0.95);
    const cornerMult = 1 - severity * (1 - profile.cornerSpeedFactor);
    desiredSpeed *= cornerMult;
  }
  if (gameWeather === 'rain' && maxCurve > 0.25) {
    desiredSpeed *= 0.88; // Extra caution in wet corners
  }
  if (speedBlocked) {
    desiredSpeed *= 0.72;
  }

  const headingErr = Math.abs(normalizeAngle(desiredHeading - c.heading));
  if (headingErr > 0.85 && curSpd > maxRoadSpeed * 0.45) {
    botPlayer.inputGas = false;
  } else {
    botPlayer.inputGas = curSpd < desiredSpeed;
  }
}

// Step physics at 60 Hz
function stepPhysics() {
  if (gamePhase === 'qualPause') return;
  if (gamePhase === 'countdown') {
    countdownT -= DT;
    for (const p of players) {
      if (p.car && typeof p.inputHeading === 'number' && Number.isFinite(p.inputHeading)) {
        p.car.targetHeading = p.inputHeading;
      }
    }
    if (countdownT <= 0) {
      countdownT = 0;
      gamePhase = 'race';
    }
    return;
  }

  if (gamePhase !== 'race') return;

  raceTime += DT;
  // Kvalifikace ma limit 75 s, aby pomaly hrac nezdrzoval ostatni. Po limitu se rost urci podle postupu.
  if (isQualifyingRace && raceTime > 75) {
    finishQualifying();
    return;
  }
  // Pojistka hlavniho zavodu: pokud vsichni lidsti hraci uz dojeli/vypadli a zbyli jen boti po dobu > 120 s, ukonci zavod
  const activeHumans = players.filter(p => !p.isBot && p.car && isCarActive(p.car));
  if (!isQualifyingRace && activeHumans.length === 0 && raceTime > 120) {
    finishRace();
    return;
  }
  const speedScale = SPEED_SCALES[gameSpeed] || 1.0;
  // Pocasi s hernim vlivem: dest snizuje grip na 0,6x (vetsi smyk) a maximalni rychlost na 0,9x.
  // Slunce a mlha fyziku nemeni, mlha meni jen viditelnost na strane klienta.
  const weatherGripScale = gameWeather === 'rain' ? 0.6 : 1.0;
  const weatherSpeedScale = gameWeather === 'rain' ? 0.9 : 1.0;
  const maxRoadSpeed = MAX_SPEED * speedScale * weatherSpeedScale;
  const maxOffSpeed = OFF_SPEED * speedScale * weatherSpeedScale;
  const accelVal = ACCEL * speedScale;

  for (const p of players) {
    if (p.isBot) {
      updateBotAI(p, maxRoadSpeed);
    }
    const c = p.car;
    if (!c) continue;

    for (const peerId of Object.keys(c.collisionCooldowns)) {
      c.collisionCooldowns[peerId] -= DT;
      if (c.collisionCooldowns[peerId] <= 0) {
        delete c.collisionCooldowns[peerId];
      }
    }

    if (!isCarActive(c)) {
      c.speedKmh = 0;
      continue;
    }

    c.lapTime += DT;
    c.elapsed = raceTime;

    if (typeof p.inputHeading === 'number' && Number.isFinite(p.inputHeading)) {
      c.targetHeading = p.inputHeading;
    }
    c.gas = Boolean(p.inputGas);

    // 1. Turn heading toward targetHeading at max 9 rad/s
    const angleDiff = normalizeAngle(c.targetHeading - c.heading);
    const maxTurn = TURN_RATE * DT;
    if (Math.abs(angleDiff) <= maxTurn) {
      c.heading = normalizeAngle(c.targetHeading);
    } else {
      c.heading = normalizeAngle(c.heading + Math.sign(angleDiff) * maxTurn);
    }

    const fx = Math.cos(c.heading);
    const fy = Math.sin(c.heading);
    const rx = -fy;
    const ry = fx;

    let vForward = c.vx * fx + c.vy * fy;
    let vLat = c.vx * rx + c.vy * ry;

    // 2. Acceleration from gas
    if (c.gas) {
      vForward += accelVal * DT;
    }

    // 3. Drag: exp(-0.35 * dt) per frame, plus extra exp(-0.35 * dt) off road
    const dragFactor = Math.exp(-0.35 * DT);
    vForward *= dragFactor;
    vLat *= dragFactor;
    if (c.off) {
      vForward *= dragFactor;
      vLat *= dragFactor;
    }

    const currentMaxSpeed = c.off ? maxOffSpeed : maxRoadSpeed;
    vForward = Math.max(0, Math.min(currentMaxSpeed, vForward));

    // 4. Grip, v desti 0,6x = vetsi smyk
    const grip = (c.off
      ? 7.0
      : 6.5 - 4.1 * Math.min(1, Math.abs(vForward) / (MAX_SPEED * speedScale))) * weatherGripScale;

    const latDamp = Math.exp(-grip * DT);
    vLat *= latDamp;

    c.vx = fx * vForward + rx * vLat;
    c.vy = fy * vForward + ry * vLat;
    const totalSpd = Math.hypot(c.vx, c.vy);
    if (totalSpd > currentMaxSpeed) {
      const scale = currentMaxSpeed / totalSpd;
      c.vx *= scale;
      c.vy *= scale;
    }

    c.x += c.vx * DT;
    c.y += c.vy * DT;
    if (c.x < 18) { c.x = 18; c.vx = Math.max(0, c.vx); }
    if (c.x > WORLD_W - 18) { c.x = WORLD_W - 18; c.vx = Math.min(0, c.vx); }
    if (c.y < 18) { c.y = 18; c.vy = Math.max(0, c.vy); }
    if (c.y > WORLD_H - 18) { c.y = WORLD_H - 18; c.vy = Math.min(0, c.vy); }

    c.speedKmh = Math.round(Math.hypot(c.vx, c.vy) * 0.4);
    if (c.speedKmh > (c.maxSpeedKmh || 0)) c.maxSpeedKmh = c.speedKmh;

    const prevIdx = c.trackIdx;
    const nearest = findNearestTrackPoint(c.x, c.y);
    c.trackIdx = nearest.idx;
    c.off = nearest.dist > ROAD_HALF;

    if (c.off) {
      c.offSecondsLap += DT;
      c.offSecondsTotal = (c.offSecondsTotal || 0) + DT;
    }

    const stepDelta = signedCircularDelta(prevIdx, c.trackIdx);
    if (Math.abs(stepDelta) < 60) {
      const maxAllowedDist = (c.nextCheckpointIdx + 1) * 45;
      c.lapDistance = Math.max(0, Math.min(TRACK_N, Math.min(maxAllowedDist, c.lapDistance + stepDelta)));
    }

    // Checkpoints and lap completion (only when on the road: dist <= ROAD_HALF)
    if (!c.off) {
      if (c.nextCheckpointIdx < CHECKPOINTS.length) {
        const targetCp = CHECKPOINTS[c.nextCheckpointIdx];
        if (circularIndexDist(c.trackIdx, targetCp) <= 15) {
          c.nextCheckpointIdx++;
        }
      } else {
        // All 7 checkpoints passed in order; check start/finish line (track index 0)
        // Ensure the car actually crosses the finish line plane at index 0 (not 15 indices early)
        if (circularIndexDist(c.trackIdx, 0) <= 15 && hasCrossedStartLinePlane(c.x, c.y)) {
          c.lapTimes.push(c.lapTime);
          c.lapTime = 0;
          c.offSecondsLap = 0;
          c.nextCheckpointIdx = 0;
          c.lapDistance = 0;

          const completedLapNumber = c.lap;

          if (c.lap >= (isQualifyingRace ? 1 : TOTAL_LAPS)) {
            snapCarToFinishLine(c);
            c.finished = true;
            c.elapsed = raceTime;
            c.vx = 0;
            c.vy = 0;
            c.speedKmh = 0;
          } else {
            c.lap++;
          }

          // Mode 2: Vyřazování (Elimination) - v kvalifikaci se nevyrazuje.
          if (!isQualifyingRace && gameMode === 'elimination' && completedLapNumber === currentEliminationLap) {
            currentEliminationLap++;
            updateCarRankings();
            const activeList = players
              .map(pl => pl.car)
              .filter(car => isCarActive(car))
              .sort((a, b) => b.rank - a.rank);
            if (activeList.length > 0) {
              // Obecne pravidlo pro 1-8 hracu.
              // V poslednim kole vedouci dojel, takze vypadnou vsichni zbyli soupere.
              // Jinak se potrebne vyrazeni rozdeli rovnomerne na zbyvajici kola vcetne tohoto:
              // 4 hraci: 1,1,1; 6 hracu: 2,2,1; 8 hracu: 3,2,2 (posledni cislo je finalni kolo).
              let victimsCount;
              if (completedLapNumber >= TOTAL_LAPS) {
                victimsCount = activeList.length;
              } else {
                const opportunitiesLeft = Math.max(1, TOTAL_LAPS - completedLapNumber + 1);
                victimsCount = Math.min(activeList.length - 1, Math.ceil((activeList.length - 1) / opportunitiesLeft));
              }
              for (let vi = 0; vi < victimsCount; vi++) {
                const victim = activeList[vi];
                if (!victim) break;
                victim.eliminated = true;
                eliminationOrderCounter++;
                victim.eliminationOrder = eliminationOrderCounter;
                victim.vx = 0;
                victim.vy = 0;
                victim.speedKmh = 0;
              }
            }
          }
        }
      }
    }
  }

  // Handle circle-circle collisions between active cars (distance = 26 units)
  const activeCars = players.map(p => p.car).filter(isCarActive);
  for (let i = 0; i < activeCars.length; i++) {
    for (let j = i + 1; j < activeCars.length; j++) {
      const a = activeCars[i];
      const b = activeCars[j];
      if (!isCarActive(a) || !isCarActive(b)) continue;

      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy);

      if (dist < CAR_COLLISION_DIST) {
        const nx = dist > 1e-5 ? dx / dist : 1;
        const ny = dist > 1e-5 ? dy / dist : 0;
        const overlap = CAR_COLLISION_DIST - dist;

        let explodedCar = null;
        let survivorCar = null;

        if (!isQualifyingRace && gameMode === 'explosion') {
          const onCooldown = (a.collisionCooldowns[b.id] > 0) || (b.collisionCooldowns[a.id] > 0);
          if (!onCooldown) {
            a.collisionCooldowns[b.id] = 1.5;
            b.collisionCooldowns[a.id] = 1.5;
            const diff = Math.abs(a.offSecondsLap - b.offSecondsLap);
            if (diff > 0.05) {
              if (a.offSecondsLap > b.offSecondsLap) {
                explodedCar = a;
                survivorCar = b;
              } else {
                explodedCar = b;
                survivorCar = a;
              }
            }
          }
        }

        if (explodedCar && survivorCar) {
          explodedCar.exploded = true;
          explosionOrderCounter++;
          explodedCar.explosionOrder = explosionOrderCounter;
          explodedCar.vx = 0;
          explodedCar.vy = 0;
          explodedCar.speedKmh = 0;

          const dirSign = survivorCar === b ? 1 : -1;
          survivorCar.x += dirSign * nx * overlap;
          survivorCar.y += dirSign * ny * overlap;

          const vNorm = survivorCar.vx * nx + survivorCar.vy * ny;
          survivorCar.vx -= 0.5 * vNorm * nx;
          survivorCar.vy -= 0.5 * vNorm * ny;
        } else {
          a.x -= nx * (overlap * 0.5);
          a.y -= ny * (overlap * 0.5);
          b.x += nx * (overlap * 0.5);
          b.y += ny * (overlap * 0.5);

          const relVx = b.vx - a.vx;
          const relVy = b.vy - a.vy;
          const relNormal = relVx * nx + relVy * ny;
          if (relNormal < 0) {
            const impulse = 0.5 * relNormal;
            a.vx += impulse * nx;
            a.vy += impulse * ny;
            b.vx -= impulse * nx;
            b.vy -= impulse * ny;
          } else {
            const vaN = a.vx * nx + a.vy * ny;
            const vbN = b.vx * nx + b.vy * ny;
            a.vx -= 0.5 * vaN * nx;
            a.vy -= 0.5 * vaN * ny;
            b.vx -= 0.5 * vbN * nx;
            b.vy -= 0.5 * vbN * ny;
          }
        }
      }
    }
  }

  updateCarRankings();
  checkRaceEndConditions();
}

// Broadcast authoritative state at 30 Hz
function broadcastState() {
  if (gamePhase !== 'countdown' && gamePhase !== 'race' && gamePhase !== 'finish') return;

  const carsPayload = players
    .map(p => p.car)
    .filter(Boolean)
    .map(c => ({
      id: c.id,
      name: c.name,
      color: c.color,
      x: Math.round(c.x * 100) / 100,
      y: Math.round(c.y * 100) / 100,
      heading: Math.round(c.heading * 10000) / 10000,
      lap: c.lap,
      lapTime: Math.round(c.lapTime * 100) / 100,
      elapsed: Math.round(c.elapsed * 100) / 100,
      finished: c.finished,
      eliminated: c.eliminated,
      exploded: c.exploded,
      off: c.off,
      offSecondsLap: Math.round(c.offSecondsLap * 100) / 100,
      speedKmh: c.speedKmh,
      maxSpeedKmh: c.maxSpeedKmh || 0,
      offSecondsTotal: Math.round((c.offSecondsTotal || 0) * 100) / 100,
      bestLap: c.lapTimes.length > 0 ? Math.round(Math.min.apply(null, c.lapTimes) * 100) / 100 : null,
      progress: Math.round(c.progress * 10) / 10,
      rank: c.rank
    }));

  broadcast({
    type: 'state',
    phase: gamePhase,
    countdownT: Math.max(0, Math.round(countdownT * 100) / 100),
    raceTime: Math.round(raceTime * 100) / 100,
    mode: gameMode,
    speed: gameSpeed,
    weather: gameWeather,
    isQualifying: isQualifyingRace,
    lapsTarget: isQualifyingRace ? 1 : TOTAL_LAPS,
    mapSize: mapSize,
    worldW: WORLD_W,
    worldH: WORLD_H,
    cars: carsPayload
  });
}

// Start fixed physics and broadcast intervals
setInterval(stepPhysics, 1000 / TICK_HZ);
setInterval(() => {
  if (gamePhase === 'countdown' || gamePhase === 'race') {
    broadcastState();
  }
}, 1000 / BROADCAST_HZ);

// HTTP server
// OPRAVA 2026-10-25: server zkusi public/index.html a pak index.html ve stejne
// slozce jako server.js, aby fungoval zip s obema strukturami. Bez toho novy zip
// s plochou strukturou padal na 500 a uzivatel se vracel ke staremu serveru.
// Zaroven posila no-store, aby Chrome neukazoval cachovanou starou verzi hry.
const indexHtmlPaths = [path.join(__dirname, 'public', 'index.html'), path.join(__dirname, 'index.html')];

const server = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];
  if (urlPath === '/' || urlPath === '/index.html') {
    const tryNext = (i) => {
      if (i >= indexHtmlPaths.length) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Chybi index.html (ani public/index.html, ani index.html vedle server.js)');
        return;
      }
      fs.readFile(indexHtmlPaths[i], 'utf8', (err, content) => {
        if (err) { tryNext(i + 1); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate' });
        res.end(content);
      });
    };
    tryNext(0);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Nenalezeno');
  }
});

// WebSocket server
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let joinedPlayer = null;

  ws.on('message', (rawMsg) => {
    let msg;
    try {
      msg = JSON.parse(rawMsg.toString());
    } catch (e) {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    // 1. Handle join
    if (msg.type === 'join') {
      if (joinedPlayer) return;

      if (gamePhase !== 'lobby') {
        sendTo(ws, {
          type: 'error',
          message: 'Závod právě probíhá. Počkejte prosím na další hru.'
        });
        return;
      }

      const humanPlayers = players.filter(p => !p.isBot);
      if (humanPlayers.length >= 8) {
        sendTo(ws, {
          type: 'error',
          message: 'Lobby je plná (maximálně 8 hráčů).'
        });
        return;
      }

      let rawName = typeof msg.name === 'string' ? msg.name.trim() : '';
      if (!rawName) rawName = 'Hráč';
      const cleanName = Array.from(rawName).slice(0, 20).join('');

      const usedColors = new Set(humanPlayers.map(p => p.color));
      const color = PLAYER_COLORS.find(c => !usedColors.has(c)) || PLAYER_COLORS[humanPlayers.length % 8];
      const isHost = humanPlayers.length === 0;

      joinedPlayer = {
        id: nextPlayerId++,
        name: cleanName,
        color,
        isHost,
        isBot: false,
        ws,
        car: null,
        inputHeading: 0,
        inputGas: false
      };

      players.push(joinedPlayer);
      if (humanPlayers.length + 1 + botCountTarget > 8) {
        botCountTarget = Math.max(0, 8 - (humanPlayers.length + 1));
      }
      syncBots();

      sendTo(ws, {
        type: 'welcome',
        id: joinedPlayer.id,
        isHost: joinedPlayer.isHost,
        color: joinedPlayer.color,
        name: joinedPlayer.name
      });

      if (trackData) {
        sendTo(ws, {
          type: 'track',
          center: trackData.center,
          left: trackData.left,
          right: trackData.right,
          poly: trackData.poly,
          length: trackData.length
        });
      }

      broadcastLobby();
      return;
    }

    if (!joinedPlayer) {
      sendTo(ws, {
        type: 'error',
        message: 'Nejprve se musíte připojit do lobby.'
      });
      return;
    }

    // 2. Host-only settings and controls
    if (msg.type === 'bots') {
      if (!joinedPlayer.isHost || gamePhase !== 'lobby') return;
      const humansCount = players.filter(p => !p.isBot).length;
      const maxAllowed = Math.max(0, 8 - humansCount);
      const requested = Number(msg.count);
      if (Number.isFinite(requested)) {
        botCountTarget = Math.max(0, Math.min(maxAllowed, Math.floor(requested)));
        syncBots();
        broadcastLobby();
      }
      return;
    }

    if (msg.type === 'botDifficulty') {
      if (!joinedPlayer.isHost || gamePhase !== 'lobby') return;
      if (VALID_BOT_DIFFICULTIES.includes(msg.difficulty)) {
        botDifficulty = msg.difficulty;
        syncBots();
        broadcastLobby();
      }
      return;
    }

    if (msg.type === 'mode') {
      if (!joinedPlayer.isHost || gamePhase !== 'lobby') return;
      if (VALID_MODES.includes(msg.mode)) {
        gameMode = msg.mode;
        broadcastLobby();
      }
      return;
    }

    if (msg.type === 'speed') {
      if (!joinedPlayer.isHost || gamePhase !== 'lobby') return;
      if (VALID_SPEEDS.includes(msg.speed)) {
        gameSpeed = msg.speed;
        broadcastLobby();
      }
      return;
    }

    if (msg.type === 'mapSize') {
      if (!joinedPlayer.isHost || gamePhase !== 'lobby') return;
      if (msg.mapSize === 'standard' || msg.mapSize === 'large') {
        mapSize = msg.mapSize;
        WORLD_W = MAP_SIZES[mapSize].w;
        WORLD_H = MAP_SIZES[mapSize].h;
        // Zmena velikosti mapy zrusi nakreslenou trat, hostitel ji musi nakreslit znovu pro novy svet.
        trackData = null;
        broadcastLobby();
      }
      return;
    }

    if (msg.type === 'qualifying') {
      if (!joinedPlayer.isHost || gamePhase !== 'lobby') return;
      qualifyingEnabled = Boolean(msg.qualifying);
      broadcastLobby();
      return;
    }

    if (msg.type === 'weather') {
      if (!joinedPlayer.isHost || gamePhase !== 'lobby') return;
      if (VALID_WEATHERS.includes(msg.weather)) {
        gameWeather = msg.weather;
        broadcastLobby();
      }
      return;
    }

    if (msg.type === 'draw') {
      if (!joinedPlayer.isHost || gamePhase !== 'lobby') return;
      const validation = buildAndValidateTrack(msg.raw);
      if (!validation.ok) {
        sendTo(ws, {
          type: 'trackError',
          errors: validation.errors
        });
        return;
      }
      trackData = validation.track;
      broadcast({
        type: 'track',
        center: trackData.center,
        left: trackData.left,
        right: trackData.right,
        poly: trackData.poly,
        length: trackData.length
      });
      broadcastLobby();
      return;
    }

    if (msg.type === 'start') {
      if (!joinedPlayer.isHost || gamePhase !== 'lobby') return;
      syncBots();
      if (players.length < 1) {
        sendTo(ws, {
          type: 'error',
          message: 'Pro odstartování závodu je potřeba alespoň 1 hráč.'
        });
        return;
      }
      // Solo hra bez botu: jen 1 auto smi jet pouze rezim Casovka. S boty (alespon 2 auta) jdou vsechny rezimy.
      if (players.length === 1 && gameMode !== 'time') {
        sendTo(ws, {
          type: 'error',
          message: 'Při 1 vozidle je možná jen Časovka. Přidej AI boty nebo zvol Časovku.'
        });
        return;
      }
      if (!trackData) {
        sendTo(ws, {
          type: 'error',
          message: 'Před startem závodu musí hostitel nakreslit trať.'
        });
        return;
      }
      // Kvalifikace je dobrovolna, pokud jedou alespon 2 vozy (lide + boti).
      isQualifyingRace = Boolean(qualifyingEnabled) && players.length >= 2;
      qualifyingOrder = null;
      gamePhase = 'countdown';
      setupRaceStart(null);
      broadcastLobby();
      broadcastState();
      return;
    }

    if (msg.type === 'toLobby') {
      if (!joinedPlayer.isHost) return;
      gamePhase = 'lobby';
      isQualifyingRace = false;
      qualifyingOrder = null;
      syncBots();
      broadcastLobby();
      return;
    }

    // 3. Player race input
    if (msg.type === 'input') {
      if (typeof msg.heading === 'number' && Number.isFinite(msg.heading)) {
        joinedPlayer.inputHeading = msg.heading;
      }
      joinedPlayer.inputGas = Boolean(msg.gas);
      return;
    }
  });

  ws.on('close', () => {
    if (!joinedPlayer) return;
    const wasHost = joinedPlayer.isHost;
    players = players.filter(p => p.id !== joinedPlayer.id);
    const remainingHumans = players.filter(p => !p.isBot);

    if (remainingHumans.length === 0) {
      players = [];
      gamePhase = 'lobby';
      isQualifyingRace = false;
      qualifyingOrder = null;
      return;
    }

    if (wasHost) {
      players.forEach(p => { p.isHost = false; });
      const newHost = remainingHumans[0];
      newHost.isHost = true;
      sendTo(newHost.ws, {
        type: 'welcome',
        id: newHost.id,
        isHost: true,
        color: newHost.color,
        name: newHost.name
      });
    }

    if (gamePhase === 'race' || gamePhase === 'countdown') {
      updateCarRankings();
      checkRaceEndConditions();
    }

    broadcastLobby();
  });
});

// Print local addresses on startup
function getLocalIPv4Addresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }
  return addresses;
}

server.listen(PORT, HOST, () => {
  console.log('==================================================');
  console.log('F1 Driving v9 server běží! (AI boti, 4 obtížnosti, všechny režimy i pro 1 hráče s boty)');
  console.log('Pokud v lobby nevidíš v9, běží starý server, ne tento.');
  console.log(`Na tomto (hostitelském) telefonu otevřete: http://localhost:${PORT}`);
  const ips = getLocalIPv4Addresses();
  if (ips.length > 0) {
    console.log('Na ostatních telefonech (na stejné Wi-Fi) otevřete:');
    for (const ip of ips) {
      console.log(`  http://${ip}:${PORT}`);
    }
  } else {
    console.log('Nebyla nalezena žádná lokální Wi-Fi IPv4 adresa (zkontrolujte připojení k Wi-Fi).');
  }
  if (!indexHtmlPaths.some(p => fs.existsSync(p))) {
    console.error('UPOZORNĚNÍ: Chybí index.html! Ujistěte se, že index.html je buď v public/, nebo vedle server.js.');
  }
  console.log('==================================================');
});
