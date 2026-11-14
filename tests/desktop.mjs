// Drives the keyboard and mouse controls in headless Chrome, on a laptop-sized window, and checks
// what they do.
//
//   npm run dev          (in another terminal; needs your API key in .env.local)
//   npm run test:desktop
//
// It loads real tiles, so it needs the network and takes a couple of minutes.
// TEST_URL and CHROME override where the app is served and which browser is used.
import { check, finish, guard, launch, layout, loaded, sleep } from './lib.mjs';

const PAGE = `${ process.env.TEST_URL ?? 'http://localhost:5173/' }?profile=desktop#51.50800,-0.12810`; // Trafalgar Square
const browser = await launch( { width: 1280, height: 720 }, [ '--window-size=1280,720' ] );
const page = await browser.newPage();
const errors = [];
await guard( page, errors );
// every other site the page talks to, with real tiles and clouds on: only Google's are allowed
const GOOGLE = [ 'tile.googleapis.com', 'maps.googleapis.com', 'maps.gstatic.com' ];
const hosts = new Set();
page.on( 'request', r => { const url = new URL( r.url() ); if ( url.protocol.startsWith( 'http' ) && url.origin !== new URL( PAGE ).origin ) hosts.add( url.host ); } );

const state = () => page.evaluate( () => ( {
	mode: player.mode, x: player.position.x, y: player.position.y, z: player.position.z,
	yaw: player.yaw, pitch: player.pitch, speed: player.speed, agl: player.heightAboveGround, flyScale: player.flyScale,
} ) );
/** Holds the keys down for `ms`, then reports how things changed. */
const hold = async ( keys, ms ) => {

	const a = await state();
	for ( const k of keys ) await page.keyboard.down( k );
	await sleep( ms );
	const during = await state();
	for ( const k of [ ...keys ].reverse() ) await page.keyboard.up( k );
	return { a, during, moved: Math.hypot( during.x - a.x, during.z - a.z ), rose: during.y - a.y, turned: during.yaw - a.yaw, tilted: during.pitch - a.pitch };

};
const shown = sel => page.$eval( sel, e => getComputedStyle( e ).display !== 'none' && getComputedStyle( e ).visibility !== 'hidden' );
const boxOpen = () => page.$eval( '.goto', e => e.classList.contains( 'open' ) );

await page.goto( PAGE, { waitUntil: 'domcontentloaded' } );
await page.waitForFunction( () => window.player && ! player.settling, { timeout: 90000 } );
await loaded( page );

// --- what a laptop gets ------------------------------------------------------------
const desk = await page.evaluate( () => ( { touch: document.body.classList.contains( 'touch' ), clouds: atmosphere.cloudsEnabled } ) );
check( 'laptop: full quality with clouds, the help panel and no touch buttons', ! desk.touch && desk.clouds && await shown( '.help' ) && ! await shown( '.pad' ), desk );

// the status and controls panels fade together while you use the keys, and return together
{

	const panels = () => page.evaluate( () => [ '.status', '.help', '.goto' ].map( s => document.querySelector( s ).classList.contains( 'quiet' ) ) );
	await page.mouse.click( 640, 400 );
	await page.keyboard.press( 'KeyW' );
	await sleep( 300 );
	const busy = await panels();
	await sleep( 10500 );
	const rested = await panels();
	check( 'the status, controls and Places panels fade together, and return together after 10 quiet seconds', busy.every( Boolean ) && rested.every( q => ! q ), { busy, rested } );

	// the Places box comes back as soon as the mouse goes to it, and stays while you type in it
	const box = () => page.evaluate( () => ( { quiet: document.querySelector( '.goto' ).classList.contains( 'quiet' ), see: getComputedStyle( document.querySelector( '.goto' ) ).pointerEvents } ) );
	await page.keyboard.press( 'KeyW' );
	await sleep( 300 );
	const faded = await box();
	const r = await page.$eval( '.goto', e => { const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; } );
	await page.mouse.move( r.x, r.y, { steps: 3 } );
	await sleep( 300 );
	const near = await box();
	await page.click( '.goto input' );
	await page.keyboard.type( 'Lon' );
	await page.mouse.move( 640, 600, { steps: 3 } );
	await sleep( 300 );
	const typing = await box();
	check( 'the Places box lets clicks through while faded, returns when the mouse goes to it, and stays while you type', faded.quiet && faded.see === 'none' && ! near.quiet && ! typing.quiet, { faded, near, typing } );
	await page.$eval( '.goto input', e => { e.value = ''; e.blur(); } );

}

// --- every window size: nothing overlaps, nothing falls off the edge, box open or shut ---
{

	const bad = {};
	for ( const [ width, height ] of [ [ 1920, 1080 ], [ 1280, 720 ], [ 1024, 768 ], [ 960, 700 ], [ 921, 700 ], [ 920, 700 ], [ 900, 700 ], [ 861, 700 ], [ 800, 600 ], [ 700, 900 ], [ 641, 700 ], [ 640, 700 ], [ 500, 800 ], [ 400, 700 ], [ 1280, 480 ] ] ) {

		await page.setViewport( { width, height } );
		await page.evaluate( () => { player.hasLooked = false; document.querySelector( '.goto' ).classList.remove( 'open' ); } );
		await sleep( 300 );
		const shut = await layout( page );
		let open = [];
		if ( await shown( '.goto-open' ) ) {

			await page.click( '.goto-open' );
			await sleep( 250 );
			open = await layout( page );

		}

		if ( shut.length || open.length ) bad[ `${ width }x${ height }` ] = { shut, open };

	}

	check( 'every window size from 400 to 1920 wide: nothing overlaps or falls off', Object.keys( bad ).length === 0, bad );
	await page.evaluate( () => document.querySelector( '.goto' ).classList.remove( 'open' ) );
	await page.setViewport( { width: 1280, height: 720 } );
	await sleep( 300 );

}

// --- flying with the keys ------------------------------------------------------------
await page.mouse.click( 640, 400 ); // the scene has the keyboard
let r = await hold( [ 'ArrowUp' ], 1200 );
check( '↑ flies forward', r.moved > 5, + r.moved.toFixed( 1 ) );
await sleep( 1500 );
check( 'letting go stops you', ( await state() ).speed < 1, + ( await state() ).speed.toFixed( 2 ) );
const plain = r.moved;
r = await hold( [ 'ShiftLeft', 'ArrowUp' ], 1200 );
check( 'Shift boosts', r.moved > plain * 1.8, [ + plain.toFixed( 1 ), + r.moved.toFixed( 1 ) ] );
await sleep( 1500 );
r = await hold( [ 'ArrowLeft' ], 600 );
const left = r.turned;
r = await hold( [ 'ArrowRight' ], 600 );
check( '← and → turn either way', left > 0.1 && r.turned < - 0.1, [ + left.toFixed( 2 ), + r.turned.toFixed( 2 ) ] );
r = await hold( [ 'KeyA' ], 800 );
check( 'A and D sidestep without turning', r.moved > 2 && Math.abs( r.turned ) < 0.01, { moved: + r.moved.toFixed( 1 ), turned: r.turned } );
await sleep( 1000 );
r = await hold( [ 'KeyW' ], 400 );
const up = r.tilted;
r = await hold( [ 'KeyS' ], 400 );
check( 'W and S look up and down', up > 0.05 && r.tilted < - 0.05, [ + up.toFixed( 2 ), + r.tilted.toFixed( 2 ) ] );
r = await hold( [ 'Space' ], 1500 );
check( 'Space climbs', r.rose > 3, + r.rose.toFixed( 1 ) );
await sleep( 800 );
r = await hold( [ 'ControlLeft' ], 1200 );
check( 'Ctrl does not descend (it is for shortcuts)', r.rose > - 0.2, + r.rose.toFixed( 2 ) );
r = await hold( [ 'KeyC' ], 1200 );
check( 'C descends', r.rose < - 2, + r.rose.toFixed( 1 ) );
await sleep( 800 );

// the scroll wheel sets flying speed
{

	const before = ( await state() ).flyScale;
	await page.mouse.move( 640, 400 );
	await page.mouse.wheel( { deltaY: - 400 } );
	await sleep( 100 );
	const faster = ( await state() ).flyScale;
	await page.mouse.wheel( { deltaY: 800 } );
	await sleep( 100 );
	const slower = ( await state() ).flyScale;
	check( 'scrolling up flies faster, down slower', faster > before * 1.3 && slower < faster / 1.8, [ before, + faster.toFixed( 2 ), + slower.toFixed( 2 ) ] );
	await page.evaluate( () => { player.flyScale = 1; } );

}

// --- the mouse looks ------------------------------------------------------------
{

	const before = await state();
	const cursor = () => page.$eval( '#view', e => getComputedStyle( e ).cursor );
	await page.mouse.move( 640, 400 );
	const resting = await cursor();
	await page.mouse.down();
	await page.mouse.move( 720, 360, { steps: 5 } );
	await sleep( 100 ); // the interface catches up on the next frame
	const dragging = await cursor();
	await page.mouse.up();
	await sleep( 100 );
	check( 'the pointer is the usual arrow, and hides while you drag to look', resting === 'default' && dragging === 'none' && await cursor() === 'default', { resting, dragging } );
	const after = await state();
	check( 'dragging with the mouse looks around', after.yaw < before.yaw - 0.1 && after.pitch > before.pitch + 0.02, [ + ( after.yaw - before.yaw ).toFixed( 2 ), + ( after.pitch - before.pitch ).toFixed( 2 ) ] );

	// the right button looks too, and a release the page never hears does not leave it steering
	await page.mouse.down( { button: 'right' } );
	const y0 = ( await state() ).yaw;
	await page.mouse.move( 780, 400, { steps: 4 } );
	const y1 = ( await state() ).yaw;
	for ( const x of [ 900, 1000 ] ) await page.evaluate( x => document.getElementById( 'view' ).dispatchEvent( new PointerEvent( 'pointermove', { pointerId: 1, pointerType: 'mouse', buttons: 0, clientX: x, clientY: 400, bubbles: true } ) ), x );
	const y2 = ( await state() ).yaw;
	check( 'the right button looks, and a lost release leaves nothing steering', Math.abs( y1 - y0 ) > 0.05 && y2 === y1 && ! await page.evaluate( () => player.dragging ), [ y0, y1, y2 ] );
	await page.mouse.up( { button: 'right' } );
	check( 'the right-click menu is kept off the scene', await page.evaluate( () => ! document.getElementById( 'view' ).dispatchEvent( new MouseEvent( 'contextmenu', { cancelable: true, bubbles: true } ) ) ) );

}

// --- on foot ----------------------------------------------------------------------
// coming back on foot (a reload while walking), the view is the walking one from the first frame
{

	await page.evaluate( () => player.mode === 'walk' || player.toggleMode() );
	await page.waitForFunction( () => player.mode === 'walk' && player.heightAboveGround < 0.05, { timeout: 60000 } ).catch( () => {} );
	await sleep( 2500 ); // saved every two seconds
	await page.reload( { waitUntil: 'domcontentloaded' } );
	await page.waitForFunction( () => window.player, { timeout: 60000 } );
	const narrowest = await page.evaluate( () => new Promise( resolve => {

		let low = Infinity;
		const tick = () => {

			low = Math.min( low, world.tiles.cameras[ 0 ].fov );
			if ( player.settling ) requestAnimationFrame( tick ); else setTimeout( () => resolve( { low: + low.toFixed( 1 ), mode: player.mode } ), 1500 );

		};
		tick();

	} ) );
	check( 'reloading on foot keeps the walking view throughout, with no zoom', narrowest.mode === 'walk' && narrowest.low > 69, narrowest );
	await loaded( page );
	await page.mouse.click( 640, 400 );

}


// from the same open spot every time, facing north across the square
await page.evaluate( () => { player.teleport( 51.508, - 0.1281 ); player.yaw = Math.PI; } );
await page.waitForFunction( () => ! player.settling, { timeout: 90000 } );
await loaded( page );
await page.keyboard.press( 'KeyF' );
await page.waitForFunction( () => player.mode === 'walk' && player.heightAboveGround < 0.05, { timeout: 60000 } ).catch( () => {} );
check( 'F drops you to the street', await page.evaluate( () => player.mode === 'walk' && player.heightAboveGround < 0.05 ) );
await sleep( 1500 );
r = await hold( [ 'ArrowUp' ], 2000 );
const walk = r.moved / 2;
await sleep( 800 );
r = await hold( [ 'ShiftLeft', 'ArrowUp' ], 2000 );
const run = r.moved / 2;
check( '↑ walks (4 m/s), and Shift runs (11 m/s)', walk > 2.5 && walk < 4.6 && run > 8, [ + walk.toFixed( 2 ), + run.toFixed( 2 ) ] );
await sleep( 800 );
{

	await page.evaluate( () => {

		window.__top = 0;
		const watch = () => { window.__top = Math.max( window.__top, player.heightAboveGround ); if ( window.__top !== null ) requestAnimationFrame( watch ); };
		watch();

	} );
	await hold( [ 'Space' ], 120 ); // a press shorter than a frame could be missed
	await sleep( 1400 );
	const top = await page.evaluate( () => { const t = window.__top; window.__top = null; return t; } );
	const landed = await state();
	check( 'Space jumps and you come back down, still on foot', top > 0.3 && landed.mode === 'walk' && landed.agl < 0.05, [ + top.toFixed( 2 ), landed.mode, + landed.agl.toFixed( 2 ) ] );

}

// walk the streets for a while, turning, and watch that no wall comes closer than the near plane
// (it would be seen through) and that you never lose the ground
{

	await page.evaluate( () => {

		window.__walk = { frames: 0, worst: 0, lost: 0, flew: false };
		const cam = world.tiles.cameras[ 0 ];
		const tick = () => {

			const w = window.__walk;
			if ( ! w ) return;
			w.frames ++;
			w.worst = Math.max( w.worst, cam.near / player.clearance );
			if ( ! Number.isFinite( player.position.y ) ) w.lost ++;
			if ( player.mode !== 'walk' ) w.flew = true;
			requestAnimationFrame( tick );

		};
		tick();

	} );
	await page.keyboard.down( 'ShiftLeft' );
	await page.keyboard.down( 'ArrowUp' );
	for ( let i = 0; i < 6; i ++ ) {

		await sleep( 2000 );
		const turn = i % 2 ? 'ArrowLeft' : 'ArrowRight';
		await page.keyboard.down( turn );
		await sleep( 500 );
		await page.keyboard.up( turn );

	}

	await page.keyboard.up( 'ArrowUp' );
	await page.keyboard.up( 'ShiftLeft' );
	const w = await page.evaluate( () => { const w = window.__walk; window.__walk = null; return { ...w, agl: player.heightAboveGround }; } );
	check( 'a long walk never sees through a wall or loses the ground', w.frames > 100 && w.worst <= 0.5 && w.lost === 0 && ! w.flew && w.agl < 0.1, w );

}

// Space twice takes off
await page.keyboard.press( 'Space' );
await sleep( 120 );
await page.keyboard.press( 'Space' );
await sleep( 500 );
check( 'Space twice takes off', ( await state() ).mode === 'fly' );
await page.keyboard.down( 'Space' );
await sleep( 1500 );
await page.keyboard.up( 'Space' );

// --- H, U ---------------------------------------------------------------------------
await page.keyboard.press( 'KeyH' );
const helpGone = ! await shown( '.help' );
await page.keyboard.press( 'KeyH' );
check( 'H hides and shows the help panel', helpGone && await shown( '.help' ) );
await page.keyboard.press( 'KeyU' );
const bare = await page.evaluate( () => getComputedStyle( document.querySelector( '.status' ) ).display === 'none' || getComputedStyle( document.getElementById( 'ui' ) ).display === 'none' || document.body.classList.contains( 'bare' ) );
await page.keyboard.press( 'KeyU' );
check( 'U hides and shows the whole interface', bare && ! await page.evaluate( () => document.body.classList.contains( 'bare' ) ) );

// --- the place box, by mouse and keyboard -------------------------------------------------
await page.setViewport( { width: 800, height: 600 } ); // narrow enough that the box folds away
await sleep( 300 );
{

	await page.click( '.goto-open' );
	const opened = await boxOpen();
	await page.click( '.goto input' );
	await page.waitForFunction( () => player.speed < 0.01, { timeout: 10000 } ).catch( () => {} ); // done drifting
	const z0 = ( await state() ).z;
	await page.keyboard.down( 'ArrowUp' );
	await sleep( 500 );
	await page.keyboard.up( 'ArrowUp' );
	const typed = await state();
	check( 'typing in the place box does not move you', opened && Math.abs( typed.z - z0 ) < 0.01, { opened, z0, z: typed.z, speed: typed.speed, focus: await page.evaluate( () => document.activeElement?.tagName ) } );
	await page.click( '.goto input', { clickCount: 3 } );
	await page.type( '.goto input', '48.85840, 2.29450' );
	await page.keyboard.press( 'Enter' );
	await sleep( 300 );
	check( 'Enter goes there and puts the box away', ! await boxOpen() && await page.evaluate( () => player.settling ) );
	await page.waitForFunction( () => ! player.settling, { timeout: 90000 } );
	const at = await page.evaluate( () => world.toLatLng( player.position ) );
	check( '…to the coordinates typed', Math.abs( at.lat - 48.8584 ) < 1e-3 && Math.abs( at.lng - 2.2945 ) < 1e-3, [ + at.lat.toFixed( 4 ), + at.lng.toFixed( 4 ) ] );

	// by name, when the key may use Google's geocoder (Maps JavaScript API and Geocoding API)
	await page.click( '.goto-open' );
	await page.click( '.goto input', { clickCount: 3 } );
	await page.type( '.goto input', 'Tower Bridge, London' );
	await page.keyboard.press( 'Enter' );
	await page.waitForFunction( () => player.settling || document.querySelector( '.note' ).textContent, { timeout: 20000 } ).catch( () => {} );
	const refused = await page.$eval( '.note', e => e.textContent );
	if ( refused.includes( 'needs the Maps JavaScript API' ) ) console.log( 'skip a place found by name: this key may not use the Geocoding API' );
	else {

		await page.waitForFunction( () => ! player.settling, { timeout: 90000 } ).catch( () => {} );
		const found = await page.evaluate( () => world.toLatLng( player.position ) );
		check( 'a place typed by name is found and you go there', Math.abs( found.lat - 51.5055 ) < 0.01 && Math.abs( found.lng + 0.0754 ) < 0.01, { note: refused, at: [ + found.lat.toFixed( 4 ), + found.lng.toFixed( 4 ) ] } );

	}

	await page.click( '.goto-open' );
	const yaw = ( await state() ).yaw;
	await page.mouse.move( 400, 400 );
	await page.mouse.down();
	await page.mouse.move( 470, 400, { steps: 4 } );
	await page.mouse.up();
	check( 'clicking the scene puts the box away and still looks', ! await boxOpen() && ( await state() ).yaw < yaw - 0.1 );
	r = await hold( [ 'ArrowUp' ], 800 );
	check( '…and the keys move you again', r.moved > 1, + r.moved.toFixed( 1 ) );

}

// asked for less motion: a boosted turn in the air neither banks nor widens the view
{

	const turn = async () => {

		// level, 300 m up, where height does not change the view: only speed may
		await page.evaluate( () => {

			const here = world.toLatLng( player.position );
			player.teleport( here.lat, here.lng, { height: here.height - player.heightAboveGround + 300, heading: player.heading, pitch: 0, mode: 'fly' } );

		} );
		await page.waitForFunction( () => ! player.settling, { timeout: 90000 } );
		await sleep( 2500 );
		await page.mouse.click( 400, 400 );
		await page.keyboard.down( 'ShiftLeft' ); await page.keyboard.down( 'ArrowUp' ); await page.keyboard.down( 'ArrowLeft' );
		await sleep( 1500 );
		const s = await page.evaluate( () => ( { mode: player.mode, roll: + player.camera.rotation.z.toFixed( 3 ), fov: + player.fov.toFixed( 1 ) } ) );
		await page.keyboard.up( 'ArrowLeft' ); await page.keyboard.up( 'ArrowUp' ); await page.keyboard.up( 'ShiftLeft' );
		await sleep( 2500 );
		// how much wider the view was at speed than once stopped, at the same spot
		s.widened = + ( s.fov - await page.evaluate( () => player.fov ) ).toFixed( 1 );
		return s;

	};
	if ( ( await state() ).mode !== 'fly' ) await page.keyboard.press( 'KeyF' );
	const usual = await turn();
	await page.emulateMediaFeatures( [ { name: 'prefers-reduced-motion', value: 'reduce' } ] );
	const calm = await turn();
	await page.emulateMediaFeatures( [] );
	check( 'with less motion asked for, the view neither banks nor widens', Math.abs( usual.roll ) > 0.1 && usual.widened > 4 && Math.abs( calm.roll ) < 0.01 && Math.abs( calm.widened ) < 1, { usual, calm } );

}

const sky = await page.evaluate( () => ( { clouds: atmosphere.cloudsEnabled, noise: !! atmosphere.clouds?.stbnTexture?.image } ) );
check( 'the clouds\' noise texture comes from the site itself', sky.clouds && sky.noise, sky );
check( 'the only other sites contacted are Google\'s', [ ...hosts ].every( h => GOOGLE.includes( h ) ), [ ...hosts ] );
// the view angle never jumps, nor does the speed at which it changes: through taking off,
// boosting, stopping and landing it moves like a spring that sets off and arrives gently
{

	await page.evaluate( () => { window.__trace = []; const tick = t => { if ( ! window.__trace ) return; window.__trace.push( [ t, player.fov ] ); requestAnimationFrame( tick ); }; requestAnimationFrame( tick ); } );
	await page.mouse.click( 400, 400 );
	if ( ( await state() ).mode !== 'fly' ) await page.keyboard.press( 'KeyF' );
	await page.keyboard.down( 'ShiftLeft' ); await page.keyboard.down( 'ArrowUp' ); await sleep( 2000 );
	await page.keyboard.up( 'ArrowUp' ); await page.keyboard.up( 'ShiftLeft' ); await sleep( 1500 );
	await page.keyboard.press( 'KeyF' ); await sleep( 3500 ); // land
	await page.keyboard.press( 'KeyF' ); await sleep( 2000 ); // and take off again
	const smooth = await page.evaluate( () => {

		const t = window.__trace; window.__trace = null;
		const rates = [];
		for ( let i = 1; i < t.length; i ++ ) { const dt = ( t[ i ][ 0 ] - t[ i - 1 ][ 0 ] ) / 1000; if ( dt > 0 ) rates.push( ( t[ i ][ 1 ] - t[ i - 1 ][ 1 ] ) / dt ); }
		const kicks = rates.slice( 1 ).map( ( r, i ) => Math.abs( r - rates[ i ] ) );
		return { frames: t.length, range: + ( Math.max( ...t.map( x => x[ 1 ] ) ) - Math.min( ...t.map( x => x[ 1 ] ) ) ).toFixed( 1 ), fastest: + Math.max( ...rates.map( Math.abs ) ).toFixed( 1 ), biggestKick: + Math.max( ...kicks ).toFixed( 1 ) };

	} );
	check( 'the view angle changes smoothly: no jump in it, nor in how fast it changes', smooth.range > 5 && smooth.fastest < 40 && smooth.biggestKick < 10, smooth );

}

// flying low, the view is as wide as on foot; it narrows as you climb
{

	const at = async height => {

		await page.evaluate( height => {

			const here = world.toLatLng( player.position );
			player.teleport( here.lat, here.lng, { height: here.height - player.heightAboveGround + height, heading: player.heading, pitch: 0, mode: 'fly' } );

		}, height );
		await page.waitForFunction( () => ! player.settling, { timeout: 90000 } );
		await sleep( 2500 ); // the view eases to its new angle
		return page.evaluate( () => ( { height: Math.round( player.heightAboveGround ), fov: + player.fov.toFixed( 1 ) } ) );

	};
	const low = await at( 8 ), high = await at( 400 );
	check( 'flying low, the view is as wide as walking; high up, narrower', low.height < 25 && low.fov > 62 && high.fov < 51, { low, high } );

}

// The photos are shown as they are, neither lit again nor hazed: a card printed with every grey
// level and four colour ramps, put in front of the camera as a tile would be, must reach the
// screen unchanged
{

	await page.setViewport( { width: 1024, height: 512 } );
	const expected = await page.evaluate( () => {

		if ( atmosphere.cloudsEnabled ) atmosphere.toggleClouds();
		let tile; world.tiles.group.traverse( o => { if ( ! tile && o.isMesh && o.material.map ) tile = o; } );
		const W = 64, H = 8, data = new Uint8Array( W * H * 4 ), expect = [];
		for ( let y = 0; y < H; y ++ ) for ( let x = 0; x < W; x ++ ) {

			const t = Math.round( x / 63 * 255 );
			const rgb = y < 4 ? Array( 3 ).fill( y * 64 + x ) : [ [ t, 255 - t, 40 ], [ 30, t, 255 - t ], [ 255 - t, 60, t ], [ t, t, 255 - t ] ][ y - 4 ];
			data.set( [ ...rgb, 255 ], ( y * W + x ) * 4 );
			expect.push( rgb );

		}

		// built from a tile's own classes and settings, so it is drawn exactly as tiles are
		const map = new tile.material.map.constructor();
		Object.assign( map, { image: { data, width: W, height: H }, isDataTexture: true, flipY: false, generateMipmaps: false, magFilter: 1003, minFilter: 1003, colorSpace: tile.material.map.colorSpace, needsUpdate: true } );
		const material = tile.material.clone();
		material.defines = { ...tile.material.defines }; // clone() leaves out the tile's photo mark
		material.map = map;
		const geometry = new tile.geometry.constructor();
		const Attribute = tile.geometry.attributes.position.constructor;
		geometry.setAttribute( 'position', new Attribute( new Float32Array( [ - 1, - 1, 0, 1, - 1, 0, 1, 1, 0, - 1, 1, 0 ] ), 3 ) );
		geometry.setAttribute( 'uv', new Attribute( new Float32Array( [ 0, 1, 1, 1, 1, 0, 0, 0 ] ), 2 ) );
		geometry.setIndex( [ 0, 1, 2, 0, 2, 3 ] );
		const card = new tile.constructor( geometry, material );
		const camera = world.tiles.cameras[ 0 ];
		card.frustumCulled = false;
		card.onBeforeRender = () => {

			// fill the view, just beyond the camera's near limit, or as far off as asked
			const d = window.__cardDistance ?? camera.near * 1.5, h = Math.tan( camera.fov * Math.PI / 360 ) * d;
			card.position.copy( camera.position );
			card.quaternion.copy( camera.quaternion );
			card.translateZ( - d );
			card.scale.set( h * camera.aspect, h, 1 );
			card.updateMatrixWorld( true );

		};
		world.tiles.group.parent.add( card );
		window.__card = card;
		document.body.classList.add( 'bare' );
		return expect;

	} );
	const read = async () => {

	await sleep( 1500 );
	const shot = await page.screenshot( { encoding: 'base64' } );
	const pixels = await page.evaluate( async ( png, W, H ) => {

		const image = new Image();
		image.src = `data:image/png;base64,${ png }`;
		await image.decode();
		const c = document.createElement( 'canvas' );
		c.width = image.width; c.height = image.height;
		const g = c.getContext( '2d' );
		g.drawImage( image, 0, 0 );
		const got = [];
		for ( let y = 0; y < H; y ++ ) for ( let x = 0; x < W; x ++ ) {

			const d = g.getImageData( Math.floor( ( x + 0.5 ) * c.width / W ), Math.floor( ( y + 0.5 ) * c.height / H ), 1, 1 ).data;
			got.push( [ d[ 0 ], d[ 1 ], d[ 2 ] ] );

		}

		return got;

	}, shot, 64, 8 );
	return Math.max( ...pixels.map( ( got, i ) => Math.max( ...got.map( ( v, k ) => Math.abs( v - expected[ i ][ k ] ) ) ) ) );

	};
	const near = await read();
	// and 2 km away, 400 m up and looking up, so that nothing can be in between
	await page.evaluate( async () => {

		const here = world.toLatLng( player.position );
		player.teleport( here.lat, here.lng, { height: here.height - player.heightAboveGround + 400, heading: player.heading, pitch: 0, mode: 'fly' } );
		// arriving waits for the ground in view, so arrive looking level, then look up
		while ( player.settling ) await new Promise( r => setTimeout( r, 100 ) );
		player.pitch = 0.7;
		window.__cardDistance = 2000;

	} );
	const far = await read();
	check( 'photos reach the screen unchanged, close by and 2 km away: all 512 test colours, to the level', near === 0 && far === 0, { near, far } );
	await page.evaluate( () => {

		window.__card.removeFromParent();
		delete window.__cardDistance;
		document.body.classList.remove( 'bare' );

	} );
	await page.setViewport( { width: 800, height: 600 } );

}

check( 'no errors on the page', errors.length === 0, errors );
await browser.close();
finish();
