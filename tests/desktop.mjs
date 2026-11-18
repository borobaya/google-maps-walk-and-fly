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

// P shows and hides the debug figures above the credits; a "p" typed into the place box does not
{

	const figures = () => page.evaluate( () => {

		const panel = document.querySelector( '.credits .debug' );
		return panel && ! panel.hidden ? [ ...panel.children ].map( d => d.textContent ) : null;

	} );
	await page.mouse.click( 640, 400 );
	await page.keyboard.press( 'KeyP' );
	await page.waitForFunction( () => document.querySelector( '.credits .debug' )?.children.length > 0, { timeout: 15000 } ).catch( () => {} );
	await sleep( 1200 ); // a second of frames to count
	const on = await figures();
	check( 'P shows the debug figures above the credits', !! on && /\d+ fps/.test( on[ 0 ] ) && on.some( l => l.startsWith( '3D tiles:' ) ) && on.some( l => /^Asked of Google this visit: [\d,]{4,} 3D tiles/.test( l ) )
		&& await page.evaluate( () => document.querySelector( '.credits' ).firstElementChild.classList.contains( 'debug' ) ), on );
	check( '…with the key\'s quotas by their Cloud Console names', !! on && on.some( l => /^3D Tiles renderer requests per minute: [\d,]+ of 12,000 \(/.test( l ) ) && on.some( l => /^3D Tiles root requests per day: \d+ of 10,000 /.test( l ) ) && /^Street View Tiles requests per day: [\d,]+ of 15,000 \(\d+%\)$/.test( on.at( - 1 ) ), on );
	await sleep( 2500 ); // saved every two seconds
	const stored = await page.evaluate( () => JSON.parse( localStorage.getItem( 'walk-and-fly-requests-today' ) ?? 'null' ) );
	check( '…and today\'s count is kept in the browser, by Pacific day, with no key in it', !! stored && /^\d{4}-\d\d-\d\d$/.test( stored.day ) && stored.counts.tiles > 1000 && ! JSON.stringify( stored ).includes( 'key' ), stored );
	await page.keyboard.press( 'KeyP' );
	const off = await figures();
	// pressing P was using the keys, so the box has faded and lets clicks through: focus it directly
	await page.$eval( '.goto input', e => e.focus() );
	await page.keyboard.type( 'p' );
	const typed = await figures();
	await page.$eval( '.goto input', e => { e.value = ''; e.blur(); } );
	check( '…P again hides them, and a "p" typed as part of a place name does not', off === null && typed === null, { off, typed } );
	// the mouse held on the compass for a second does the same; a click does nothing
	const c = await page.$eval( '.compass', e => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; } );
	await page.mouse.click( c.x, c.y );
	await sleep( 1300 );
	const clicked = await figures();
	await page.mouse.move( c.x, c.y ); await page.mouse.down(); await sleep( 1300 ); await page.mouse.up();
	const held = await figures();
	await page.mouse.move( c.x, c.y ); await page.mouse.down(); await sleep( 1300 ); await page.mouse.up();
	const again = await figures();
	check( '…holding the mouse on the compass a second shows them, and again hides them; a click does nothing', clicked === null && held !== null && again === null, { clicked, held, again } );

}

// a two-finger swipe over the scene moves you (down: forward, up: back); a double click goes part of the way to what was clicked
{

	const across = ( a, b, yaw ) => ( {
		ahead: ( b.x - a.x ) * - Math.sin( yaw ) + ( b.z - a.z ) * - Math.cos( yaw ),
		right: ( b.x - a.x ) * Math.cos( yaw ) + ( b.z - a.z ) * - Math.sin( yaw ),
		total: Math.hypot( b.x - a.x, b.z - a.z ),
	} );
	// flying speed is the height above the ground each second: low down, a swipe does not carry the scene past its re-anchoring
	await page.evaluate( () => {

		const here = world.toLatLng( player.position );
		player.teleport( here.lat, here.lng, { height: here.height - player.heightAboveGround + 40, heading: player.heading, pitch: 0, mode: 'fly' } );

	} );
	await page.waitForFunction( () => ! player.settling, { timeout: 90000 } );
	await sleep( 2500 );
	const swipe = async deltaY => { for ( let i = 0; i < 12; i ++ ) { await page.mouse.wheel( { deltaY } ); await sleep( 50 ); } await sleep( 900 ); };
	await page.mouse.move( 640, 400 );
	const s0 = await state();
	await swipe( 40 );
	const s1 = await state();
	await swipe( - 40 );
	const s2 = await state();
	const fwd = across( s0, s1, s0.yaw ), back = across( s1, s2, s0.yaw );
	check( 'a two-finger swipe up moves you forward, and down moves you back', fwd.ahead > 3 && back.ahead < - 1.5 && Math.abs( fwd.right ) < 0.5, { fwd, back } );
	// a harder swipe goes faster still
	await sleep( 1000 );
	const h0 = await state();
	await swipe( 100 );
	const hard = across( h0, await state(), h0.yaw );
	check( '…and a harder swipe goes faster still', hard.ahead > fwd.ahead * 1.5, { hard, fwd } );
	await sleep( 1500 );
	const still = await state();
	const sideways = async deltaX => { for ( let i = 0; i < 12; i ++ ) { await page.mouse.wheel( { deltaX } ); await sleep( 50 ); } await sleep( 900 ); };
	await sideways( - 40 );
	const s3 = await state();
	await sideways( 40 );
	const s4 = await state();
	const right = across( still, s3, still.yaw ), left = across( s3, s4, still.yaw );
	check( '…a swipe right steps aside to the right, and left steps back', right.right > 3 && left.right < - 3 && Math.abs( right.ahead ) < 0.5, { right, left } );
	// fingers wander: a tiny sideways drift in a swipe down is not a step aside
	await sleep( 800 );
	const d0 = await state();
	for ( let i = 0; i < 12; i ++ ) { await page.mouse.wheel( { deltaY: 40, deltaX: 6 } ); await sleep( 50 ); }
	await sleep( 900 );
	const drift = across( d0, await state(), d0.yaw );
	check( '…and a stray bit of sideways in a swipe down is ignored', drift.ahead > 3 && Math.abs( drift.right ) < 0.5, drift );

	await sleep( 1500 );
	const before = await state();
	await page.mouse.click( 1000, 360 );
	await sleep( 1000 );
	const single = across( before, await state(), before.yaw );
	check( 'a single click moves nothing', single.total < 0.5, single );
	await page.mouse.click( 1000, 360, { count: 2 } );
	await sleep( 5000 );
	const after = await state();
	const gone = across( before, after, before.yaw );
	check( 'a double click goes part of the way toward the spot clicked: to the right of where you face', gone.right > 3 && gone.total > 3, gone );
	check( '…and then stops', after.speed < 1 && across( after, await state(), before.yaw ).total < 1.5, after.speed );

}

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
await page.evaluate( () => { player.pitch = - 0.6; } );
r = await hold( [ 'ArrowUp' ], 1000 );
check( 'flying forward while looking down keeps your height', r.moved > 3 && Math.abs( r.rose ) < 1, { moved: + r.moved.toFixed( 1 ), rose: + r.rose.toFixed( 2 ) } );
await sleep( 1200 );
r = await hold( [ 'Space' ], 1500 );
check( 'Space climbs', r.rose > 3, + r.rose.toFixed( 1 ) );
await sleep( 800 );
r = await hold( [ 'ControlLeft' ], 1200 );
check( 'Ctrl does not descend (it is for shortcuts)', r.rose > - 0.2, + r.rose.toFixed( 2 ) );
r = await hold( [ 'KeyC' ], 1200 );
check( 'C descends', r.rose < - 2, + r.rose.toFixed( 1 ) );
await sleep( 800 );

// the scroll wheel never scrolls or zooms the page: neither it nor a trackpad pinch (Ctrl + wheel) scrolls or zooms the page
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

// a fast turn in the air neither banks nor widens the view, whatever the device's motion setting
{

	const turn = async () => {

		// level, 300 m up, where height does not change the view: only speed or turning could
		await page.evaluate( () => {

			const here = world.toLatLng( player.position );
			player.teleport( here.lat, here.lng, { height: here.height - player.heightAboveGround + 300, heading: player.heading, pitch: 0, mode: 'fly' } );

		} );
		await page.waitForFunction( () => ! player.settling, { timeout: 90000 } );
		await sleep( 2500 );
		const rest = await page.evaluate( () => player.fov );
		await page.mouse.click( 400, 400 );
		await page.keyboard.down( 'ArrowUp' ); await page.keyboard.down( 'ArrowLeft' );
		await sleep( 1500 );
		const s = await page.evaluate( () => ( { mode: player.mode, roll: + player.camera.rotation.z.toFixed( 3 ), fov: + player.fov.toFixed( 1 ) } ) );
		await page.keyboard.up( 'ArrowLeft' ); await page.keyboard.up( 'ArrowUp' );
		s.widened = + ( s.fov - rest ).toFixed( 1 );
		return s;

	};
	if ( ( await state() ).mode !== 'fly' ) await page.keyboard.press( 'KeyF' );
	const flying = await turn();
	check( 'a fast turn while flying does not bank or widen the view', flying.mode === 'fly' && Math.abs( flying.roll ) < 0.01 && Math.abs( flying.widened ) < 1, flying );

}

// flying: looking down never changes your height, a double click keeps the line clicked, and hovering costs little
{

	const flatState = () => page.evaluate( () => ( { x: player.position.x, y: player.position.y, z: player.position.z, mode: player.mode } ) );
	const rise = ( a, b ) => ( { moved: Math.hypot( b.x - a.x, b.z - a.z ), rose: b.y - a.y } );
	const goUp = async ( height, pitch, at = null ) => {

		await page.evaluate( ( height, pitch, at ) => {

			const here = world.toLatLng( player.position );
			player.teleport( at?.lat ?? here.lat, at?.lng ?? here.lng, { height: here.height - player.heightAboveGround + height, heading: player.heading, pitch, mode: 'fly' } );

		}, height, pitch, at );
		await page.waitForFunction( () => ! player.settling, { timeout: 90000 } );
		await sleep( 2500 );

	};
	await goUp( 300, - 0.6 );
	await page.mouse.click( 640, 400 );
	await page.mouse.move( 640, 400 );

	// a swipe goes level too
	const w0 = await flatState();
	for ( let i = 0; i < 12; i ++ ) { await page.mouse.wheel( { deltaY: 40 } ); await sleep( 50 ); }
	await sleep( 900 );
	const swiped = rise( w0, await flatState() );
	check( 'a swipe while looking down keeps your height', swiped.moved > 3 && Math.abs( swiped.rose ) < 1, swiped );

	// a double click on the ground below goes down the line clicked, not flatter
	await sleep( 1500 );
	const g0 = await flatState();
	await page.mouse.click( 640, 400, { count: 2 } );
	const dir = await page.evaluate( () => player.glide ? { x: player.glide.dir.x, y: player.glide.dir.y, z: player.glide.dir.z } : null );
	await page.waitForFunction( () => ! player.glide, { timeout: 20000 } ).catch( () => {} );
	await sleep( 1500 );
	const g1 = await flatState();
	const way = { x: g1.x - g0.x, y: g1.y - g0.y, z: g1.z - g0.z };
	const length = Math.hypot( way.x, way.y, way.z );
	const cos = dir ? ( way.x * dir.x + way.y * dir.y + way.z * dir.z ) / ( length || 1 ) : 0;
	check( 'a double click down at the ground goes along the line clicked', !! dir && dir.y < - 0.3 && length > 20 && cos > 0.97, { dir, way, cos: + cos.toFixed( 3 ) } );

	// hovering asks the world few questions (the clearance rays run ten times a second, not every frame), moving asks them all
	await sleep( 1500 );
	const rays = ms => page.evaluate( ms => new Promise( done => {

		let n = 0, frames = 0;
		const cast = world.cast;
		world.cast = function ( ...args ) { n ++; return cast.apply( this, args ); };
		const count = () => { frames ++; if ( performance.now() - t0 < ms ) requestAnimationFrame( count ); };
		const t0 = performance.now();
		requestAnimationFrame( count );
		setTimeout( () => { world.cast = cast; done( { perFrame: + ( n / frames ).toFixed( 2 ), frames } ); }, ms + 50 );

	} ), ms );
	const hovering = await rays( 1500 );
	await page.keyboard.down( 'ArrowUp' );
	const moving = await rays( 1500 );
	await page.keyboard.up( 'ArrowUp' );
	check( 'hovering casts far fewer rays per frame than flying', hovering.perFrame < 3 && moving.perFrame > 5, { hovering, moving } );

	// and hovering against a wall still pushes you off it, within a fraction of a second
	let found = null;
	for ( const height of [ 20, 40, 70 ] ) {

		await goUp( height, 0, { lat: 51.508, lng: - 0.1281 } ); // Trafalgar Square again, with buildings around it
		found = await page.evaluate( () => {

			for ( let a = 0; a < 16; a ++ ) {

				player.yaw = a * Math.PI / 8;
				const hit = world.cast( player.position, player.position.clone().set( - Math.sin( player.yaw ), 0, - Math.cos( player.yaw ) ), 120 );
				if ( hit ) return { yaw: player.yaw, distance: hit.distance };

			}
			return null;

		} );
		if ( found ) break;

	}
	if ( found ) {

		// (a finer tile may swap in under it while it hovers there, moving the wall: it is tried up to three times)
		const after = await page.evaluate( async found => {

			player.yaw = found.yaw;
			let pushed = 0;
			for ( let attempt = 0; attempt < 3 && ! ( pushed > 0.5 ); attempt ++ ) {

				const ahead = player.position.clone().set( - Math.sin( found.yaw ), 0, - Math.cos( found.yaw ) );
				const hit = world.cast( player.position, ahead, 150 );
				if ( ! hit ) break;
				player.position.addScaledVector( ahead, hit.distance - 0.3 );
				player.velocity.set( 0, 0, 0 );
				const start = player.position.clone();
				await new Promise( r => setTimeout( r, 500 ) );
				// how far it has been pushed back from the wall: it should be the 0.7 m that makes up a metre
				pushed = + ( - player.position.clone().sub( start ).dot( ahead ) ).toFixed( 2 );

			}
			return pushed;

		}, found );
		check( 'hovering 0.3 m from a wall is pushed back out to a metre', after > 0.5 && after < 1.5, { found, pushedBack: after } );

	} else check( 'hovering 0.3 m from a wall is pushed back out to a metre', false, 'no wall found within 120 m at 20, 40 or 70 m up' );
	// back up high and level, where the checks that follow found you before this one
	await goUp( 300, 0 );

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

	// The height is set from the ground measured where you are. High up, that is the coarse tiles,
	// which can turn something tall and thin (Nelson's Column) into a blob 40 m above the street; once
	// the detailed ones arrive the ground is the street. So set the height once more from down there.
	const at = async height => {

		for ( let tries = 0; tries < 3; tries ++ ) {

			await page.evaluate( height => {

				const here = world.toLatLng( player.position );
				player.teleport( here.lat, here.lng, { height: here.height - player.heightAboveGround + height, heading: player.heading, pitch: 0, mode: 'fly' } );

			}, height );
			await page.waitForFunction( () => ! player.settling, { timeout: 90000 } );
			await sleep( 2500 ); // the view eases to its new angle, and the tiles below refine
			if ( Math.abs( await page.evaluate( () => player.heightAboveGround ) - height ) < 5 ) break;

		}

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
// (and none of it is billed). Eleven of Google's panoramas 4 m apart along Westminster Bridge, the
// nearest linking the last two, and a visitor's upload where you stand, as at any sight. Google's own
// have 22-character IDs: here 'pano0' and so on, filled out with underscores (left off in the checks).
{

	const LAT = 51.50080, LNG = - 0.12150;
	const ONE_PIXEL = Buffer.from( 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGM446IEAAMSATP56IVbAAAAAElFTkSuQmCC', 'base64' );
	const panos = [ 0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40 ].map( ( d, i ) => ( {
		panoId: ( 'pano' + i ).padEnd( 22, '_' ), lat: LAT, lng: LNG - d / ( 111320 * Math.cos( LAT * Math.PI / 180 ) ), heading: 270, tilt: 90, roll: 0,
		imageWidth: 16384, imageHeight: 8192, tileWidth: 512, tileHeight: 512, date: '2024-05', copyright: '© 2024 Google',
		reportProblemLink: 'https://www.google.com/local/imagery/report/?made-up', links: i === 0 ? [ { panoId: 'pano9'.padEnd( 22, '_' ) }, { panoId: 'pano10'.padEnd( 22, '_' ) } ] : [],
	} ) );
	const UPLOAD = 'CAoSFkNJSE0wb2dLRUlDQWdJQ01zdV9PZnc.';
	const asked = [];
	let answer = 200;
	// the first search is answered with nothing at all, as Google sometimes does
	let nothingOnce = true;
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
		asked.push( { what, pano: u.searchParams.get( 'panoId' )?.replace( /_+$/, '' ), y: tile ? + tile[ 3 ] : null, session: u.searchParams.get( 'session' ), t: Date.now() } );
		const json = o => r.respond( { status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify( o ) } );
		if ( answer === 429 ) return r.respond( { status: 429, headers: cors, contentType: 'application/json', body: JSON.stringify( { error: { code: 429, message: "Quota exceeded for quota metric 'Street View Tiles requests' and limit 'Street View Tiles requests per day' (made up)" } } ) } );
		if ( what === 'session' ) return json( { session: 'made-up-session', expiry: String( Math.round( Date.now() / 1000 ) + 14 * 86400 ) } );
		if ( what === 'panoIds' && nothingOnce ) { nothingOnce = false; return json( {} ); }
		if ( what === 'panoIds' ) return json( { panoIds: [ UPLOAD, ...panos.slice( 0, 9 ).map( p => p.panoId ) ] } );
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
	const slots = () => sv.evaluate( () => window.streetview?.debug.slots.filter( s => s.pano ).map( s => ( { pano: s.pano.replace( /_+$/, '' ), strength: s.strength } ) ) ?? [] );
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
	// with the debug panel on (P), an orb glows where each shown photo was taken from; off, none
	const orbs = () => sv.evaluate( () => window.streetview.orbs.filter( o => o.visible ).length );
	const orbsOff = await orbs();
	await sv.mouse.click( 640, 400 );
	await sv.keyboard.press( 'KeyP' );
	await sleep( 600 );
	const orbsOn = await orbs();
	await sv.keyboard.press( 'KeyP' );
	await sleep( 600 );
	check( 'Street View: P puts an orb at each photo\'s centre, and takes them away again', orbsOff === 0 && orbsOn === 6 && await orbs() === 0, { orbsOff, orbsOn, after: await orbs() } );
	const details = asked.filter( a => a.what === 'metadata' ).map( a => a.pano );
	const searches = asked.filter( a => a.what === 'panoIds' ).length;
	check( '…after a first search answered with nothing, tried again standing still', ! nothingOnce && searches === 2 && warnings.some( w => w.includes( 'answered the search with nothing' ) ), { searches, warnings } );
	check( '…passing over the visitor\'s upload without asking about it', ! details.includes( UPLOAD ), details );
	check( '…asking for the details of only 7 of the 11 found: the nearest, its two street neighbours, then four more', details.length === 7 && details[ 0 ] === 'pano0' && details.includes( 'pano9' ) && details.includes( 'pano10' ), details );
	const tiles = asked.filter( a => a.what === 'tiles' );
	const per = {};
	for ( const t of tiles ) per[ t.pano ] = ( per[ t.pano ] ?? 0 ) + 1;
	check( '…24 pieces a photo, the top row (sky) left out', Object.values( per ).every( n => n === 24 ) && ! tiles.some( t => t.y === 0 ), per );
	const span = id => { const ts = tiles.filter( t => t.pano === id ).map( t => t.t ); return [ Math.min( ...ts ), Math.max( ...ts ) ]; };
	const order = shown.map( s => s.pano ).sort( ( a, b ) => span( a )[ 0 ] - span( b )[ 0 ] );
	check( '…downloaded one photo at a time, the nearest first', order[ 0 ] === 'pano0' && order.every( ( id, i ) => i === 0 || span( order[ i - 1 ] )[ 1 ] <= span( id )[ 0 ] ), order.map( id => span( id ).map( v => v - span( 'pano0' )[ 0 ] ) ) );
	const line = await credit();
	check( '…credited on screen with the copyright and a way to report a problem', ( line ?? '' ).startsWith( '© 2024 Google · Report problem' ) && await sv.evaluate( () => [ ...document.querySelectorAll( 'a' ) ].some( a => a.textContent === 'Report problem' && a.href.includes( 'made-up' ) ) ), line );
	check( '…and one session, remembered on the device for next time', asked.filter( a => a.what === 'session' ).length === 1 && await sv.evaluate( () => localStorage.getItem( 'walk-and-fly-streetview-session' )?.includes( 'made-up-session' ) ), asked.filter( a => a.what === 'session' ).length );

	// flying: nothing is asked of Google, but the photos already held stay (and are chosen again from memory as you move)
	const beforeFly = asked.length;
	await sv.evaluate( () => player.toggleMode() );
	await sleep( 2500 );
	const flying = await sv.evaluate( () => ( { mode: player.mode, what: window.streetview.status.what } ) );
	check( 'Street View flying: nothing is asked of Google, and the photos already held stay shown', flying.mode === 'fly' && flying.what.startsWith( 'flying' ) && asked.length === beforeFly && ( await slots() ).filter( s => s.strength > 0.99 ).length === 6, { flying, asked: asked.slice( beforeFly ), shown: await slots() } );
	// switched off and on again while flying, standing still: the photos held come straight back
	await sv.evaluate( () => document.querySelector( '.goto .streetview' ).click() );
	await sleep( 2500 );
	const gone = ( await slots() ).filter( s => s.strength > 0.01 ).length;
	await sv.evaluate( () => document.querySelector( '.goto .streetview' ).click() );
	await sleep( 3500 );
	const back = ( await slots() ).filter( s => s.strength > 0.99 ).length;
	check( 'Street View flying, switched off and on again without moving: the photos held return, with nothing asked', gone === 0 && back === 6 && asked.length === beforeFly, { gone, back, asked: asked.slice( beforeFly ) } );
	await sv.evaluate( () => player.toggleMode() );
	await sleep( 500 );

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
		return !! line && line.parentElement.firstElementChild === line && line.textContent.startsWith( '© 2024 Google' );

	} ) );
	await sv.close();

}

check( 'no errors on the page', errors.length === 0, errors );
await browser.close();
finish();
