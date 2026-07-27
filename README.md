# Bluebird

A freeski game for the browser, built on a real carving and aerial simulation
rather than a scripted one. Snowboard is there too, as a choice.

*Bluebird* is what riders call a clear, cold, blue-sky day after a storm — the
one you wait all season for. The whole game is built around that light: pale
snow, a layered range on the horizon, and one solid blue running through the
interface.

It runs on desktop and on a phone, from a single static build. There is no
install and no account. One optional pass sells kit and sidegrade equipment;
every mountain, mode and editor feature is free.

```bash
npm install
npm run dev          # http://localhost:5173
npm run server       # optional: live sessions on ws://localhost:8787
```

```bash
npm test             # 78 unit tests (physics, tricks, level design, editor, replays)
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

### The sound is synthesised from the physics

There is not a single audio file in the project. Every sound is generated at
runtime and wired straight to the solver: the pitch of your edge tracks how far
the board is over and how hard it is loaded, the spray tracks the measured slip
speed, the wind opens up with velocity, and a landing's weight comes from the
peak leg force the leg spring actually recorded. A clean carve sings; break it
loose and the same layer widens into a roar. No amount of crossfading between
recorded loops does that.

### Poles are a real contact

A pole plant is a strut, not a button. The tip is planted at a fixed point in the
snow and from then on it can only *push* — a planted pole carries compression and
nothing else. You drive against it until your arm runs out of reach, at which
point it trails free and the stroke is over.

That one constraint produces both behaviours without either being special-cased,
and it is why the two plants go in different places:

- **Turning** plants ahead and to the inside. The strut pushes back and inward,
  so it pivots you into the turn and costs you a little speed. That is what a
  turn plant actually is — timing and rotation, not propulsion.
- **Running straight** plants at the boot. You glide over the tip, the strut
  swings round to point forward, and *that* is where the push comes from. Planting
  ahead and expecting to be driven along has the geometry backwards.

Stroke length is what stops it being a speed button: you get one arm's worth per
plant and then you have to reset. Snowboarders, obviously, have no poles.

A planted pole also **resists**. The shaft is rigid, so anything that would drive
your hand closer to the tip than the pole is long has to compress a metal tube,
and it does not compress — put weight on it in a steep and it props you there,
which is most of what a pole is for on anything technical. That support is
unilateral, like the push, and it is capped: past a few hundred newtons a real
tip punches through the snow or the shaft folds, so the pole stops holding you
and you go down with it. Hard snow holds more than soft.

Resistance runs the other way too. The poles are carried swept back with the tips
just clear of the snow, but drop into a deep enough crouch, or get folded up by a
compression, and the tips catch and plough — a small, quadratic-in-speed cost for
riding sloppy.

### The mountains are designed, not scattered

Every run is hand-built in `src/game/levels.ts` against the design rules in
`src/game/design.ts`, and those rules are the point. A jump owns its landing —
about eleven times the lip height — and then the rider needs a run-out to
settle and come back up to speed, so `jumpSpacing` is `height * 11 + 30`. That
puts medium jumps 50-75 m apart and the big ones 85-110 m, which is where real
slopestyle courses sit. A jib line goes above the jump line because that is the
order you build speed in. A slalom course is a rhythm — open turns, a flush, a
hairpin, open again — not a metronome.

The ground is sculpted too. Terrain brushes cut cliff bands into Cornice, dish
the landing out under Big Air's booter, raise spines through the Superpipe
outrun, build the deck and face of Last Light's urban ledge, and stack pillow
lines down Powder Bowl. The subtlety is that the baker *adds* brush strokes
together, so a line of them sums well past any one stroke's amount — and the
sum does not peak at a stroke centre but between stamps, where two near-full
contributions meet. `overlapFactor` walks a full spacing period and normalises
against the worst case, so a six-metre cliff band is six metres rather than
eleven. Tests pin the depths, because getting this wrong is silent: the level
still bakes, it is just the wrong shape.

One helper is named for what it can do rather than what was wanted. Radial
strokes cannot make a staircase — treads that do not overlap leave natural
ground between them, and treads that do overlap average into a ramp — so the
urban set is a `ledgeDrop`: a deck, a face, and flat ground below. That is how
a snow-covered stair set skis anyway.

### You can put your own picture behind the mountain

The editor takes an image off disk and wraps it round the horizon. It is stored
*inside* the level as inline image data rather than as a link, so a level stays
one self-contained object that works offline — a linked backdrop would make
every player who rode the level fetch from a stranger's server the moment they
dropped in.

That has costs, and they are handled rather than hidden. An upload is decoded,
downscaled to at most 2048x1024 and re-encoded as JPEG, walking the quality
down and then halving the resolution until it fits a 900 kB budget; the stored
size is shown next to the picture. Share codes leave the picture out, because a
code carrying one is far too long to paste. And a backdrop arriving inside
someone else's level is a trust boundary: only inline `data:image/png|jpeg|webp`
survives `sanitizeBackdrop`, with placement values clamped — an `https:` URL,
an SVG, or anything that is not really an image is dropped.

The picture is trusted near eye level only: full strength at and below the
horizon, gone by about forty degrees up, where the painted sky takes back over.
A photograph is not a sphere, and stretching one across the zenith is what makes
a custom sky look like a smeared thumb-print. The generated mountain range fades
out as the picture comes in, because it occupies exactly the same band and
supplying your own horizon is the whole point.

Twenty-two placeable items sit alongside it — trees, rocks, piste markers,
banners, start arches, safety netting, lift towers and chairs, cabins, tents,
igloos, snowcats, snow guns, speakers, benches, fire pits, barrels and crates —
each with a real mesh, picked from a palette that appears when you choose the
item tool.

### Season One is one payment and no homework

$2.99, once, and every kit and every ski unlocks immediately. No tiers to climb,
no daily quests, no season to miss, no second pass to buy later. Two rules keep
it from poisoning the game:

- **Nothing in it is required.** No mountain, mode or editor feature is behind
  it. Kit and equipment only.
- **Nothing in it is stronger.** Every pass ski trades something away — the
  light one is nervous at speed, the stable one is heavy, the powder one is
  vague on hardpack. A test asserts this: no pass ski may beat the best free
  gear in its discipline on glide, pop *and* swing weight at once. A pass that
  sells superiority makes the free game pointless, which is worse than not
  selling one.

**Payment is not connected.** The game has no server, so there is nothing to
take a card, verify a receipt, or hold an account — and entitlement therefore
lives in the same editable localStorage profile as everything else, which cannot
be enforced. The pass screen says all of this on the page rather than after a
click, and the buy button declines instead of quietly handing the pass over. A
smoke check asserts both: that the disclosure is present, and that pressing buy
grants nothing.

The seam for a real one is `beginCheckout` in `src/game/pass.ts`. Point
`VITE_CHECKOUT_URL` at a hosted checkout, and replace `consumeCheckoutReturn`'s
query-parameter placeholder with a server-verified receipt before it records
anything.

### The mountains behind the mountain

The horizon used to be a flat white ribbon. Getting it to read as terrain meant
finding three bugs that had been hiding each other, and none of them were in the
noise.

**The range was being backface-culled.** It is an open annulus and the camera
lives inside it, so the entire near wall faced away and was thrown out — which
showed as sky between the terrain and the peaks, and as torn shards wherever a
face happened to tip toward the viewer. Painting the whole range bright green
and *still* seeing a white skyline is what finally proved the mesh on screen was
not the mesh being coloured. It is a landscape, not a closed solid, so it draws
both sides.

**Fog ramped linearly to whiteout.** A level with a mild 0.2 fog and a little
snowfall was landing at a density that is 98% opaque two kilometres out — enough
to dissolve the range entirely, no matter what colour it was. Visibility is
multiplicative, so the control is now exponential, and the clear-day floor came
down by half again. It buys nothing nearby either way: at two hundred metres
both settings contribute under one percent.

**The valley apron stood in front of it.** The skirt beyond the run fell at nine
degrees for nine hundred metres, which is a plain, not a mountainside — so it
sat between the rider and the range and hid it. It falls properly now, and the
range starts closer, where the air is still clear.

With those out of the way the shape work shows: a broad massif field deciding
where the big mountains are, ridged detail folded about zero for the crests, and
rock keyed to altitude rather than steepness — because all anyone ever sees of a
range is its crests, and those are the part the wind scours bare. Octave counts
are capped by the column count rather than by taste: a fourth octave lands near
Nyquist at 220 columns and turns the skyline into a comb of identical spikes.

The snow itself gained the thing that most says *snow*: **blue shade**. A face
turned from the sun is lit only by the sky, and PBR alone renders that grey,
which is why untinted snow looks like paper. It also gained rock above about
fifty degrees — cliff bands, cut ledges, the valley wall — and sastrugi, the
wind texture that stops an open face reading as a bedsheet.

One number is deliberately unphysical. Rock albedo is set far darker than stone
actually is, because the scene runs a bright sun into ACES tone mapping and a
sensible 0.35 came out of the pipeline at 77% grey — near enough to snow's 94%
that the skyline read as white anyway. Working back from the wanted output beat
working forward from the material.

### It has to run on a phone

That claim is load-bearing, so two things are held to it.

**Scenery is instanced.** A long run auto-scatters a tree every six metres on
top of the couple of hundred each level places, and a pine is four meshes. Drawn
one at a time, Powder Bowl was pushing around 1,900 draw calls and as many unique
geometries before anything else in the frame was counted — and every one of them
again in the shadow pass. Each kind is now modelled once at unit scale and every
copy is an entry in an `InstancedMesh` per part, which takes the same forest from
1,928 objects to 9. Nothing about the look changed: the per-tree yaw and per-rock
tumble that used to be baked into separate geometries moved into the instance
matrix. A test asserts the batching, and another walks every instance matrix for
a NaN — one bad value hides the whole batch rather than one tree.

| | before | after |
|---|---|---|
| Powder Bowl | ~1,928 | 9 |
| Superpark | ~1,848 | 14 |
| Giant Slalom | ~1,816 | 15 |

**The layout is checked at 390px.** The desktop title screen leans on a
horizontal scrim — dark text column left, mountain right — which on a phone left
half the menu in white type over bright snow, unreadable. Below 720px the veil
turns vertical, the navigation stacks to one column, and level cards stop
dropping their score column on top of the description.

### Crashes are simulated too

Lose it and a 16-joint Verlet ragdoll takes over, seeded with the exact velocity
and spin you were carrying. A crash out of a corked 900 keeps tumbling like one.

---

## What's in it

| | |
|---|---|
| **Ten mountains** | Home Park, Big Air, Superpipe, Jib Yard, Powder Bowl, Giant Slalom, Superpark, Last Light, Glacier, Cornice |
| **Endless more** | Seeded procedural generator — park, natural or urban |
| **Level editor** | Terrain sculpting, ten feature types, live weather and snow, undo/redo |
| **Sharing** | Levels compress to a paste-able share code (deflate + base64url) |
| **Game modes** | Free ride, jam session, time attack, challenges |
| **5 skis, 5 boards** | Real sidecut, waist, flex, camber profile and swing weight |
| **24 grabs** | Indy through method, japan, roast beef, octograb, genie |
| **Tricks** | Spins, flips, corks, rodeos, mistys, bios, flatspins, switch and cab naming |
| **Rails** | 50-50, boardslide, lipslide, nose/tail slide, presses, on round bars, flat bars, kinks and boxes |
| **Replays** | Recorded and replayed from any camera, saved locally |
| **Live sessions** | Room-based multiplayer over a bundled WebSocket relay |
| **Progression** | XP, credits, gear unlocks, challenges, local leaderboard |
| **Learn to ride** | Eight guided steps, each judged on telemetry rather than button presses |
| **Sound** | Fully synthesised — wind, edge, spray, rails, impacts, crashes |

### Look

**The rider** is a freeskier: two skis with their own sidecut and twin-tip
rocker, alloy poles with coloured grips and baskets held at the hands and
trailed back, an oversized shell whose hem hangs to mid-thigh over a hood
bunched at the neck, and boot shells that come well up the shin. The outerwear
is deliberately baggy — those radii are the clothing, not the body, and the
sleeves are nearly as thick as the shoulders they hang off, so the shell reads
as one broad mass with only the gloves telling you where the arms end.

Limbs are tapered tubes between joints, and the caps that close them are
squashed fore-and-aft by the same factor as the tube. That detail matters more
than it sounds: an unflattened cap at the chest is a half-metre sphere that
swallows the neck, the hood and most of the shoulders, and turns a skier into a
snowman.

**The world** is bright and low-poly on purpose: near-white snow with groomer
corduroy, conifers that read as black silhouettes against it, poured-concrete
park features, and a continuous ridged mountain range closing the horizon in
layers that fade into haze.

**The interface** is drawn rather than assembled from defaults.

The wordmark is a set of hand-built outlines — 100-unit cap height, 22-unit
stems, 17-unit horizontals, because horizontals have to be lighter than stems
optically — sprung as elliptical half-arcs straight off the stem and fitted
tight. The same outlines are inlined into `index.html` so the brand is right on
the first painted frame, before a single module loads. There is no `letter-spacing`
on a system font anywhere near it.

Every control is skinned. Sliders and switches are still real `input` elements —
keyboard, screen reader and touch behaviour all come free — but the OS track and
thumb are hidden and the control reports its own fill fraction to CSS. A stock
range widget in a level editor is the clearest possible sign that nobody
designed the panel.

The in-run overlay has no boxes. Readouts sit on the mountain over soft
gradient scrims with the drop shadow doing the legibility work, the way a
broadcast overlay does. Speed is the one thing allowed to shout; grip is a
hairline under it that you feel go red rather than read.

Screens are weighted, not gridded. The title gives Ride a 68 px setting and
everything else 17 px, because seven identically weighted entries make a menu
read as a table of contents. Runs are listed with the difficulty marks every
resort uses — green circle, blue square, black diamond, double diamond — and no
card carries a paragraph explaining what its button does.

**Trail maps** are the part that could not be faked. Each run in the browser
draws a plan view from the level's own feature list — the same coordinates the
sim rides, so a kicker moved in the editor moves on the map. Contours sit at a
50 m vertical interval with their spacing derived from the run's pitch, which is
what a real piste map does and why a steep face stacks them closer. The figures
beside it — vertical drop, length, average pitch, feature count — are computed
from the level, not written down.

The menus render over the live mountain, and the title screen drifts through a
limited arc behind the start gate so the run, the rider and the skyline are
always in frame together — the level you are about to ride, not a still image.

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
| `F` | Plant a pole (skis) |
| `Shift` | Tuck — drops your moment of inertia |
| `Z X C V G H` | Grabs |
| `R` `T` `P` `Esc` | Reset · camera · photo · pause |

**Gamepad.** Left stick steers, right stick trims in the air, right trigger
loads, left bumper plants a pole, face buttons grab.

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
- **Tutorial** — steps advance in order, the carve step refuses to pass a skid no
  matter how far the board is over, and the whole sequence reaches completion.

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
