import { Quat, Vec3, clamp01 } from '../core/math.ts';
import type { LevelDef } from '../world/level.ts';
import type { GrabId } from '../physics/grabs.ts';

/** Wire format for one rider's state. Kept short — this goes out 15 times a second. */
export interface StatePacket {
  p: [number, number, number];
  q: [number, number, number, number];
  l: number;
  a: number;
  h: number;
  g: GrabId | null;
  w: number;
  k: number;
  m: 0 | 1;
}

export interface RemotePlayer {
  id: string;
  name: string;
  gearId: string;
  goofy: boolean;
  colors: Record<string, string>;
  /** Interpolated render state. */
  position: Vec3;
  orientation: Quat;
  legLength: number;
  angulation: number;
  hipShift: number;
  grab: GrabId | null;
  twist: number;
  tuck: number;
  limp: boolean;
  /** Most recent two packets, for interpolation. */
  private_prev?: StatePacket;
  private_next?: StatePacket;
  private_prevAt?: number;
  private_nextAt?: number;
}

export interface NetHandlers {
  onStatus(status: string): void;
  onRoster(players: RemotePlayer[]): void;
  onLevel(level: LevelDef): void;
  onTrick(name: string, playerName: string, points: number): void;
}

const SEND_HZ = 15;
/**
 * Render remote riders this far behind the newest packet. One send interval of
 * buffer is what lets interpolation always have two packets to work between, so
 * other players move smoothly instead of stepping.
 */
const INTERP_DELAY = 1 / SEND_HZ + 0.03;

/**
 * Multiplayer client.
 *
 * The server only relays — every client simulates its own rider and the others
 * are interpolated poses. That makes a session cheap to host and means a lagging
 * player can never affect anyone else's physics.
 */
export class NetClient {
  players = new Map<string, RemotePlayer>();
  selfId = '';
  room = '';
  connected = false;

  private socket: WebSocket | null = null;
  private handlers: NetHandlers;
  private sendTimer = 0;
  private url: string;
  private reconnectAt = 0;
  private wantConnection = false;
  private identity: { name: string; gearId: string; goofy: boolean; colors: Record<string, string> } = {
    name: 'rider',
    gearId: 'park-155',
    goofy: false,
    colors: {},
  };

  constructor(handlers: NetHandlers, url?: string) {
    this.handlers = handlers;
    this.url = url ?? defaultServerUrl();
  }

  setIdentity(identity: Partial<NetClient['identity']>): void {
    Object.assign(this.identity, identity);
  }

  join(room: string, level: LevelDef | null): void {
    this.room = room;
    this.wantConnection = true;
    this.pendingLevel = level;
    this.open();
  }

  private pendingLevel: LevelDef | null = null;

  leave(): void {
    this.wantConnection = false;
    this.socket?.close();
    this.socket = null;
    this.connected = false;
    this.players.clear();
    this.handlers.onStatus('offline');
    this.handlers.onRoster([]);
  }

  private open(): void {
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;
    this.handlers.onStatus('connecting…');
    try {
      this.socket = new WebSocket(this.url);
    } catch {
      this.handlers.onStatus('could not reach server');
      this.reconnectAt = performance.now() + 4000;
      return;
    }

    this.socket.onopen = () => {
      this.connected = true;
      this.handlers.onStatus(`connected to ${this.room}`);
      this.send({
        t: 'join',
        room: this.room,
        name: this.identity.name,
        gearId: this.identity.gearId,
        goofy: this.identity.goofy,
        colors: this.identity.colors,
        level: this.pendingLevel,
      });
    };

    this.socket.onclose = () => {
      this.connected = false;
      this.players.clear();
      this.handlers.onRoster([]);
      if (this.wantConnection) {
        this.handlers.onStatus('reconnecting…');
        this.reconnectAt = performance.now() + 2500;
      } else {
        this.handlers.onStatus('offline');
      }
    };

    this.socket.onerror = () => {
      this.handlers.onStatus('connection problem');
    };

    this.socket.onmessage = (event) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      this.handleMessage(msg);
    };
  }

  private handleMessage(msg: Record<string, unknown>): void {
    switch (msg.t) {
      case 'welcome': {
        this.selfId = String(msg.id ?? '');
        const list = Array.isArray(msg.players) ? msg.players : [];
        this.players.clear();
        for (const raw of list) this.upsertPlayer(raw as Record<string, unknown>);
        if (msg.level) this.handlers.onLevel(msg.level as LevelDef);
        this.handlers.onRoster([...this.players.values()]);
        break;
      }
      case 'joined': {
        this.upsertPlayer(msg as Record<string, unknown>);
        this.handlers.onRoster([...this.players.values()]);
        break;
      }
      case 'left': {
        this.players.delete(String(msg.id));
        this.handlers.onRoster([...this.players.values()]);
        break;
      }
      case 'state': {
        const id = String(msg.id);
        if (id === this.selfId) break;
        const player = this.players.get(id);
        const packet = msg.s as StatePacket | undefined;
        if (!player || !packet) break;
        player.private_prev = player.private_next ?? packet;
        player.private_prevAt = player.private_nextAt ?? performance.now() / 1000;
        player.private_next = packet;
        player.private_nextAt = performance.now() / 1000;
        break;
      }
      case 'trick': {
        const player = this.players.get(String(msg.id));
        this.handlers.onTrick(String(msg.name ?? ''), player?.name ?? 'someone', Number(msg.points ?? 0));
        break;
      }
      default:
        break;
    }
  }

  private upsertPlayer(raw: Record<string, unknown>): void {
    const id = String(raw.id ?? '');
    if (!id || id === this.selfId) return;
    const existing = this.players.get(id);
    const player: RemotePlayer = existing ?? {
      id,
      name: 'rider',
      gearId: 'park-155',
      goofy: false,
      colors: {},
      position: new Vec3(),
      orientation: new Quat(),
      legLength: 0.92,
      angulation: 0,
      hipShift: 0,
      grab: null,
      twist: 0,
      tuck: 0,
      limp: false,
    };
    if (typeof raw.name === 'string') player.name = raw.name.slice(0, 18);
    if (typeof raw.gearId === 'string') player.gearId = raw.gearId;
    if (typeof raw.goofy === 'boolean') player.goofy = raw.goofy;
    if (raw.colors && typeof raw.colors === 'object') player.colors = raw.colors as Record<string, string>;
    this.players.set(id, player);
  }

  /** Streams the local rider out and advances remote interpolation. */
  update(
    dt: number,
    self: {
      position: Vec3;
      orientation: Quat;
      legLength: number;
      angulation: number;
      hipShift: number;
      grab: GrabId | null;
      twist: number;
      tuck: number;
      limp: boolean;
    },
  ): void {
    if (this.wantConnection && !this.connected && performance.now() > this.reconnectAt) this.open();

    this.sendTimer += dt;
    if (this.connected && this.sendTimer >= 1 / SEND_HZ) {
      this.sendTimer = 0;
      const packet: StatePacket = {
        p: [round(self.position.x), round(self.position.y), round(self.position.z)],
        q: [round(self.orientation.x, 4), round(self.orientation.y, 4), round(self.orientation.z, 4), round(self.orientation.w, 4)],
        l: round(self.legLength, 3),
        a: round(self.angulation, 3),
        h: round(self.hipShift, 3),
        g: self.grab,
        w: round(self.twist, 2),
        k: round(self.tuck, 2),
        m: self.limp ? 1 : 0,
      };
      this.send({ t: 'state', s: packet });
    }

    const now = performance.now() / 1000 - INTERP_DELAY;
    for (const player of this.players.values()) {
      const prev = player.private_prev;
      const next = player.private_next;
      if (!prev || !next) continue;
      const t0 = player.private_prevAt ?? now;
      const t1 = player.private_nextAt ?? now;
      const span = t1 - t0;
      const alpha = span > 1e-4 ? clamp01((now - t0) / span) : 1;

      player.position.set(
        prev.p[0] + (next.p[0] - prev.p[0]) * alpha,
        prev.p[1] + (next.p[1] - prev.p[1]) * alpha,
        prev.p[2] + (next.p[2] - prev.p[2]) * alpha,
      );
      player.orientation.set(prev.q[0], prev.q[1], prev.q[2], prev.q[3]);
      _target.set(next.q[0], next.q[1], next.q[2], next.q[3]);
      player.orientation.slerp(_target, alpha);
      player.legLength = prev.l + (next.l - prev.l) * alpha;
      player.angulation = prev.a + (next.a - prev.a) * alpha;
      player.hipShift = prev.h + (next.h - prev.h) * alpha;
      player.grab = next.g;
      player.twist = prev.w + (next.w - prev.w) * alpha;
      player.tuck = prev.k + (next.k - prev.k) * alpha;
      player.limp = next.m === 1;
    }
  }

  reportTrick(name: string, points: number): void {
    if (!this.connected || points <= 0) return;
    this.send({ t: 'trick', name, points });
  }

  private send(payload: unknown): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    try {
      this.socket.send(JSON.stringify(payload));
    } catch {
      // A dropped frame of state is not worth surfacing.
    }
  }
}

function round(v: number, places = 2): number {
  const f = Math.pow(10, places);
  return Math.round(v * f) / f;
}

/** Same host as the page, on the server port, upgraded to ws/wss. */
function defaultServerUrl(): string {
  const override = new URLSearchParams(location.search).get('server');
  if (override) return override;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const port = location.port === '5173' || location.port === '4173' ? '8787' : location.port || '8787';
  return `${protocol}//${location.hostname}:${port}`;
}

const _target = new Quat();
