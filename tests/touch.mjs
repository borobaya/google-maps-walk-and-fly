// Drives the touch controls in headless Chrome, pretending to be a phone, and checks what they do.
//
//   npm run dev          (in another terminal; needs your API key in .env.local)
//   npm run test:touch
//
// It loads real tiles, so it needs the network and takes a couple of minutes.
// TEST_URL and CHROME override where the app is served and which browser is used.
import { LANDSCAPE, PORTRAIT, SHORT, check, finish, guard, launch, layout as layoutOf, loaded as loadedOn, sleep } from './lib.mjs';

const PAGE = `${ process.env.TEST_URL ?? 'http://localhost:5173/' }?profile=phone#51.50800,-0.12810`; // Trafalgar Square: open, level ground
const browser = await launch( PORTRAIT, [ '--window-size=390,844' ] );
// the browser will say we are at the Sydney Opera House, for the My location button
await browser.defaultBrowserContext().overridePermissions( new URL( PAGE ).origin, [ 'geolocation' ] );
const page = await browser.newPage();
await page.setGeolocation( { latitude: - 33.8568, longitude: 151.2153 } );
const errors = [];
await guard( page, errors );
const cdp = await page.createCDPSession();

// several fingers at once: keep the set that is down and send it whole each time
const fingers = new Map();
const send = type => cdp.send( 'Input.dispatchTouchEvent', { type, touchPoints: [ ...fingers ].map( ( [ id, p ] ) => ( { id, x: p.x, y: p.y } ) ) } );
const down = async ( id, x, y ) => { fingers.set( id, { x, y } ); await send( 'touchStart' ); };
const move = async ( id, x, y, steps = 6 ) => {

	const from = { ...fingers.get( id ) };
	for ( let i = 1; i <= steps; i ++ ) {

		fingers.set( id, { x: from.x + ( x - from.x ) * i / steps, y: from.y + ( y - from.y ) * i / steps } );
		await send( 'touchMove' );
		await sleep( 16 );

	}

};
// lifting one finger: Chrome's touchEnd names the fingers that leave, not the ones that stay
const up = async id => {

	const { x, y } = fingers.get( id );
	fingers.delete( id );
	await cdp.send( 'Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [ { id, x, y } ] } );

};
const tap = ( x, y ) => page.touchscreen.tap( x, y );
const centre = sel => page.$eval( sel, e => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; } );
const shown = sel => page.$eval( sel, e => getComputedStyle( e ).display !== 'none' && getComputedStyle( e ).visibility !== 'hidden' );
const state = () => page.evaluate( () => ( {
	mode: player.mode, one: player.oneThumb, stick: { ...player.stick },
	speed: + player.speed.toFixed( 1 ), yaw: + player.yaw.toFixed( 3 ), pitch: + player.pitch.toFixed( 2 ),
	y: + player.position.y.toFixed( 1 ), agl: + player.heightAboveGround.toFixed( 2 ),
} ) );
const layout = () => layoutOf( page );
const loaded = () => loadedOn( page );

await page.goto( PAGE, { waitUntil: 'domcontentloaded' } );
await page.waitForFunction( () => window.player && ! player.settling, { timeout: 90000 } );
await loaded();

// --- what a phone gets -------------------------------------------------------
const profile = await page.evaluate( () => {

	const box = sel => document.querySelector( sel ).getBoundingClientRect();
	const hint = box( '.hint' ), status = box( '.status' ), compass = box( '.compass' );
	const overlaps = ( a, b ) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
	return {
		touch: document.body.classList.contains( 'touch' ),
		clouds: atmosphere.cloudsEnabled,
		hint: document.querySelector( '.hint' ).textContent,
		hintOverlaps: overlaps( hint, status ) || overlaps( hint, compass ),
	};

} );
check( 'phone profile: buttons shown, clouds off', profile.touch && ! profile.clouds && await shown( '.pad' ), profile );
check( 'portrait hint', profile.hint === 'Drag to move and turn', profile.hint );
check( 'hint is clear of the status panel and compass', ! profile.hintOverlaps );

// --- portrait: one thumb moves and turns -------------------------------------
await page.evaluate( () => { window.__prevented = null; document.addEventListener( 'touchstart', e => { window.__prevented = e.defaultPrevented; } ); } );
const a = await state();
await down( 1, 250, 600 ); // on the right half, which in landscape would look
await move( 1, 254, 545 );
await sleep( 2000 );
const b = await state();
check( 'a touch on the scene is claimed (no edge swipe, scroll or zoom)', await page.evaluate( () => window.__prevented ) === true );
check( 'portrait: drag up goes straight ahead', b.one && b.stick.z > 0.8 && b.stick.turn === 0 && ! b.stick.fast && b.speed > 5 && Math.abs( b.yaw - a.yaw ) < 0.01, b );
await move( 1, 350, 545 ); // 100px sideways: a hard turn, 114px from where the thumb landed
await sleep( 1200 );
const c = await state();
check( 'portrait: leaning the drag turns', c.stick.turn === 1 && c.yaw < b.yaw - 0.5, c );
check( 'portrait: a wide turn is not a boost', ! c.stick.fast, c.stick );
check( 'portrait: flying stays level', Math.abs( c.y - b.y ) < 5, c.y - b.y );
await move( 1, 254, 480 ); // 120px forward
await sleep( 300 );
check( 'portrait: a long forward drag boosts', ( await state() ).stick.fast );
await up( 1 );
await sleep( 1500 );
const d = await state();
check( 'letting go stops you', d.stick.z === 0 && d.stick.turn === 0 && ! d.stick.fast && d.speed < 1, d );

// the status panel steps aside while you steer, and comes back after ten quiet seconds
const quiet = () => page.evaluate( () => ( { quiet: document.querySelector( '.status' ).classList.contains( 'quiet' ), opacity: + getComputedStyle( document.querySelector( '.status' ) ).opacity } ) );
const q1 = await quiet();
await sleep( 8000 );
const q2 = await quiet();
await down( 1, 200, 600 ); // a long hold keeps it away however long it lasts
await sleep( 3000 );
const q3 = await quiet();
await up( 1 );
await sleep( 9000 );
const q4 = await quiet();
await sleep( 1800 );
const q5 = await quiet();
check( 'the status panel fades while you steer', q1.quiet && q1.opacity < 0.05, q1 );
check( 'it stays away for ten seconds after the last touch, and while a thumb is held', q2.quiet && q3.quiet && q4.quiet, [ q2, q3, q4 ] );
check( 'it comes back after ten quiet seconds', ! q5.quiet && q5.opacity > 0.95, q5 );

// an on-screen keyboard makes the window wider than tall; the phone is still upright
await page.setViewport( { ...PORTRAIT, height: 300 } );
await sleep( 400 );
await down( 1, 100, 150 );
check( 'portrait survives the on-screen keyboard', ( await state() ).one );
await up( 1 );
await page.setViewport( PORTRAIT );
await sleep( 800 );

// --- the folded go-to box ---------------------------------------------------
const opener = await centre( '.goto-open' );
await tap( opener.x, opener.y );
await sleep( 300 );
check( 'Go to… opens the box', await shown( '.goto' ) );
// a phone has no clouds: no switch in the box, and K (a tablet's keyboard) does nothing
await page.keyboard.press( 'KeyK' );
await sleep( 300 );
const noClouds = await page.evaluate( () => ( { button: !! document.querySelector( '.goto .clouds' ), on: atmosphere.cloudsEnabled, held: !! atmosphere.clouds } ) );
check( 'a phone offers no clouds, by button or by K', ! noClouds.button && ! noClouds.on && ! noClouds.held, noClouds );
await tap( 195, 500 ); // the scene
await sleep( 300 );
check( 'touching the scene puts the box away', ! await shown( '.goto' ) );

// --- on foot -----------------------------------------------------------------
// start from the same open spot every time, facing north across the square
await page.evaluate( () => { player.teleport( 51.508, - 0.1281 ); player.yaw = Math.PI; } );
await page.waitForFunction( () => ! player.settling, { timeout: 90000 } );
await loaded();
const modeButton = await centre( '.pad .mode' );
await tap( modeButton.x, modeButton.y );
await page.waitForFunction( () => player.mode === 'walk' && player.heightAboveGround < 0.05, { timeout: 60000 } );
await sleep( 2500 );
check( 'Walk drops you to the street; ▼ hides, Fly is offered', ! await shown( '.pad .down' ) && await page.$eval( '.pad .mode', e => e.innerText ) === 'Fly' );
await down( 1, 200, 600 );
await move( 1, 200, 570 );
await sleep( 1500 );
const stroll = ( await state() ).speed;
await move( 1, 200, 535 );
await sleep( 1500 );
const walk = ( await state() ).speed;
await move( 1, 200, 480 );
await sleep( 1500 );
const run = ( await state() ).speed;
await up( 1 );
await sleep( 800 );
check( 'walking pace follows the drag; a long drag runs', stroll > 0.5 && stroll < walk && walk < 4.6 && run > 6, { stroll, walk, run } );

const upButton = await centre( '.pad .up' );
await down( 3, upButton.x, upButton.y );
await sleep( 250 );
check( '▲ jumps', ( await state() ).agl > 0.3, await page.evaluate( () => ( { agl: player.heightAboveGround, clearance: player.clearance, y: player.stick.y } ) ) );
await up( 3 );
await sleep( 1200 );

// --- take off, climb, come down ----------------------------------------------
await tap( modeButton.x, modeButton.y );
await sleep( 600 );
const y0 = ( await state() ).y;
await down( 3, upButton.x, upButton.y );
await sleep( 500 );
const early = await state(), earlyAt = Date.now();
await sleep( 1800 );
const late = await state(), lateAt = Date.now();
await sleep( 700 );
const later = await state(), laterAt = Date.now();
await up( 3 );
const y1 = ( await state() ).y;
check( 'Fly takes off and ▲ climbs', y1 - y0 > 3, y1 - y0 );
// metres per second early in the hold, and once it has been held a while
const gentle = ( early.y - y0 ) / 0.5, full = ( later.y - late.y ) / ( ( laterAt - lateAt ) / 1000 );
check( '▲ starts gently and speeds up the longer it is held', gentle < 8 && full > 10, { gentle, full, held: ( lateAt - earlyAt ) / 1000 } );
const downButton = await centre( '.pad .down' );
await down( 3, downButton.x, downButton.y );
await page.waitForFunction( () => player.mode === 'walk', { timeout: 20000 } ).catch( () => {} );
const landed = await state(); // the finger is still on ▼, which has just been hidden
check( '▼ lands you and lets go by itself', landed.mode === 'walk' && landed.stick.y === 0, landed );
await up( 3 );
await sleep( 500 );
await tap( modeButton.x, modeButton.y );
await sleep( 2500 );
const again = await state();
check( 'taking off again does not sink back down', again.mode === 'fly' && again.stick.y === 0, again );

// --- landscape: the left half moves, the right half looks ---------------------
await page.setViewport( LANDSCAPE );
await sleep( 1500 );
const e = await state();
await down( 2, 600, 200 );
await move( 2, 660, 160, 8 );
await sleep( 200 );
const f = await state();
check( 'landscape: the right half looks around', ! f.one && f.yaw < e.yaw - 0.1 && f.pitch > e.pitch + 0.1 && f.stick.z === 0, f );
await down( 1, 200, 250 );
await move( 1, 250, 250 );
await sleep( 1200 );
const g = await state();
check( 'landscape: the left half moves (sideways sidesteps)', g.stick.x > 0.7 && g.stick.turn === 0 && g.speed > 1 && Math.abs( g.yaw - f.yaw ) < 0.01, g );
await up( 1 );
await up( 2 );
await page.evaluate( () => { player.hasLooked = false; } );
await sleep( 300 );
check( 'landscape hint', await page.$eval( '.hint', n => n.textContent ) === 'Drag the left side to move, the right side to look' );

// --- landscape with the browser's bars showing: a very short screen ------------
await page.setViewport( SHORT );
await sleep( 1000 );
check( 'short landscape: nothing overlaps', ( await layout() ).length === 0, await layout() );
const up2 = await centre( '.pad .up' ), down2 = await centre( '.pad .down' ), mode2 = await centre( '.pad .mode' );
// the corner left of Walk and above ▼ holds no button: a touch there must reach the scene
const corner = { x: down2.x, y: mode2.y };
check( 'the empty corner beside the buttons belongs to the scene', await page.evaluate( p => document.elementFromPoint( p.x, p.y ).id, corner ) === 'view', corner );
const c0 = await state();
await down( 1, corner.x, corner.y );
await move( 1, corner.x - 60, corner.y );
await up( 1 );
check( 'a drag starting in that corner looks around', ( await state() ).yaw > c0.yaw + 0.1, [ c0.yaw, ( await state() ).yaw ] );
const h0 = await state();
// three fingers at once: the left thumb moves, a right finger looks, another holds ▲
await down( 1, 200, 200 );
await move( 1, 200, 145 );
await down( 2, 500, 150 );
await move( 2, 530, 150 );
await down( 3, up2.x, up2.y );
await sleep( 1500 );
const h1 = await state();
check( 'short landscape: moving, looking and ▲ work together', h1.stick.z > 0.8 && h1.stick.y === 1 && h1.y > h0.y + 3 && h1.yaw < h0.yaw - 0.05 && h1.speed > 3, h1 );
await up( 3 );
await up( 2 );
await sleep( 200 );
const h2 = await state();
check( 'lifting the other fingers leaves the moving thumb in charge', h2.stick.z > 0.8 && h2.stick.y === 0, h2.stick );
// a second finger on the left half is ignored, and lifting it changes nothing
await down( 4, 100, 200 );
await move( 4, 140, 240 );
await up( 4 );
check( 'a second finger on the moving side is ignored', ( await state() ).stick.z > 0.8 && ( await state() ).stick.x === 0 );
await up( 1 );
await sleep( 300 );
await down( 3, down2.x, down2.y );
await page.waitForFunction( () => player.mode === 'walk', { timeout: 30000 } ).catch( () => {} );
await up( 3 );
await sleep( 800 );
const h3 = await state();
check( 'short landscape: ▼ (beside ▲) lands you', h3.mode === 'walk' && h3.stick.y === 0, h3 );
await tap( mode2.x, mode2.y );
await sleep( 1500 );
check( 'short landscape: Fly takes off', ( await state() ).mode === 'fly' );

// --- interruptions -----------------------------------------------------------
await page.setViewport( PORTRAIT );
await sleep( 800 );
await down( 1, 200, 600 );
await move( 1, 260, 540 );
await cdp.send( 'Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] } ); // the system takes the touch away (a notification, a gesture)
fingers.clear();
await sleep( 200 );
const i1 = await state();
check( 'a cancelled touch lets go', i1.stick.z === 0 && i1.stick.turn === 0, i1.stick );
await down( 1, 200, 600 );
await move( 1, 260, 540 );
await page.evaluate( () => window.dispatchEvent( new Event( 'blur' ) ) ); // switching apps
await sleep( 100 );
const i2 = await state();
await move( 1, 280, 500 ); // the old finger must not start steering again
const i3 = await state();
await up( 1 );
check( 'leaving the page lets go, and stays let go', i2.stick.z === 0 && i2.stick.turn === 0 && i3.stick.z === 0, [ i2.stick, i3.stick ] );
// turning the phone with a thumb still down must not leave it steering afterwards
await down( 1, 200, 600 );
await move( 1, 300, 545 );
await page.setViewport( LANDSCAPE );
await sleep( 600 );
await move( 1, 310, 300 );
await up( 1 );
await sleep( 200 );
const i4 = await state();
check( 'turning the phone mid-drag leaves nothing stuck', i4.stick.z === 0 && i4.stick.x === 0 && i4.stick.turn === 0 && ! i4.stick.fast, i4.stick );

// --- every screen size: nothing overlaps, nothing falls off the edge -----------
for ( const [ width, height ] of [ [ 320, 568 ], [ 360, 640 ], [ 390, 844 ], [ 430, 932 ], [ 568, 320 ], [ 844, 292 ], [ 932, 430 ], [ 768, 1024 ], [ 1024, 768 ] ] ) {

	await page.setViewport( { ...PORTRAIT, width, height, isLandscape: width > height } );
	await page.evaluate( () => { player.hasLooked = false; document.querySelector( '.goto' ).classList.remove( 'open' ); } ); // the hint is showing
	await sleep( 500 );
	const closed = await layout();
	const folded = await shown( '.goto-open' );
	if ( folded ) await page.evaluate( () => document.querySelector( '.goto-open' ).click() );
	await sleep( 300 );
	const opened = await layout();
	if ( folded ) {

		const typing = await page.$eval( '.goto input', n => n.getBoundingClientRect().width );
		if ( typing < 150 ) opened.push( `place box only ${ Math.round( typing ) }px wide` );
		// with an error showing too, the open box must still leave the Google Maps logo uncovered
		await page.evaluate( () => { document.querySelector( '.note' ).textContent = 'Location is switched off for this page. Allow it in your browser or device settings, then try again.'; } );
		const logo = await page.evaluate( () => {

			const a = document.querySelector( '.goto' ).getBoundingClientRect(), b = document.querySelector( '.credits img' ).getBoundingClientRect();
			return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

		} );
		await page.evaluate( () => { document.querySelector( '.note' ).textContent = ''; } );
		if ( logo ) opened.push( 'open box covers the Google Maps logo' );

	}
	check( `layout ${ width }×${ height }`, closed.length === 0 && opened.length === 0, { closed, opened } );

}

check( 'text boxes are 16px, so iOS does not zoom in on them', await page.$eval( '.goto input', n => getComputedStyle( n ).fontSize ) === '16px' );
await page.evaluate( () => { player.hasLooked = true; document.querySelector( '.goto' ).classList.remove( 'open' ); } );

// --- going places by touch ---------------------------------------------------
await page.setViewport( PORTRAIT );
await sleep( 600 );
await tap( opener.x, opener.y );
await sleep( 300 );
const box = await centre( '.goto input' );
await tap( box.x, box.y );
await page.keyboard.type( '48.8584, 2.2945' );
const goButton = await centre( '.goto button' );
await tap( goButton.x, goButton.y );
await sleep( 500 );
check( 'Go puts the box away and sets off', ! await shown( '.goto' ) && await page.evaluate( () => player.settling && document.activeElement === document.body ) );
await page.waitForFunction( () => ! player.settling, { timeout: 90000 } );
const paris = await page.evaluate( () => world.toLatLng( player.position ) );
check( 'coordinates typed on the phone take you there', Math.abs( paris.lat - 48.8584 ) < 0.001 && Math.abs( paris.lng - 2.2945 ) < 0.001, paris );
await tap( opener.x, opener.y );
await sleep( 300 );
await page.select( '.goto select', '0' );
await sleep( 500 );
check( 'picking a place puts the box away and sets off', ! await shown( '.goto' ) && await page.evaluate( () => player.settling ) );
await page.waitForFunction( () => ! player.settling, { timeout: 90000 } );

await tap( opener.x, opener.y );
await sleep( 300 );
const boxed = await page.evaluate( () => {

	const inside = sel => { const n = document.querySelector( sel ); return !! n && getComputedStyle( n ).display !== 'none' && n.getBoundingClientRect().width > 40; };
	return { locate: inside( '.goto .locate' ), label: document.querySelector( '.goto .locate span' )?.textContent, fullscreen: inside( '.goto .fullscreen' ),
		input: document.querySelector( '.goto input' ).getBoundingClientRect().width };

} );
check( 'the box offers My location and Fullscreen', boxed.locate && boxed.label === 'My location' && boxed.fullscreen, boxed );
check( 'the place box keeps room to type', boxed.input > 200, boxed.input );
const locate = await centre( '.goto .locate' );
await tap( locate.x, locate.y );
await page.waitForFunction( () => player.settling, { timeout: 20000 } ).catch( () => {} );
check( 'My location puts the box away and sets off', ! await shown( '.goto' ) && await page.evaluate( () => player.settling ) );
await page.waitForFunction( () => ! player.settling, { timeout: 90000 } );
const here = await page.evaluate( () => world.toLatLng( player.position ) );
check( 'My location takes you where the browser says you are', Math.abs( here.lat + 33.8568 ) < 0.001 && Math.abs( here.lng - 151.2153 ) < 0.001, here );

const app = await page.evaluate( async () => {

	const link = document.querySelector( 'link[rel=manifest]' );
	const manifest = await fetch( link.href ).then( r => r.json() );
	const icons = await Promise.all( [ ...manifest.icons.map( i => new URL( i.src, link.href ).href ), document.querySelector( 'link[rel=apple-touch-icon]' ).href ].map( u => fetch( u ).then( r => r.ok ) ) );
	return { display: manifest.display, start: manifest.start_url, icons, capable: document.querySelector( 'meta[name=apple-mobile-web-app-capable]' )?.content };

} );
check( 'added to a home screen it opens full screen: manifest and icons are served', app.display === 'fullscreen' && app.icons.every( Boolean ) && app.capable === 'yes', app );

check( 'the page never scrolled or zoomed', await page.evaluate( () => scrollY === 0 && visualViewport.scale === 1 ) );

// --- coming back later: same place, same mode ----------------------------------
await sleep( 2500 ); // the place is saved every two seconds
const leaving = await page.evaluate( () => ( { ...world.toLatLng( player.position ), mode: player.mode, heading: player.heading } ) );
await page.reload( { waitUntil: 'domcontentloaded' } );
await page.waitForFunction( () => window.player && ! player.settling, { timeout: 90000 } );
const back = await page.evaluate( () => ( { ...world.toLatLng( player.position ), mode: player.mode, heading: player.heading, touch: document.body.classList.contains( 'touch' ) } ) );
check( 'a reload resumes where you were', Math.abs( back.lat - leaving.lat ) < 1e-4 && Math.abs( back.lng - leaving.lng ) < 1e-4 && Math.abs( back.height - leaving.height ) < 2 && back.mode === leaving.mode && Math.abs( back.heading - leaving.heading ) < 1 && back.touch, [ leaving, back ] );

// --- a struggling phone gets fewer pixels, even while moving -------------------
await sleep( 9000 ); // past the grace period after arriving
const width = () => page.evaluate( () => document.getElementById( 'view' ).width );
const before = await width();
await cdp.send( 'Emulation.setCPUThrottlingRate', { rate: 20 } );
await down( 1, 200, 600 );
await move( 1, 200, 545 );
for ( let i = 0; i < 60 && await width() === before; i ++ ) await sleep( 500 );
await up( 1 );
await cdp.send( 'Emulation.setCPUThrottlingRate', { rate: 1 } );
const lowered = await width();
check( 'slow frames while moving lower the resolution', lowered < before, [ before, lowered ] );
// A step taken while tiles were loading may have been the loading's fault, so with frames to
// spare again it is tried back. One taken with nothing loading was the chip's own, and stays.
const owed = await page.evaluate( () => resolution.owed );
for ( let i = 0; i < ( owed ? 120 : 50 ) && await width() === lowered; i ++ ) await sleep( 500 );
check( owed ? 'a step taken while loading comes back once frames are fast' : 'a step taken with nothing loading stays',
	owed ? await width() > lowered : await width() === lowered, [ lowered, await width() ] );

// --- the device takes the graphics away ----------------------------------------
await page.evaluate( () => document.getElementById( 'view' ).getContext( 'webgl2' ).getExtension( 'WEBGL_lose_context' ).loseContext() );
await sleep( 500 );
const lost = await page.evaluate( () => { const b = document.querySelector( '.banner' ); return { show: b.classList.contains( 'show' ), text: b.textContent, button: b.querySelector( 'button' )?.textContent }; } );
check( 'losing the graphics says so and offers a reload', lost.show && lost.button === 'Reload', lost );
check( 'no errors on the page', errors.length === 0, errors );

// --- a laptop with a touchscreen: buttons appear only once the screen is touched
{

	const laptop = await browser.newPage();
	const problems = [];
	await guard( laptop, problems );
	await laptop.setViewport( { width: 1280, height: 720, hasTouch: true, isLandscape: true } );
	await laptop.goto( PAGE.replace( 'profile=phone', 'profile=desktop' ), { waitUntil: 'domcontentloaded' } );
	await laptop.waitForFunction( () => window.player && ! player.settling, { timeout: 90000 } );
	const see = () => laptop.evaluate( () => ( {
		pad: getComputedStyle( document.querySelector( '.pad' ) ).display !== 'none', help: getComputedStyle( document.querySelector( '.help' ) ).display !== 'none',
		yaw: player.yaw, pitch: player.pitch, z: player.position.z, one: player.oneThumb, clouds: atmosphere.cloudsEnabled,
	} ) );
	const l0 = await see();
	check( 'laptop: desktop quality, no touch buttons at first', ! l0.pad && l0.help && l0.clouds, l0 );
	const t = laptop.touchscreen;
	await t.touchStart( 900, 300 );
	await t.touchMove( 960, 270 );
	await t.touchEnd();
	const l1 = await see();
	check( 'laptop: a touch looks around and brings the buttons', l1.pad && ! l1.help && l1.yaw < l0.yaw - 0.1 && l1.pitch > l0.pitch + 0.05, l1 );
	await laptop.mouse.move( 640, 360 );
	await laptop.mouse.down();
	await laptop.mouse.move( 700, 360, { steps: 4 } );
	await laptop.mouse.up();
	const l2 = await see();
	await laptop.keyboard.down( 'ArrowUp' );
	await sleep( 800 );
	await laptop.keyboard.up( 'ArrowUp' );
	const l3 = await see();
	check( 'laptop: the mouse and keys still work after a touch', l2.yaw < l1.yaw - 0.1 && l3.z !== l2.z && ! l3.one, [ l2, l3 ] );
	check( 'laptop: back on the mouse and keys, the help returns and the buttons go', l3.help && ! l3.pad, l3 );

	// clouds on a laptop: the switch (for its touchscreen) and K both work, and toggling leaks nothing
	const sky = () => laptop.evaluate( () => ( {
		on: atmosphere.cloudsEnabled, held: !! atmosphere.clouds, label: document.querySelector( '.goto .clouds' )?.textContent,
		passes: atmosphere.composer.passes.length, listeners: atmosphere.aerial._listeners?.change?.length ?? 0,
	} ) );
	const sky0 = await sky();
	await laptop.evaluate( () => document.querySelector( '.goto .clouds' ).click() );
	await sleep( 500 );
	const sky1 = await sky();
	check( 'laptop: the clouds switch turns them off and frees them', ! sky1.on && ! sky1.held && sky1.label === 'Clouds: off', sky1 );
	await laptop.keyboard.press( 'KeyK' );
	await sleep( 3000 );
	const sky2 = await sky();
	check( 'laptop: K turns them back on', sky2.on && sky2.held && sky2.label === 'Clouds: on', sky2 );
	for ( let i = 0; i < 6; i ++ ) { await laptop.keyboard.press( 'KeyK' ); await sleep( 400 ); }
	const sky3 = await sky();
	check( 'laptop: toggling clouds leaves nothing behind', sky3.on && sky3.passes === sky0.passes && sky3.listeners === sky0.listeners, [ sky0, sky3 ] );
	check( 'laptop: no errors on the page', problems.length === 0, problems );
	await laptop.close();

	// a browser that will not say where it is: the box explains, and nothing moves
	const privateContext = await browser.createBrowserContext();
	const refused = await privateContext.newPage();
	await refused.setViewport( { width: 1280, height: 720 } );
	await refused.goto( PAGE.replace( 'profile=phone', 'profile=desktop' ), { waitUntil: 'domcontentloaded' } );
	await refused.waitForFunction( () => window.player && ! player.settling, { timeout: 90000 } );
	await refused.click( '.goto .locate' );
	await refused.waitForFunction( () => document.querySelector( '.note' ).textContent !== '', { timeout: 20000 } ).catch( () => {} );
	const told = await refused.evaluate( () => ( { note: document.querySelector( '.note' ).textContent, settling: player.settling, busy: document.querySelector( '.goto .locate' ).disabled } ) );
	check( 'location refused: the box says so and you stay put', told.note.includes( 'Location is switched off' ) && ! told.settling && ! told.busy, told );
	await privateContext.close();

}

await browser.close();
finish();
