import type { Connect, PreviewServer, Plugin, ViteDevServer } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";

type SignalKind = "offer" | "answer";

type StoredSignal = {
  kind: SignalKind;
  serialized: string;
  deviceName: string;
  publishedAt: number;
};

type RoomWaiter = {
  kind: SignalKind;
  resolve: (signal: StoredSignal | null) => void;
  timer: ReturnType<typeof setTimeout>;
};

type Room = {
  createdAt: number;
  offer: StoredSignal | null;
  answer: StoredSignal | null;
  waiters: RoomWaiter[];
};

const ROOM_TTL_MS = 10 * 60 * 1000;
const LONG_POLL_MS = 25_000;
const MAX_BODY_BYTES = 512 * 1024;

function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase();
}

function isSignalKind(value: unknown): value is SignalKind {
  return value === "offer" || value === "answer";
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}

function pruneRoom(rooms: Map<string, Room>, code: string, room: Room) {
  const age = Date.now() - room.createdAt;
  if (age <= ROOM_TTL_MS) return room;
  for (const waiter of room.waiters) {
    clearTimeout(waiter.timer);
    waiter.resolve(null);
  }
  rooms.delete(code);
  return null;
}

function getOrCreateRoom(rooms: Map<string, Room>, code: string): Room {
  const existing = rooms.get(code);
  if (existing) {
    const kept = pruneRoom(rooms, code, existing);
    if (kept) return kept;
  }
  const room: Room = {
    createdAt: Date.now(),
    offer: null,
    answer: null,
    waiters: [],
  };
  rooms.set(code, room);
  return room;
}

function takeSignal(room: Room, kind: SignalKind): StoredSignal | null {
  return kind === "offer" ? room.offer : room.answer;
}

function publishSignal(room: Room, signal: StoredSignal) {
  if (signal.kind === "offer") room.offer = signal;
  else room.answer = signal;

  const pending = room.waiters.filter((waiter) => waiter.kind === signal.kind);
  room.waiters = room.waiters.filter((waiter) => waiter.kind !== signal.kind);
  for (const waiter of pending) {
    clearTimeout(waiter.timer);
    waiter.resolve(signal);
  }
}

function attachLanSignaling(
  middlewares: Connect.Server,
  rooms: Map<string, Room>,
) {
  middlewares.use(async (req, res, next) => {
    try {
      const url = new URL(req.url ?? "/", "http://lan.local");
      if (!url.pathname.startsWith("/api/lan-signal")) {
        next();
        return;
      }

      if (url.pathname === "/api/lan-signal/health") {
        sendJson(res, 200, { ok: true });
        return;
      }

      const match = /^\/api\/lan-signal\/([^/]+)\/?$/.exec(url.pathname);
      if (!match) {
        sendJson(res, 404, { error: "Not found" });
        return;
      }

      const code = normalizeCode(decodeURIComponent(match[1] ?? ""));
      if (!code || code.length > 32) {
        sendJson(res, 400, { error: "Invalid pairing code" });
        return;
      }

      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.end();
        return;
      }

      if (req.method === "DELETE") {
        const room = rooms.get(code);
        if (room) {
          for (const waiter of room.waiters) {
            clearTimeout(waiter.timer);
            waiter.resolve(null);
          }
          rooms.delete(code);
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST") {
        const raw = await readBody(req);
        const payload = JSON.parse(raw || "{}") as Record<string, unknown>;
        if (!isSignalKind(payload.kind)) {
          sendJson(res, 400, { error: "kind must be offer or answer" });
          return;
        }
        if (typeof payload.serialized !== "string" || !payload.serialized.trim()) {
          sendJson(res, 400, { error: "serialized signal is required" });
          return;
        }
        const deviceName =
          typeof payload.deviceName === "string" && payload.deviceName.trim()
            ? payload.deviceName.trim().slice(0, 64)
            : "Another device";

        const room = getOrCreateRoom(rooms, code);
        publishSignal(room, {
          kind: payload.kind,
          serialized: payload.serialized,
          deviceName,
          publishedAt: Date.now(),
        });
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "GET") {
        const kindParam = url.searchParams.get("kind");
        if (!isSignalKind(kindParam)) {
          sendJson(res, 400, { error: "kind query must be offer or answer" });
          return;
        }

        const waitMs = Math.min(
          LONG_POLL_MS,
          Math.max(0, Number(url.searchParams.get("waitMs") ?? LONG_POLL_MS) || LONG_POLL_MS),
        );
        const existing = rooms.get(code);
        const room = existing ? pruneRoom(rooms, code, existing) : null;
        if (room) {
          const ready = takeSignal(room, kindParam);
          if (ready) {
            sendJson(res, 200, {
              ok: true,
              kind: ready.kind,
              serialized: ready.serialized,
              deviceName: ready.deviceName,
            });
            return;
          }
        }

        if (waitMs === 0) {
          sendJson(res, 200, { ok: false });
          return;
        }

        const activeRoom = room ?? getOrCreateRoom(rooms, code);
        const signal = await new Promise<StoredSignal | null>((resolve) => {
          const waiter: RoomWaiter = {
            kind: kindParam,
            resolve,
            timer: setTimeout(() => {
              activeRoom.waiters = activeRoom.waiters.filter((item) => item !== waiter);
              resolve(null);
            }, waitMs),
          };
          activeRoom.waiters.push(waiter);
          req.on("close", () => {
            if (!activeRoom.waiters.includes(waiter)) return;
            clearTimeout(waiter.timer);
            activeRoom.waiters = activeRoom.waiters.filter((item) => item !== waiter);
            resolve(null);
          });
        });

        if (!signal) {
          sendJson(res, 200, { ok: false });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          kind: signal.kind,
          serialized: signal.serialized,
          deviceName: signal.deviceName,
        });
        return;
      }

      sendJson(res, 405, { error: "Method not allowed" });
    } catch (error) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

export function lanSignalingPlugin(): Plugin {
  const rooms = new Map<string, Room>();

  const configure = (server: ViteDevServer | PreviewServer) => {
    attachLanSignaling(server.middlewares, rooms);
  };

  return {
    name: "lan-signaling",
    configureServer: configure,
    configurePreviewServer: configure,
  };
}
