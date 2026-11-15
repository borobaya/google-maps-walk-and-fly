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
	yaw: player.yaw, pitch: player.pitch, speed: player.speed, agl: player.heightAboveGround,
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

// the scroll wheel does nothing: no speed change, and neither it nor a trackpad pinch (Ctrl + wheel) scrolls or zooms the page
{

	await page.mouse.move( 640, 400 );
	await page.mouse.wheel( { deltaY: - 400 } );
	await page.keyboard.down( 'Control' );
	await page.mouse.wheel( { deltaY: - 400 } );
	await page.keyboard.up( 'Control' );
	await sleep( 200 );
	check( 'the wheel does not scroll the page', await page.evaluate( () => scrollY === 0 ) );
	// a real pinch's zoom cannot be seen from a test, so check that every wheel over the scene, and a
	// pinch over a panel as well, is held back from the browser (left alone, it would scroll or zoom)
	const held = await page.evaluate( () => {

		const wheel = ( target, ctrlKey ) => ! target.dispatchEvent( new WheelEvent( 'wheel', { deltaY: - 100, ctrlKey, bubbles: true, cancelable: true } ) );
		const canvas = document.querySelector( 'canvas' ), panel = document.querySelector( '.goto' );
		return { scene: wheel( canvas, false ), scenePinch: wheel( canvas, true ), panelPinch: wheel( panel, true ), panelWheel: wheel( panel, false ) };

	} );
	check( 'the wheel and a pinch are held back over the scene, and a pinch over a panel too', held.scene && held.scenePinch && held.panelPinch && ! held.panelWheel, held );

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
check( '↑ walks (4 m/s)', walk > 2.5 && walk < 4.6, + walk.toFixed( 2 ) );
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

// run the streets for a while, turning, and watch that no wall comes closer than the near plane
// (it would be seen through) and that you never lose the ground. Running is a long drag on a
// touch screen, which has no key; the test sets it directly, at the 11 m/s a thumb can reach.
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
	await page.evaluate( () => { player.stick.fast = true; } );
	await page.keyboard.down( 'ArrowUp' );
	for ( let i = 0; i < 6; i ++ ) {

		await sleep( 2000 );
		const turn = i % 2 ? 'ArrowLeft' : 'ArrowRight';
		await page.keyboard.down( turn );
		await sleep( 500 );
		await page.keyboard.up( turn );

	}

	await page.keyboard.up( 'ArrowUp' );
	const w = await page.evaluate( () => { player.stick.fast = false; const w = window.__walk; window.__walk = null; return { ...w, agl: player.heightAboveGround }; } );
	check( 'a long run never sees through a wall or loses the ground', w.frames > 100 && w.worst <= 0.5 && w.lost === 0 && ! w.flew && w.agl < 0.1, w );

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

// --- the clouds switch is a button on a computer too (no key) ---------------------
check( 'the clouds switch shows on a computer', await shown( '.goto .clouds' ) );

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

// asked for less motion: a fast turn in the air neither banks nor widens the view
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
		await page.keyboard.down( 'ArrowUp' ); await page.keyboard.down( 'ArrowLeft' );
		await sleep( 1500 );
		const s = await page.evaluate( () => ( { mode: player.mode, roll: + player.camera.rotation.z.toFixed( 3 ), fov: + player.fov.toFixed( 1 ) } ) );
		await page.keyboard.up( 'ArrowLeft' ); await page.keyboard.up( 'ArrowUp' );
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
	check( 'with less motion asked for, the view neither banks nor widens', Math.abs( usual.roll ) > 0.1 && usual.widened > 2 && Math.abs( calm.roll ) < 0.01 && Math.abs( calm.widened ) < 1, { usual, calm } );

}

const sky = await page.evaluate( () => ( { clouds: atmosphere.cloudsEnabled, noise: !! atmosphere.clouds?.stbnTexture?.image } ) );
check( 'the clouds\' noise texture comes from the site itself', sky.clouds && sky.noise, sky );
check( 'the only other sites contacted are Google\'s', [ ...hosts ].every( h => GOOGLE.includes( h ) ), [ ...hosts ] );
// the view angle never jumps, nor does the speed at which it changes: through taking off,
// flying, stopping and landing it moves like a spring that sets off and arrives gently
{

	await page.evaluate( () => { window.__trace = []; const tick = t => { if ( ! window.__trace ) return; window.__trace.push( [ t, player.fov ] ); requestAnimationFrame( tick ); }; requestAnimationFrame( tick ); } );
	await page.mouse.click( 400, 400 );
	if ( ( await state() ).mode !== 'fly' ) await page.keyboard.press( 'KeyF' );
	await page.keyboard.down( 'ArrowUp' ); await sleep( 2000 );
	await page.keyboard.up( 'ArrowUp' ); await sleep( 1500 );
	await page.keyboard.press( 'KeyF' ); await sleep( 3500 ); // land
	await page.keyboard.press( 'KeyF' ); await sleep( 2000 ); // and take off again
	const smooth = await page.evaluate( () => {

		const t = window.__trace; window.__trace = null;
		// the rate of change at the middle of each frame, then how fast that rate changes, per second:
		// per frame, one slow frame (tiles decoding) would look like a kick when it is not
		const rates = [];
		for ( let i = 1; i < t.length; i ++ ) { const dt = ( t[ i ][ 0 ] - t[ i - 1 ][ 0 ] ) / 1000; if ( dt > 0 ) rates.push( [ ( t[ i ][ 0 ] + t[ i - 1 ][ 0 ] ) / 2000, ( t[ i ][ 1 ] - t[ i - 1 ][ 1 ] ) / dt ] ); }
		const kicks = rates.slice( 1 ).map( ( r, i ) => Math.abs( r[ 1 ] - rates[ i ][ 1 ] ) / ( r[ 0 ] - rates[ i ][ 0 ] ) );
		return { frames: t.length, range: + ( Math.max( ...t.map( x => x[ 1 ] ) ) - Math.min( ...t.map( x => x[ 1 ] ) ) ).toFixed( 1 ), fastest: + Math.max( ...rates.map( r => Math.abs( r[ 1 ] ) ) ).toFixed( 1 ), biggestKick: Math.round( Math.max( ...kicks ) ) };

	} );
	check( 'the view angle changes smoothly: no jump in it, nor in how fast it changes', smooth.range > 5 && smooth.fastest < 40 && smooth.biggestKick < 400, smooth );

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

// --- Street View, with made-up panoramas ---------------------------------------------------
// The 3D tiles are real; every Street View answer is made up here, so nothing of it reaches Google
// (and none of it is billed). Eleven panoramas 4 m apart along Westminster Bridge, the nearest linking the last two.
{

	const LAT = 51.50080, LNG = - 0.12150;
	const ONE_PIXEL = Buffer.from( 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGM446IEAAMSATP56IVbAAAAAElFTkSuQmCC', 'base64' );
	const panos = [ 0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40 ].map( ( d, i ) => ( {
		panoId: 'pano' + i, lat: LAT, lng: LNG - d / ( 111320 * Math.cos( LAT * Math.PI / 180 ) ), heading: 270, tilt: 90, roll: 0,
		imageWidth: 16384, imageHeight: 8192, tileWidth: 512, tileHeight: 512, date: '2024-05', copyright: '© 2024 Google',
		reportProblemLink: 'https://www.google.com/local/imagery/report/?made-up', links: i === 0 ? [ { panoId: 'pano9' }, { panoId: 'pano10' } ] : [],
	} ) );
	const asked = [];
	let answer = 200;
	const sv = await browser.newPage();
	await guard( sv, errors );
	await sv.setRequestInterception( true );
	const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST' };
	const respond = r => {

		const u = new URL( r.url() );
		const street = /\/v1\/streetview\//.test( u.pathname ) || ( u.pathname.endsWith( '/v1/createSession' ) && /streetview/.test( r.postData() ?? '' ) );
		if ( r.method() === 'OPTIONS' && /\/v1\/(streetview|createSession)/.test( u.pathname ) ) return r.respond( { status: 204, headers: cors } );
		if ( ! street ) return r.continue();
		const what = u.pathname.endsWith( 'createSession' ) ? 'session' : u.pathname.split( '/streetview/' )[ 1 ].split( '/' )[ 0 ];
		const tile = u.pathname.match( /tiles\/(\d+)\/(\d+)\/(\d+)/ );
		asked.push( { what, pano: u.searchParams.get( 'panoId' ), y: tile ? + tile[ 3 ] : null, session: u.searchParams.get( 'session' ), t: Date.now() } );
		const json = o => r.respond( { status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify( o ) } );
		if ( answer === 429 ) return r.respond( { status: 429, headers: cors, contentType: 'application/json', body: JSON.stringify( { error: { code: 429, message: "Quota exceeded for quota metric 'Street View Tiles requests' and limit 'Street View Tiles requests per day' (made up)" } } ) } );
		if ( what === 'session' ) return json( { session: 'made-up-session', expiry: String( Math.round( Date.now() / 1000 ) + 14 * 86400 ) } );
		if ( what === 'panoIds' ) return json( { panoIds: panos.slice( 0, 9 ).map( p => p.panoId ) } );
		if ( what === 'metadata' ) return json( panos.find( p => p.panoId === u.searchParams.get( 'panoId' ) ) );
		return new Promise( resolve => setTimeout( resolve, 20 ) ).then( () => r.respond( { status: 200, headers: cors, contentType: 'image/png', body: ONE_PIXEL } ) );

	};
	sv.on( 'request', r => void respond( r ) );
	const warnings = [];
	sv.on( 'console', m => { if ( [ 'warn', 'warning' ].includes( m.type() ) && m.text().startsWith( 'Street View' ) ) warnings.push( m.text() ); } );
	const onFoot = ( lat, lng, heading = 272 ) => sv.evaluate( async ( lat, lng, heading ) => {

		player.teleport( lat, lng );
		await new Promise( r => { const t = setInterval( () => { if ( ! player.settling ) { clearInterval( t ); r(); } }, 100 ); } );
		const ground = world.toLatLng( player.position ).height - player.heightAboveGround;
		player.teleport( lat, lng, { height: ground + 1.7, heading, pitch: 0, mode: 'walk' } );

	}, lat, lng, heading );
	const slots = () => sv.evaluate( () => window.streetview?.debug.slots.filter( s => s.pano ).map( s => ( { pano: s.pano, strength: s.strength } ) ) ?? [] );
	const credit = () => sv.evaluate( () => document.querySelector( '.credits .streetview-credit' )?.textContent || null );

	await sv.goto( `${ process.env.TEST_URL ?? 'http://localhost:5173/' }?profile=desktop#${ LAT },${ LNG }`, { waitUntil: 'domcontentloaded' } );
	await sv.waitForFunction( () => window.player && ! player.settling, { timeout: 90000 } );
	await sv.evaluate( () => { localStorage.removeItem( 'walk-and-fly-streetview-session' ); localStorage.setItem( 'walk-and-fly-streetview', 'off' ); } );
	// facing east, away from them: they stand on tiles out of view, which the renderer leaves out of the scene
	await onFoot( LAT, LNG, 92 );
	await sv.waitForFunction( () => ! player.settling, { timeout: 90000 } );
	await sv.evaluate( () => document.querySelector( '.goto .streetview' ).click() );
	await sv.waitForFunction( () => window.streetview?.debug.slots.filter( s => s.strength > 0.99 ).length >= 6, { timeout: 60000 } ).catch( () => {} );

	const shown = await slots();
	const behind = await sv.evaluate( ( LAT, LNG ) => {

		const street = world.groundBelow( player.position, 0.5 );
		return { street, ground: window.streetview.groundAt( { lat: LAT, lng: LNG - 60 / 69400 }, street ) };

	}, LAT, LNG );
	check( 'Street View finds the ground under a panorama 60 m behind you, out of view', behind.street !== null && behind.ground !== null && Math.abs( behind.ground - behind.street ) < 3, behind );
	check( 'Street View: six photos chosen and shown, nearest first', shown.length === 6 && shown.every( s => s.strength > 0.99 ) && shown[ 0 ].pano === 'pano0', shown );
	const details = asked.filter( a => a.what === 'metadata' ).map( a => a.pano );
	check( '…asking for the details of only 7 of the 11 found: the nearest, its two street neighbours, then four more', details.length === 7 && details[ 0 ] === 'pano0' && details.includes( 'pano9' ) && details.includes( 'pano10' ), details );
	const tiles = asked.filter( a => a.what === 'tiles' );
	const per = {};
	for ( const t of tiles ) per[ t.pano ] = ( per[ t.pano ] ?? 0 ) + 1;
	check( '…24 pieces a photo, the top row (sky) left out', Object.values( per ).every( n => n === 24 ) && ! tiles.some( t => t.y === 0 ), per );
	const span = id => { const ts = tiles.filter( t => t.pano === id ).map( t => t.t ); return [ Math.min( ...ts ), Math.max( ...ts ) ]; };
	const order = shown.map( s => s.pano ).sort( ( a, b ) => span( a )[ 0 ] - span( b )[ 0 ] );
	check( '…downloaded one photo at a time, the nearest first', order[ 0 ] === 'pano0' && order.every( ( id, i ) => i === 0 || span( order[ i - 1 ] )[ 1 ] <= span( id )[ 0 ] ), order.map( id => span( id ).map( v => v - span( 'pano0' )[ 0 ] ) ) );
	const line = await credit();
	check( '…credited on screen with the year, the owner and a way to report a problem', ( line ?? '' ).startsWith( 'Street View 2024 · © 2024 Google' ) && await sv.evaluate( () => [ ...document.querySelectorAll( 'a' ) ].some( a => a.textContent === 'Report a problem' && a.href.includes( 'made-up' ) ) ), line );
	check( '…and one session, remembered on the device for next time', asked.filter( a => a.what === 'session' ).length === 1 && await sv.evaluate( () => localStorage.getItem( 'walk-and-fly-streetview-session' )?.includes( 'made-up-session' ) ), asked.filter( a => a.what === 'session' ).length );

	// switched off: the photos fade and the credit goes with them, nothing more is asked while walking on
	await sv.evaluate( () => document.querySelector( '.goto .streetview' ).click() );
	const before = asked.length;
	await sleep( 1500 );
	await onFoot( LAT, LNG - 25 / 69400 );
	await sleep( 3000 );
	check( 'Street View off: the photos fade out and the credit goes', ( await slots() ).every( s => s.strength === 0 ) && await credit() === null, await slots() );
	check( '…and nothing more is asked of Google, walking on', asked.length === before, asked.slice( before ) );

	// a fresh visit, switched on: the remembered session is used. Google then refuses for the day: asked once, then left alone
	answer = 429;
	await sv.evaluate( () => localStorage.setItem( 'walk-and-fly-streetview', 'on' ) );
	await sv.reload( { waitUntil: 'domcontentloaded' } );
	await sv.waitForFunction( () => window.player && ! player.settling, { timeout: 90000 } );
	const reloaded = asked.length;
	await onFoot( LAT, LNG );
	await sv.waitForFunction( () => window.streetview && ! player.settling, { timeout: 90000 } );
	await sleep( 3000 );
	for ( const d of [ 10, 20, 30 ] ) { await onFoot( LAT, LNG - d / 69400 ); await sleep( 1500 ); }
	const after = asked.slice( reloaded );
	check( 'Street View on a fresh visit uses the remembered session', after.length > 0 && ! after.some( a => a.what === 'session' ) && after.every( a => a.session === 'made-up-session' ), after.map( a => a.what ) );
	check( '…and when Google refuses for the day it is asked once, said once, and then left alone', after.length === 1 && warnings.filter( w => w.includes( 'refused' ) ).length === 1, { asked: after.map( a => a.what ), warnings } );
	// the wait over (made to end now), photos come back without having to walk on
	answer = 200;
	await sv.evaluate( () => { window.streetview.refusedUntil = performance.now(); } );
	await sv.waitForFunction( () => window.streetview.debug.slots.some( s => s.strength > 0.99 ), { timeout: 60000 } ).catch( () => {} );
	check( '…and once the wait is over, the photos come, standing still', ( await slots() ).some( s => s.strength > 0.99 ), await slots() );
	check( 'the Street View credit is a line of Google\'s own credits, above them', await sv.evaluate( () => {

		const line = document.querySelector( '.credits .streetview-credit' );
		return !! line && line.parentElement.firstElementChild === line && line.textContent.startsWith( 'Street View 2024' );

	} ) );
	await sv.close();

}

check( 'no errors on the page', errors.length === 0, errors );
await browser.close();
finish();
