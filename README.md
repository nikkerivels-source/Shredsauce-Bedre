# Bluebird

Freestyle skiing and snowboarding for the browser, built on a real carving and
aerial simulation rather than a scripted one.

*Bluebird* is what riders call a clear, cold, blue-sky day after a storm — the
one you wait all season for. The whole game is built around that light: pale
snow, a layered range on the horizon, and one solid blue running through the
interface.

It runs on desktop and on a phone, from a single static build. There is no
install, no account, and nothing to buy.

```bash
npm install
npm run dev          # http://localhost:5173
npm run server       # optional: live sessions on ws://localhost:8787
```

```bash
npm test             # 49 unit tests (physics, tricks, editor, replays)
npm run build        # typecheck + production bundle into dist/
node scripts/smoke.mjs --shots   # drives the built game in a real browser
```

---

## What makes it different

The pitch is simple: everything you would expect from an action-sports game,
with the physics actually solved instead of approximated by animation curves.

### The carve is a real carve

A snowboard turns because a tilted sidecut describes an arc in the snow. That is
what happens here. Each of eleven contact points along the engaged edge gets its
own local tangent from the board's sidecut geometry, and a brush-model tyre force
builds with slip angle, peaks, and breaks away past the limit. Ride a clean edge
and the slip angle goes to zero and you hold speed through the turn. Ask for more
than the edge can give and it lets go, sprays snow and scrubs speed.

Consequences that fall out of the model rather than being special-cased:

- **Turn radius comes from your gear.** A 7.2 m park board carves visibly tighter
  than a 21 m GS ski. Those numbers are the real published sidecut radii.
- **Cross-over is how you start a turn.** Setting an edge without moving your
  hips inside topples you *outward* — exactly what happens to a beginner. The
  lean input drives both the ankle angulation and the hip movement, because that
  is what a real turn is.
- **Snow hardness spans two orders of magnitude of stiffness**, from powder you
  sink 18 cm into to injected race ice you barely dent. Powder is slow because
  the board is shovelling snow; a groomer is fast because it isn't.
- **The snow gets skied out.** Every pass packs the surface under you, so a
  well-used line becomes harder, faster and grippier, and looks it.

### Air is angular momentum, not an animation

Rotation integrates **angular momentum**, not angular velocity, and the moment of
inertia is recomputed every substep from your body position. So when you tuck
mid-flight your spin genuinely accelerates, because L is conserved and I dropped.
Untuck and it slows. Nobody scripted that.

You cannot generate rotation out of nothing in the air. Spins are set up on the
ground by winding your body against a loaded edge and releasing it at the lip.
Airborne input has limited authority drawn from a reservoir that has to unwind
before you can push the same way again — the same constraint a real rider has.

A snowboarder and a skier get different moment-of-inertia tensors in the same
local frame, because one stands sideways and the other faces forward. That single
difference is why a board somersaults about the axis a ski rolls about, and it is
why the two disciplines get different trick vocabularies without any of it being
hard-coded.

### Pop is a real ollie

The legs are a genuine internal degree of freedom: a spring-damper between the
rider and the gear, solved at 1920 Hz with a bump stop.

    r̈ = F_leg / µ − F_contact / m_gear

Load the legs, release, and the extension drives the light board down into the
snow. The snow pushes back, and the reaction lifts you. Land badly and the same
spring bottoms out, transmits the shock, and you case it.

### Everything the HUD shows is a real measurement

The speedo is metres per second. The edge gauge is the actual angle the gear is
on. The grip bar is the measured lateral ground reaction in g. The balance meter
on a rail is your real centre-of-mass offset from the rail line. It doubles as a
teaching tool: watch the grip bar go red and you can *see* why you washed out.

### Crashes are simulated too

Lose it and a 16-joint Verlet ragdoll takes over, seeded with the exact velocity
and spin you were carrying. A crash out of a corked 900 keeps tumbling like one.

---

## What's in it

| | |
|---|---|
| **Seven mountains** | Home Park, Big Air, Superpipe, Jib Yard, Powder Bowl, Giant Slalom, Superpark |
| **Endless more** | Seeded procedural generator — park, natural or urban |
| **Level editor** | Terrain sculpting, ten feature types, live weather and snow, undo/redo |
| **Sharing** | Levels compress to a paste-able share code (deflate + base64url) |
| **Game modes** | Free ride, jam session, time attack, challenges |
| **9 boards and skis** | Real sidecut, waist, flex, camber profile and swing weight |
| **24 grabs** | Indy through method, japan, roast beef, octograb, genie |
| **Tricks** | Spins, flips, corks, rodeos, mistys, bios, flatspins, switch and cab naming |
| **Rails** | 50-50, boardslide, lipslide, nose/tail slide, presses, on round bars, flat bars, kinks and boxes |
| **Replays** | Recorded and replayed from any camera, saved locally |
| **Live sessions** | Room-based multiplayer over a bundled WebSocket relay |
| **Progression** | XP, credits, gear unlocks, challenges, local leaderboard |

### Look

Bright and low-poly, on purpose. Near-white snow with groomer corduroy, conifers
that read as black silhouettes against it, poured-concrete park features, and a
continuous ridged mountain range closing the horizon in layers that fade into
haze. The menus sit directly on the live mountain — the title screen is the level
you are about to ride, orbiting slowly, not a still image.

---

## Controls

**Touch.** One thumb steers, and it sets its origin wherever it lands — there is
no fixed on-screen stick to miss. Drag left and right to lean, down to load your
legs, release to pop. In the air the same drag spins and flips. A second finger
grabs; drag it to pick which grab from the radial.

**Keyboard.**

| | |
|---|---|
| `A` `D` | Lean / carve (spin in the air) |
| `W` `S` | Fore/aft weight — nose and tail press (flip in the air) |
| `Q` `E` | Wind up rotation against the edge |
| `Space` | Hold to load the legs, release to pop |
| `Shift` | Tuck — drops your moment of inertia |
| `Z X C V F G` | Grabs |
| `R` `T` `P` `Esc` | Reset · camera · photo · pause |

**Gamepad.** Left stick steers, right stick trims in the air, right trigger
loads, face buttons and bumpers grab.

### The realism slider

Settings → Assist. The simulation is identical at every setting; the slider only
changes how much the rider corrects for you.

- **Raw** — no help at all. You hold your own edge. It is hard, and it is the
  honest version.
- **Authentic** — a light hand on the edge.
- **Assisted** *(default)* — holds your edge and squares you up on landing.
- **Relaxed** — forgiving.

Even at full assist the target the game steers toward is the textbook balanced
carve angle, `tan ψ = v² / gR`, not "upright".

---

## Architecture

```
src/
  core/math.ts          Vec3, Quat, seeded noise — no dependencies, so the
                        physics runs headless under the test suite
  physics/
    riderSim.ts         The solver: contact, carving, legs, air, grinds, bails
    gear.ts             Board and ski specs, inertia tensors, camber profiles
    grabs.ts            Grab catalogue with tuck depth and style values
    rails.ts            Grind surfaces and closest-point queries
    ragdoll.ts          Verlet ragdoll + the procedural riding pose
  world/
    level.ts            Level schema, validation, migration
    terrain.ts          Bakes a level into a heightfield; per-feature shapes
    heightfield.ts      Grid sampling, normals, snow-pack state
  game/
    session.ts          One run: modes, timers, objectives, summary
    tricks.ts           Rotation analysis, trick naming, scoring, combos
    editor.ts           Placement, sculpting, undo, region re-bake
    levels.ts           Presets and the procedural generator
    input.ts            Touch gestures, keyboard, gamepad
    replay.ts           Recording and playback
    storage.ts          Profile, library, share codes, scores
  render/               three.js: snow shader, carve trails, spray, cameras
  net/client.ts         Session client
  ui/                   HUD and menus (plain DOM, no framework)
server/index.js         WebSocket relay
```

Two rules keep it honest:

- **`core` and `physics` never import `three` or touch the DOM.** The solver runs
  in plain Node, which is why the physics can be unit-tested at all.
- **The simulation never knows what is drawing it.** `Session` produces a pose
  and a summary. The same pose type drives the live rider, a ragdoll mid-crash, a
  replay ghost and every remote player.

### Multiplayer

The server relays and nothing else. Every client simulates its own rider and
receives the others as interpolated poses at 15 Hz. A room is a `Set` of sockets
and a level definition. That means it is cheap to host, and a player on a bad
connection can never affect anyone else's physics.

```bash
npm run server                    # port 8787
PORT=9000 npm run server
```

Point the client at another host with `?server=wss://your-host`.

---

## Testing

`npm test` covers the parts where being wrong is silent:

- **Physics** — spawns settled instead of launching, reaches a plausible terminal
  speed, holds a line with no input, turns the way you asked, carves rather than
  skids, pops off the ground, conserves angular momentum through a tuck, never
  produces `NaN` under adversarial input, and recovers from a bail.
- **Terrain** — a kicker's circular in-run really does reach the requested height
  at the requested lip angle.
- **Tricks** — a 540 is named a 540, frontside and backside are the right way
  round, a grab scores more than the same spin without one, a bail scores zero.
- **Levels** — round-trip through JSON, junk is rejected safely, and a hostile
  share code cannot make the baker allocate gigabytes.
- **Editor** — undo/redo across placement, movement and sculpting, and rails stay
  on the snow when you sculpt underneath them.

`node scripts/smoke.mjs` boots the built bundle in a real Chromium, clicks
through the menus into a run, presses actual keys, and checks the rider moved and
the frame drew — the class of failure a type-check cannot see.

---

## Notes on the model

A few places where the simulation deliberately does something, and why:

- **Board flex.** Pressure is smoothed along the length of the gear, because a
  board is a beam and bends to conform. Without it, load piles onto whichever end
  is deepest, which puts the centre of pressure ahead of the centre of mass and
  makes the board directionally unstable — an arrow with its fletching at the
  front. It spins out every time.
- **Friction impulse cap.** Edge response is stiffer than the timestep, so the
  lateral force is capped at the impulse that exactly nulls the slip. That is
  both stable and physically honest — friction cannot do more than stop sliding.
- **Directional hold.** A board is directionally neutral, so the smallest
  disturbance integrates into a spin-out over a few seconds. Real riders are not
  passive; they hold their line continuously. That controller is what "no input"
  means. The twist input backs it off so deliberate slides still work.
- **Assist anchoring.** Balance alone is satisfied by *any* turn radius, including
  one that keeps tightening. The assist target is scaled by how much turn you
  actually asked for, so releasing the controls means the rider intends to stand
  up and run the fall line.

Where the trick vocabulary is genuinely contested between riders — rodeo versus
misty, where a cork stops being a cork — the code picks one consistent reading and
says so at the point it decides.

---

## Licence

Original work. Not affiliated with any existing game.
