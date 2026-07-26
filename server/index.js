#!/usr/bin/env node
/**
 * Bluebird session server.
 *
 * A relay, deliberately. Every client simulates its own rider and receives the
 * others as interpolated poses, so the server never runs physics, never needs to
 * agree with a client about anything, and a player on a bad connection cannot
 * affect anyone else's run. That also means it stays cheap: a room is a Set of
 * sockets and a level definition.
 *
 *   npm run server            # listens on 8787
 *   PORT=9000 npm run server
 */

import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT || 8787);
const MAX_ROOM_SIZE = Number(process.env.MAX_ROOM_SIZE || 24);
const MAX_MESSAGE_BYTES = 64 * 1024;

/** room name -> { level, clients: Map<id, client> } */
const rooms = new Map();

const server = new WebSocketServer({ port: PORT, maxPayload: MAX_MESSAGE_BYTES });

server.on('listening', () => {
  console.log(`Bluebird session server listening on ws://0.0.0.0:${PORT}`);
});

server.on('connection', (socket, request) => {
  const client = {
    id: randomUUID(),
    socket,
    room: null,
    name: 'rider',
    gearId: 'park-155',
    goofy: false,
    colors: {},
    lastMessage: Date.now(),
    alive: true,
  };

  socket.on('pong', () => {
    client.alive = true;
  });

  socket.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    // Light rate limit: a client sending far faster than the 15 Hz protocol is
    // either broken or hostile, and either way we drop the excess.
    const now = Date.now();
    if (now - client.lastMessage < 8 && msg.t === 'state') return;
    client.lastMessage = now;

    switch (msg.t) {
      case 'join':
        handleJoin(client, msg);
        break;
      case 'state':
        relay(client, { t: 'state', id: client.id, s: msg.s });
        break;
      case 'trick':
        if (typeof msg.name === 'string' && msg.name.length <= 80) {
          relay(client, { t: 'trick', id: client.id, name: msg.name, points: Number(msg.points) || 0 }, true);
        }
        break;
      default:
        break;
    }
  });

  socket.on('close', () => leaveRoom(client));
  socket.on('error', () => leaveRoom(client));

  console.log(`connection from ${request.socket.remoteAddress} -> ${client.id}`);
});

function handleJoin(client, msg) {
  const roomName = sanitizeRoom(msg.room);
  leaveRoom(client);

  let room = rooms.get(roomName);
  if (!room) {
    room = { level: null, clients: new Map() };
    rooms.set(roomName, room);
  }
  if (room.clients.size >= MAX_ROOM_SIZE) {
    send(client.socket, { t: 'error', message: 'That session is full.' });
    return;
  }

  client.room = roomName;
  client.name = typeof msg.name === 'string' ? msg.name.slice(0, 18) : 'rider';
  client.gearId = typeof msg.gearId === 'string' ? msg.gearId.slice(0, 40) : 'park-155';
  client.goofy = Boolean(msg.goofy);
  client.colors = msg.colors && typeof msg.colors === 'object' ? msg.colors : {};

  // The first person in the room sets the mountain everyone rides.
  if (!room.level && msg.level && typeof msg.level === 'object') {
    room.level = msg.level;
  }

  room.clients.set(client.id, client);

  send(client.socket, {
    t: 'welcome',
    id: client.id,
    level: room.level,
    players: [...room.clients.values()].filter((c) => c.id !== client.id).map(describe),
  });
  relay(client, { t: 'joined', ...describe(client) }, false);
  console.log(`${client.name} joined ${roomName} (${room.clients.size} in room)`);
}

function leaveRoom(client) {
  if (!client.room) return;
  const room = rooms.get(client.room);
  const roomName = client.room;
  client.room = null;
  if (!room) return;
  room.clients.delete(client.id);
  for (const other of room.clients.values()) {
    send(other.socket, { t: 'left', id: client.id });
  }
  if (room.clients.size === 0) {
    rooms.delete(roomName);
    console.log(`room ${roomName} closed`);
  }
}

function relay(client, payload, includeSelf = false) {
  if (!client.room) return;
  const room = rooms.get(client.room);
  if (!room) return;
  for (const other of room.clients.values()) {
    if (!includeSelf && other.id === client.id) continue;
    send(other.socket, payload);
  }
}

function describe(client) {
  return {
    id: client.id,
    name: client.name,
    gearId: client.gearId,
    goofy: client.goofy,
    colors: client.colors,
  };
}

function send(socket, payload) {
  if (socket.readyState !== socket.OPEN) return;
  try {
    socket.send(JSON.stringify(payload));
  } catch {
    /* the close handler will clean up */
  }
}

function sanitizeRoom(name) {
  const cleaned = String(name ?? 'bluebird')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 32);
  return cleaned || 'bluebird';
}

// Drop sockets that stop answering rather than leaving ghosts in the roster.
const heartbeat = setInterval(() => {
  for (const room of rooms.values()) {
    for (const client of room.clients.values()) {
      if (!client.alive) {
        client.socket.terminate();
        continue;
      }
      client.alive = false;
      try {
        client.socket.ping();
      } catch {
        /* terminated next sweep */
      }
    }
  }
}, 12000);

server.on('close', () => clearInterval(heartbeat));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\nshutting down');
    clearInterval(heartbeat);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  });
}
