import colyseus from "colyseus";
const { Server, Room } = colyseus;
import { WebSocketTransport } from "@colyseus/ws-transport";

import { Schema, MapSchema, type } from "@colyseus/schema";
import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- Shared state schemas ----------
class Player extends Schema {}
type("number")(Player.prototype, "x");
type("number")(Player.prototype, "y");
type("number")(Player.prototype, "wood");

class Tree extends Schema {}
type("number")(Tree.prototype, "x");
type("number")(Tree.prototype, "y");

class State extends Schema {
  constructor() {
    super();
    // MapSchema fields must be initialized; @colyseus/schema does not
    // auto-create them (unlike ArraySchema), so they'd otherwise be undefined.
    this.players = new MapSchema();
    this.trees = new MapSchema();
  }
}
type({ map: Player })(State.prototype, "players");
type({ map: Tree })(State.prototype, "trees");
type("number")(State.prototype, "worldSeed");

// ---------- The game room ----------
class SurvivalRoom extends Room {
  onCreate() {
    this.maxClients = 8;
    this.setState(new State());
    this.state.worldSeed = Math.floor(Math.random() * 100000);

    // Spawn some trees
    for (let i = 0; i < 30; i++) {
      const id = `tree_${i}`;
      this.state.trees.set(id, new Tree().assign({
        x: 100 + Math.random() * 800,
        y: 100 + Math.random() * 500,
      }));
    }

    // Movement messages
    this.onMessage("move", (client, data) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      const x = Number(data.x);
      const y = Number(data.y);
      if (!isFinite(x) || !isFinite(y)) return;
      p.x = Math.max(0, Math.min(1000, x));
      p.y = Math.max(0, Math.min(700, y));
    });

    // Harvest a tree
    this.onMessage("harvest", (client, data) => {
      const player = this.state.players.get(client.sessionId);
      const tree = this.state.trees.get(data.treeId);
      if (!player || !tree) return;

      const dx = player.x - tree.x;
      const dy = player.y - tree.y;
      if (Math.hypot(dx, dy) > 60) return;

      this.state.trees.delete(data.treeId);
      player.wood += 1;
    });
  }

  onJoin(client) {
    console.log(`${client.sessionId} joined`);
    this.state.players.set(client.sessionId, new Player().assign({
      x: 500 + Math.random() * 100 - 50,
      y: 350 + Math.random() * 100 - 50,
      wood: 0,
    }));
  }

  onLeave(client) {
    console.log(`${client.sessionId} left`);
    this.state.players.delete(client.sessionId);
  }
}

// ---------- HTTP + WebSocket server ----------
const app = express();
app.use(express.static(path.join(__dirname, "public")));

// Health check for Render
app.get("/healthz", (_req, res) => res.send("ok"));

const server = http.createServer(app);
const gameServer = new Server({
  transport: new WebSocketTransport({ server }),
});
gameServer.define("survival", SurvivalRoom);

// IMPORTANT: use Render's PORT, bind to 0.0.0.0
const port = parseInt(process.env.PORT || "2567", 10);
server.listen(port, "0.0.0.0", () => {
  console.log(`Server running on port ${port}`);
});
