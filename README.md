# Walk & Fly — Google 3D

Walk the streets or fly like a bird through Google's photorealistic 3D world, in your browser.

**[Try the demo](https://borobaya.github.io/google-maps-walk-and-fly/)** with your own Google API key; there is nothing to install.

Google Maps' own 3D view keeps you in a bird's-eye orbit. This app loads the same 3D buildings, trees and terrain and lets you go anywhere: stand in Trafalgar Square, skim the Thames, or climb above the clouds over Paris.

![Flying up the Thames, through Tower Bridge and round towards the City of London](docs/flythrough.webp)

<sub>A 15-second flight recorded in the app. [Full-quality video](docs/flythrough.mp4).</sub>

![The City of London and the Tower of London from the air](docs/london-aerial.jpg)

| | |
| --- | --- |
| ![The Eiffel Tower from the Champ de Mars](docs/paris-eiffel.jpg) | ![Trafalgar Square at street level](docs/london-street.jpg) |
| Flying over Paris | On foot in Trafalgar Square |

<sub>Imagery: Google, Airbus and the other providers credited in the app.</sub>

## Try the demo

Open <https://borobaya.github.io/google-maps-walk-and-fly/> and paste a Google Maps Platform API key ([how to get one](#1-get-a-google-api-key)). If you restrict the key to websites, add `https://borobaya.github.io/*`.

The key is kept in that browser tab only. It is sent to Google and nowhere else, and it is forgotten when you close the tab. Usage is billed to your key, as described under [What it costs](#what-it-costs).

**On a phone, without the browser's bars:** add the page to your home screen (in Safari: Share → Add to Home Screen; in Chrome on Android: menu → Add to Home screen) and open it from there. Opened that way, the key is remembered on the device until you choose **Change API key**, because every launch would otherwise ask for it again. On Android, iPad and desktop there is also a **Fullscreen** button in the place box.

## Run it yourself

### What you need

- [Node.js](https://nodejs.org) 20.19 or newer (or 22.12 or newer).
- A Google Maps Platform API key. Each person uses their own; there is no shared key.
- A reasonably recent computer, phone or tablet. The clouds are demanding; press `K` to turn them off (they start off on phones).

### 1. Get a Google API key

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and create a project (or pick one).
2. Set up billing on the project. Google requires a billing account even for free usage.
3. Go to [APIs & Services → Library](https://console.cloud.google.com/apis/library), search for **Map Tiles API** and enable it.
4. Go to [APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials), choose **Create credentials → API key** and copy the key.
5. Recommended: edit the key and restrict it.
   - **API restrictions:** Map Tiles API only.
   - **Application restrictions:** Websites, with `http://localhost:5173/*`.

### 2. Run the app

```bash
git clone https://github.com/borobaya/google-maps-walk-and-fly.git
cd google-maps-walk-and-fly
npm install
cp .env.example .env.local
```

Open `.env.local`, paste your key after `VITE_GOOGLE_MAPS_API_KEY=`, then:

```bash
npm run dev
```

Open <http://localhost:5173>. Your browser asks whether the app may use your location: allow it to start above where you are, or refuse to start above the Tower of London.

`.env` and `.env.local` are ignored by git, so your key is never committed.

### What it costs

Google bills Map Tiles usage to the owner of the key. There is a free monthly allowance, and normal exploring uses it slowly, but check [Google's pricing](https://developers.google.com/maps/billing-and-pricing/pricing) and consider setting a budget alert or a daily quota on the key. The Map Tiles API is not available to every billing region; if tiles fail to load, the app shows Google's error.

## Controls

The right hand rests on the arrow keys, the left on W A S D, Space and C. The mouse is optional.

| Key | Walking | Flying |
| --- | --- | --- |
| ↑ ↓ | forward / back | fly forward / back along where you look; let go to stop |
| ← → | turn | turn (the view banks) |
| A D | sidestep | sidestep |
| W S | look up / down | pitch up / down |
| Mouse, button held | drag to look around | drag to look around |
| Shift | run | boost |
| Space | jump | climb; faster the longer you hold |
| C | – | descend, faster the longer you hold; touching the ground lands you |
| Space twice, or F | take off | drop to the ground |
| Scroll | – | change flying speed |
| K | clouds on / off | same |
| H | hide / show the help panel | same |
| U | hide / show the whole interface | same |

Flying speed grows with height, so you can thread streets down low and cross a city up high.

### On a phone or tablet

Held sideways (landscape), it is a two-thumb game, laid out like most mobile games:

| Touch | Walking | Flying |
| --- | --- | --- |
| Drag on the left half | move; a long drag runs | fly; a long drag boosts |
| Drag on the right half | look around | look around |

Held upright (portrait), one thumb does it all:

| Touch | Walking | Flying |
| --- | --- | --- |
| Drag up or down, anywhere | forward / back; a long drag runs | fly forward / back; a long drag boosts |
| Drag left or right | turn | turn |

Upright there is no looking up or down: the view stays level on foot and tilted slightly down in the air, and flying forward keeps your height.

Either way up, three buttons sit on the right edge:

| Button | Walking | Flying |
| --- | --- | --- |
| ▲ | jump | climb; faster the longer you hold |
| ▼ | – | descend, faster the longer you hold; touching the ground lands you |
| Fly / Walk | take off | drop to the ground |

Nothing is drawn for the drags: wherever your thumb lands is the centre, and how far you drag from there sets your pace. **Go to…** at the top right opens the place box and the clouds switch.

### Going places

Use the box at the top right to pick a preset city or type `latitude, longitude` (pasting a Google Maps link also works). The ⌖ **My location** button takes you to where you are, if you allow the browser to say. The address bar keeps your position, so sharing the link takes someone to the same spot.

Where you begin, in order:

1. Where you left off, if you used the app in this browser in the last week. You come back at the same height, facing the same way, and still walking or flying.
2. The place in the link, if you opened one.
3. Your own location, if you let the browser share it.
4. The Tower of London.

Your location and your last position stay in your browser. They are not sent anywhere, except that Google necessarily sees which map tiles you load. Note that the address bar shows your coordinates, so starting at home and then sharing the link shares where you live.

To search by place name as well, also enable the **Maps JavaScript API** and **Geocoding API** on your key (and add them to its API restrictions). Without them the box still accepts coordinates.

## Limits worth knowing

- **Street level is rough.** Google builds this mesh from aerial photos. It looks great from the air; up close, buildings are soft and trees are solid lumps.
- **Coverage is Google's.** Most large cities are in 3D. Elsewhere you get flat satellite-textured terrain, and a few sensitive sites are deliberately flattened.
- **Phones run a lighter version.** Clouds start switched off, the picture is drawn at a lower resolution (and lowered further if frames stay slow), and less of the world is kept in memory. How smooth it is depends on the phone.
- **Typing a place with an iPhone held sideways is blind.** The keyboard fills the screen and covers the box. What you type still works; turning the phone upright lets you see it.
- **Apple's Lockdown Mode blocks it.** Lockdown Mode switches off 3D graphics in Safari on a Mac and in every browser on iPhone and iPad. The page says so and explains how to exclude just this website in Safari. Chrome and other browsers on iPhone and iPad cannot do that, so use Safari there.
- **Lighting is fixed.** One mid-afternoon sun everywhere; there is no night.
- **One texture is fetched from GitHub.** The cloud renderer's noise texture loads from the three-geospatial project's host; everything else is served locally or by Google.

## Putting it online

`npm run build` produces a static site that works at any address. This repository publishes it to GitHub Pages with [a workflow](.github/workflows/pages.yml) on every push to `main`; in a fork, turn it on under **Settings → Pages → Source: GitHub Actions**.

Built without a key (as the workflow does), the site asks each visitor for their own. If you build with your key in `.env.local`, it ships inside the page and every visitor's usage is billed to you: restrict the key to your domain and set a quota. Either way, follow the attribution rules in Google's [Map Tiles API policies](https://developers.google.com/maps/documentation/tile/policies).

## How it works

- `src/world.ts` streams Google Photorealistic 3D Tiles with [3d-tiles-renderer](https://github.com/NASA-AMMOS/3DTilesRendererJS) and keeps your surroundings at the scene origin with +Y up, re-anchoring every kilometre so it works anywhere on Earth.
- `src/player.ts` is the walk and fly controller. Collision is done by casting rays against the loaded tile meshes.
- `src/atmosphere.ts` adds the sky, sunlight, haze and volumetric clouds with [three-geospatial](https://github.com/takram-design-engineering/three-geospatial).
- `src/hud.ts` and `src/main.ts` hold the interface and the render loop.

Built with [three.js](https://threejs.org), [Vite](https://vite.dev) and TypeScript. `npm run build` type-checks and produces a static site in `dist/`.

With `npm run dev` running, `npm run test:touch` drives the touch controls in headless Chrome as a pretend phone and checks them ([tests/touch.mjs](tests/touch.mjs)). It loads real tiles with your key, and needs Node 22.12 or newer and Google Chrome (set `CHROME` to its path if it is not in the usual place). It has only been run on a Mac.

## Licence

The code is released under the [MIT licence](LICENSE). Two sets of bundled files keep their own licences: the Draco decoder in `public/draco/` ([Apache 2.0](public/draco/LICENSE), from Google) and the cloud textures in `public/clouds/` ([MIT](public/clouds/LICENSE), from three-geospatial). The map data is Google's and its providers', used under the [Google Maps Platform terms](https://cloud.google.com/maps-platform/terms); it is not covered by this licence. Nor is the Google Maps logo (`public/google-maps-logo.svg`), which is Google's trademark and is shown unmodified as its attribution rules require.
