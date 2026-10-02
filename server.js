import colyseus from "colyseus";
const { Server, Room } = colyseus;
import { WebSocketTransport } from "@colyseus/ws-transport";

import { Schema, MapSchema, type } from "@colyseus/schema";
import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- Tunables ----------
const WORLD = { w: 1000, h: 700 };
const DAY_LENGTH = 180000; // ms for a full day/night cycle (3 minutes)
const TICK_MS = 100;

const PLAYER = {
  maxHp: 100,
  maxHunger: 100,
  maxThirst: 100,
  maxStamina: 100,
  maxWarmth: 100,
  sprintMult: 1.65,
  exhaustedMult: 0.5,
  interactRange: 70,
  swingCooldown: 0.55, // seconds between swings
};

// Per-second vital drain/regen rates.
const RATES = {
  hungerBase: 0.35,
  hungerSprint: 0.45,
  hungerSwing: 0.2,
  thirstBase: 0.5,
  thirstSprint: 0.5,
  staminaSprint: 15,
  staminaIdle: 10,
  warmthDown: 2.5,
  warmthUp: 6,
  warmthFire: 15,
  hpRegen: 0.5,
  hpStarve: 1.5,
  hpDehydrate: 2,
  hpFreeze: 1.2,
};

// Gathered nodes. hp = number of successful swings before the node is depleted.
const TREE_KINDS = {
  pine: { hp: 6, yield: { wood: 3 } },
  oak: { hp: 7, yield: { wood: 2, fiber: 1 } },
  berry: { hp: 3, yield: { food: 2 } },
  fiber: { hp: 2, yield: { fiber: 3 } },
};
const ROCK = { hp: 6, yield: { stone: 2 } };

const SWING_STAMINA = 9;
const SWING_STAMINA_TOOL = 5;

// Crafting recipes. A campfire is placed at the player's feet when crafted.
const RECIPES = {
  axe: { cost: { wood: 3, fiber: 2 }, tool: true, durability: 45 },
  pickaxe: { cost: { wood: 3, stone: 3 }, tool: true, durability: 45 },
  campfire: { cost: { wood: 5, stone: 3 } },
};

const FIRE_FUEL_MAX = 150; // seconds of burn at full
const FIRE_START_FUEL = 90;

// ---------- Shared state schemas ----------
class Player extends Schema {}
type("number")(Player.prototype, "x");
type("number")(Player.prototype, "y");
type("number")(Player.prototype, "wood");
type("number")(Player.prototype, "stone");
type("number")(Player.prototype, "fiber");
type("number")(Player.prototype, "food");
type("number")(Player.prototype, "water");
type("number")(Player.prototype, "hp");
type("number")(Player.prototype, "hunger");
type("number")(Player.prototype, "thirst");
type("number")(Player.prototype, "stamina");
type("number")(Player.prototype, "warmth");
type("boolean")(Player.prototype, "alive");
type("number")(Player.prototype, "deaths");
type("string")(Player.prototype, "tool"); // "none" | "axe" | "pickaxe"
type("number")(Player.prototype, "toolDurability");
type("string")(Player.prototype, "action"); // "" | "chop" | "mine" | "gather"

class Tree extends Schema {}
type("number")(Tree.prototype, "x");
type("number")(Tree.prototype, "y");
type("string")(Tree.prototype, "kind"); // pine | oak | berry | fiber
type("number")(Tree.prototype, "hp");

class Rock extends Schema {}
type("number")(Rock.prototype, "x");
type("number")(Rock.prototype, "y");
type("number")(Rock.prototype, "hp");

class Fire extends Schema {}
type("number")(Fire.prototype, "x");
type("number")(Fire.prototype, "y");
type("number")(Fire.prototype, "fuel");

class Water extends Schema {}
type("number")(Water.prototype, "x");
type("number")(Water.prototype, "y");

class State extends Schema {
  constructor() {
    super();
    // MapSchema fields must be initialized; @colyseus/schema does not
    // auto-create them (unlike ArraySchema), so they'd otherwise be undefined.
    this.players = new MapSchema();
    this.trees = new MapSchema();
    this.rocks = new MapSchema();
    this.fires = new MapSchema();
    this.waters = new MapSchema();
  }
}
type({ map: Player })(State.prototype, "players");
type({ map: Tree })(State.prototype, "trees");
type({ map: Rock })(State.prototype, "rocks");
type({ map: Fire })(State.prototype, "fires");
type({ map: Water })(State.prototype, "waters");
type("number")(State.prototype, "worldSeed");
type("number")(State.prototype, "timeOfDay"); // 0..1, server-authoritative
type("number")(State.prototype, "day");

// ---------- The game room ----------
class SurvivalRoom extends Room {
  onCreate() {
    this.maxClients = 8;
    this.setState(new State());
    this.state.worldSeed = Math.floor(Math.random() * 100000);
    this.state.timeOfDay = 0.35;
    this.state.day = 1;

    this.startedAt = Date.now();
    this.nextId = 0;
    this.pending = []; // nodes waiting to regrow
    // Transient per-client state that isn't worth syncing to every client.
    this.sprinters = new Set();
    this.swingAt = new Map();
    this.deathAt = new Map();
    this.actionUntil = new Map();

    this.spawnTrees(34);
    this.spawnRocks(14);
    this.spawnWater(3);

    // Movement + intent flags. Position is validated server-side.
    this.onMessage("move", (client, data) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || !p.alive) return;
      const x = Number(data.x);
      const y = Number(data.y);
      if (!isFinite(x) || !isFinite(y)) return;
      p.x = Math.max(0, Math.min(WORLD.w, x));
      p.y = Math.max(0, Math.min(WORLD.h, y));
      if (data.sprint) this.sprinters.add(client.sessionId);
      else this.sprinters.delete(client.sessionId);
    });

    this.onMessage("interact", (client, data) => this.handleInteract(client, data));
    this.onMessage("craft", (client, data) => this.handleCraft(client, data));
    this.onMessage("consume", (client, data) => this.handleConsume(client, data));
    this.onMessage("respawn", (client) => this.handleRespawn(client));

    this.setSimulationInterval((dtMs) => this.tick(dtMs), TICK_MS);
  }

  // ---- world generation ----
  spawnTrees(count) {
    const roll = () => {
      const r = Math.random();
      if (r < 0.42) return "pine";
      if (r < 0.76) return "oak";
      if (r < 0.9) return "berry";
      return "fiber";
    };
    for (let i = 0; i < count; i++) this.addTree(roll());
  }

  spawnRocks(count) {
    for (let i = 0; i < count; i++) this.addRock();
  }

  addTree(kind) {
    const id = `tree_${this.nextId++}`;
    this.state.trees.set(id, new Tree().assign({
      x: 80 + Math.random() * (WORLD.w - 160),
      y: 80 + Math.random() * (WORLD.h - 160),
      kind,
      hp: TREE_KINDS[kind].hp,
    }));
  }

  addRock() {
    const id = `rock_${this.nextId++}`;
    this.state.rocks.set(id, new Rock().assign({
      x: 80 + Math.random() * (WORLD.w - 160),
      y: 80 + Math.random() * (WORLD.h - 160),
      hp: ROCK.hp,
    }));
  }

  spawnWater(count) {
    // Keep ponds away from the spawn point in the middle.
    for (let i = 0; i < count; i++) {
      let x, y, tries = 0;
      do {
        x = 100 + Math.random() * (WORLD.w - 200);
        y = 100 + Math.random() * (WORLD.h - 200);
      } while (Math.hypot(x - WORLD.w / 2, y - WORLD.h / 2) < 220 && ++tries < 20);
      this.state.waters.set(`water_${this.nextId++}`, new Water().assign({ x, y }));
    }
  }

  // ---- helpers ----
  dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  has(p, cost) {
    for (const [k, v] of Object.entries(cost)) if (p[k] < v) return false;
    return true;
  }

  pay(p, cost) {
    for (const [k, v] of Object.entries(cost)) p[k] -= v;
  }

  notice(client, msg) {
    client.send("notice", { msg });
  }

  // ---- interactions ----
  handleInteract(client, data) {
    const p = this.state.players.get(client.sessionId);
    if (!p || !p.alive) return;
    if (!data || typeof data !== "object") return;

    const now = Date.now();
    const last = this.swingAt.get(client.sessionId) || 0;
    if (now - last < PLAYER.swingCooldown * 1000) return;

    // Refuelling a fire is a separate, tool-free action.
    if (data.targetType === "fire") {
      const fire = this.state.fires.get(data.targetId);
      if (!fire || this.dist(p, fire) > PLAYER.interactRange) return;
      if (p.wood < 1) return this.notice(client, "Need wood to stoke the fire");
      p.wood -= 1;
      fire.fuel = Math.min(FIRE_FUEL_MAX, fire.fuel + 45);
      this.swingAt.set(client.sessionId, now);
      p.action = "gather";
      this.actionUntil.set(client.sessionId, now + 600);
      return;
    }

    let node;
    if (data.targetType === "tree") node = this.state.trees.get(data.targetId);
    else if (data.targetType === "rock") node = this.state.rocks.get(data.targetId);
    else if (data.targetType === "water") {
      // Drinking at a pond: no tool, no cooldown beyond the swing timer.
      const pond = this.state.waters.get(data.targetId);
      if (!pond || this.dist(p, pond) > PLAYER.interactRange) return;
      p.thirst = Math.min(PLAYER.maxThirst, p.thirst + 30);
      p.water = Math.min(10, p.water + 1); // fill a waterskin you can carry
      this.swingAt.set(client.sessionId, now);
      p.action = "gather";
      this.actionUntil.set(client.sessionId, now + 600);
      return;
    }
    if (!node) return;
    if (this.dist(p, node) > PLAYER.interactRange) return this.notice(client, "Too far away");

    const isTree = data.targetType === "tree";
    const toolOk = isTree ? p.tool === "axe" : p.tool === "pickaxe";
    const staminaCost = toolOk ? SWING_STAMINA_TOOL : SWING_STAMINA;
    if (p.stamina < staminaCost) return this.notice(client, "Too exhausted to work");

    p.stamina -= staminaCost;
    p.hunger = Math.max(0, p.hunger - RATES.hungerSwing);
    this.swingAt.set(client.sessionId, now);
    p.action = isTree
      ? (node.kind === "berry" || node.kind === "fiber" ? "gather" : "chop")
      : "mine";
    this.actionUntil.set(client.sessionId, now + 600);

    // Yield, doubled when the right tool is equipped.
    const def = isTree ? TREE_KINDS[node.kind] : ROCK;
    const mult = toolOk ? 2 : 1;
    for (const [res, amt] of Object.entries(def.yield)) {
      p[res] = (p[res] || 0) + amt * mult;
    }

    if (toolOk) {
      p.toolDurability -= 1;
      if (p.toolDurability <= 0) {
        p.tool = "none";
        p.toolDurability = 0;
        this.notice(client, "Your tool broke");
      }
    }

    node.hp -= 1;
    if (node.hp <= 0) {
      if (isTree) this.state.trees.delete(data.targetId);
      else this.state.rocks.delete(data.targetId);
      // Regrow somewhere else so the world never runs dry.
      this.pending.push({ tree: isTree, kind: isTree ? node.kind : null, at: now + 40000 });
    }
  }

  handleCraft(client, data) {
    const p = this.state.players.get(client.sessionId);
    if (!p || !p.alive) return;
    const recipe = RECIPES[data && data.item];
    if (!recipe) return;
    if (!this.has(p, recipe.cost)) return this.notice(client, "Not enough materials");
    this.pay(p, recipe.cost);

    if (recipe.tool) {
      p.tool = data.item;
      p.toolDurability = recipe.durability;
      this.notice(client, `Crafted ${data.item}`);
    } else if (data.item === "campfire") {
      const id = `fire_${this.nextId++}`;
      this.state.fires.set(id, new Fire().assign({ x: p.x, y: p.y, fuel: FIRE_START_FUEL }));
      this.notice(client, "Campfire lit");
    }
  }

  handleConsume(client, data) {
    const p = this.state.players.get(client.sessionId);
    if (!p || !p.alive) return;
    if (data && data.item === "food" && p.food > 0) {
      p.food -= 1;
      p.hunger = Math.min(PLAYER.maxHunger, p.hunger + 32);
    } else if (data && data.item === "water" && p.water > 0) {
      p.water -= 1;
      p.thirst = Math.min(PLAYER.maxThirst, p.thirst + 38);
    }
  }

  handleRespawn(client) {
    const p = this.state.players.get(client.sessionId);
    if (!p || p.alive) return;
    if (Date.now() - (this.deathAt.get(client.sessionId) || 0) < 2000) return;
    p.x = WORLD.w / 2 + (Math.random() * 100 - 50);
    p.y = WORLD.h / 2 + (Math.random() * 100 - 50);
    p.hp = PLAYER.maxHp;
    p.hunger = 65;
    p.thirst = 65;
    p.stamina = PLAYER.maxStamina;
    p.warmth = 55;
    p.alive = true;
    p.action = "";
  }

  // ---- simulation ----
  tick(dtMs) {
    const dt = dtMs / 1000;
    const now = Date.now();

    const elapsed = (now - this.startedAt) / DAY_LENGTH;
    const tOfDay = (elapsed + 0.35) % 1;
    this.state.timeOfDay = tOfDay;
    this.state.day = 1 + Math.floor(elapsed + 0.35);

    const s = Math.sin(tOfDay * Math.PI * 2 - Math.PI / 2); // -1 midnight, +1 noon
    const dayAmt = Math.max(0, Math.min(1, (s + 0.15) / 0.9));
    const ambientWarmth = dayAmt * 100 + (1 - dayAmt) * 8;

    // Fires burn down and expire.
    this.state.fires.forEach((fire, id) => {
      fire.fuel -= dt;
      if (fire.fuel <= 0) this.state.fires.delete(id);
    });

    this.state.players.forEach((p, id) => {
      if (!p.alive) return;

      // Sprinting burns stamina and, indirectly, food and water.
      const sprinting = this.sprinters.has(id) && p.stamina > 1;
      if (sprinting) p.stamina = Math.max(0, p.stamina - RATES.staminaSprint * dt);

      p.hunger = Math.max(0, p.hunger - (RATES.hungerBase + (sprinting ? RATES.hungerSprint : 0)) * dt);
      p.thirst = Math.max(0, p.thirst - (RATES.thirstBase + (sprinting ? RATES.thirstSprint : 0)) * dt);

      // Warmth drifts toward the ambient temperature, or toward a nearby fire.
      let nearFire = false;
      this.state.fires.forEach((fire) => {
        if (Math.hypot(p.x - fire.x, p.y - fire.y) < 110) nearFire = true;
      });
      const target = nearFire ? PLAYER.maxWarmth : ambientWarmth;
      if (p.warmth < target) p.warmth = Math.min(target, p.warmth + RATES.warmthUp * dt);
      else p.warmth = Math.max(target, p.warmth - RATES.warmthDown * dt);

      // Stamina recovers only when not sprinting and not mid-action.
      if (!sprinting && !p.action) {
        p.stamina = Math.min(PLAYER.maxStamina, p.stamina + RATES.staminaIdle * dt);
      }
      if ((this.actionUntil.get(id) || 0) < now) p.action = "";

      // Health consequences of unmet needs.
      let dmg = 0;
      if (p.hunger <= 0) dmg += RATES.hpStarve;
      if (p.thirst <= 0) dmg += RATES.hpDehydrate;
      if (p.warmth < 20) dmg += RATES.hpFreeze * ((20 - p.warmth) / 20);

      if (dmg > 0) {
        p.hp = Math.max(0, p.hp - dmg * dt);
      } else if (p.hunger > 40 && p.thirst > 40 && p.warmth > 30) {
        p.hp = Math.min(PLAYER.maxHp, p.hp + RATES.hpRegen * dt);
      }

      if (p.hp <= 0) {
        p.alive = false;
        p.deaths += 1;
        this.deathAt.set(id, now);
        // Death costs the resources you were carrying; crafted tools are kept.
        p.wood = p.stone = p.fiber = p.food = p.water = 0;
        p.stamina = 0;
        p.action = "";
      }
    });

    // Regrow depleted nodes.
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (now >= this.pending[i].at) {
        const item = this.pending.splice(i, 1)[0];
        if (item.tree) this.addTree(item.kind);
        else this.addRock();
      }
    }
  }

  onJoin(client) {
    console.log(`${client.sessionId} joined`);
    this.state.players.set(client.sessionId, new Player().assign({
      x: WORLD.w / 2 + (Math.random() * 100 - 50),
      y: WORLD.h / 2 + (Math.random() * 100 - 50),
      wood: 0, stone: 0, fiber: 0, food: 0, water: 0,
      hp: PLAYER.maxHp,
      hunger: 80,
      thirst: 80,
      stamina: PLAYER.maxStamina,
      warmth: 65,
      alive: true,
      deaths: 0,
      tool: "none",
      toolDurability: 0,
      action: "",
    }));
  }

  onLeave(client) {
    console.log(`${client.sessionId} left`);
    this.state.players.delete(client.sessionId);
    this.sprinters.delete(client.sessionId);
    this.swingAt.delete(client.sessionId);
    this.deathAt.delete(client.sessionId);
    this.actionUntil.delete(client.sessionId);
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
