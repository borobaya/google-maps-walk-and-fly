import { MathUtils, PerspectiveCamera, Scene, Timer, WebGLRenderer } from 'three';
import { Atmosphere } from './atmosphere';
import { Hud, PLACES, parseLatLng, showSetup, showUnsupported } from './hud';
import { Player, type Resume } from './player';
import { quality } from './quality';
import { addTouchControls } from './touch';
import { World } from './world';
import './style.css';

const EARTH_RADIUS = 6371000;

const ui = document.getElementById( 'ui' )!;
const canvas = document.getElementById( 'view' ) as HTMLCanvasElement;

// A key is either built in (your own copy, from .env.local) or typed in by the visitor (the public
// demo). A typed key is kept for this tab only: sessionStorage is dropped when the tab closes.
const KEY_STORE = 'google-maps-api-key';
const session = {
	get: () => { try { return sessionStorage.getItem( KEY_STORE ); } catch { return null; } },
	set: ( key: string | null ) => {

		try {

			if ( key ) sessionStorage.setItem( KEY_STORE, key );
			else sessionStorage.removeItem( KEY_STORE );

		} catch { /* storage is blocked: the key simply will not survive a reload */ }

	},
};
// where you were last time, kept in this browser for a week
const LAST_STORE = 'walk-and-fly-last';
const LAST_EXPIRY = 7 * 24 * 60 * 60 * 1000;
const builtIn = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined;

if ( builtIn ) start( builtIn, false );
else if ( session.get() ) start( session.get()!, true );
else {

	canvas.style.display = 'none';
	document.body.style.background = '#0b0e12';
	showSetup( ui, key => {

		session.set( key );
		ui.replaceChildren();
		canvas.style.display = '';
		document.body.style.background = '';
		start( key, true );

	} );

}

function start( key: string, typed: boolean ) {

	// the sky is computed in floating point; without that there is nothing to show
	let renderer: WebGLRenderer;
	try {

		renderer = new WebGLRenderer( { canvas, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' } );
		const ext = renderer.extensions;
		if ( ! ext.has( 'EXT_color_buffer_half_float' ) && ! ext.has( 'EXT_color_buffer_float' ) ) throw new Error( 'no float render targets' );

	} catch {

		canvas.style.display = 'none';
		document.body.style.background = '#0b0e12';
		return showUnsupported( ui );

	}

	let pixelRatio = Math.min( window.devicePixelRatio, quality.pixelRatio );
	renderer.setPixelRatio( pixelRatio );

	const scene = new Scene();
	const camera = new PerspectiveCamera( 70, 1, 0.3, 20000 );
	scene.add( camera );

	const world = new World( key, camera, renderer );
	scene.add( world.tiles.group );
	const atmosphere = new Atmosphere( renderer, scene, camera, quality.clouds );

	const player = new Player( world, camera, canvas );
	// forgetting a typed key reloads the page, which lands back on the start screen
	const changeKey = typed ? () => { session.set( null ); location.reload(); } : null;
	const hud = new Hud( ui, player, world, key, changeKey );
	world.onError = ( message, fatal ) => hud.error( message, fatal );
	hud.onClouds = () => atmosphere.toggleClouds();
	hud.showClouds( atmosphere.cloudsEnabled );
	addTouchControls( ui, player );
	// phones take the graphics away when memory runs low; say so instead of showing a frozen picture
	canvas.addEventListener( 'webglcontextlost', e => {

		e.preventDefault();
		hud.lost();

	} );

	// --- where to begin -------------------------------------------------
	// 1. where you left off, if you were here in the last week (same height, heading, walking or flying)
	// 2. a place given in the link (#lat,lng)
	// 3. where you are, if the browser is allowed to say
	// 4. the first preset

	let placed = false; // nothing is loaded or drawn until we know where to begin
	const place = ( lat: number, lng: number, resume: Resume | null = null ) => {

		placed = true;
		hud.locating = false;
		player.teleport( lat, lng, resume );

	};
	hud.onGoTo = ( lat, lng ) => place( lat, lng );

	const fromHash = () => {

		try {

			return parseLatLng( decodeURIComponent( location.hash.slice( 1 ) ) );

		} catch {

			return null; // a mangled link is not worth a blank page

		}

	};
	const readLast = (): ( Resume & { lat: number, lng: number } ) | null => {

		try {

			const s = JSON.parse( localStorage.getItem( LAST_STORE ) ?? 'null' );
			const age = Date.now() - s?.t;
			const sound = s && [ s.lat, s.lng, s.height, s.heading, s.pitch ].every( Number.isFinite )
				&& ( s.mode === 'walk' || s.mode === 'fly' ) && Math.abs( s.lat ) <= 90 && Math.abs( s.lng ) <= 180;
			if ( sound && age >= 0 && age < LAST_EXPIRY ) return s;
			localStorage.removeItem( LAST_STORE ); // expired or damaged
			return null;

		} catch {

			return null;

		}

	};

	const link = fromHash();
	const last = readLast();
	// the address bar always shows where you are, so a link that matches the saved place is just a reload
	const sameSpot = link && last && Math.abs( link.lat - last.lat ) < 2e-5 && Math.abs( link.lng - last.lng ) < 2e-5;
	if ( last && ( ! link || sameSpot ) ) place( last.lat, last.lng, last );
	else if ( link ) place( link.lat, link.lng );
	else {

		const fallback = () => { if ( ! placed ) place( PLACES[ 0 ].lat, PLACES[ 0 ].lng ); };
		if ( ! navigator.geolocation ) fallback();
		else {

			hud.locating = true;
			navigator.geolocation.getCurrentPosition(
				at => { if ( ! placed ) place( at.coords.latitude, at.coords.longitude ); },
				fallback, // refused or unavailable
				{ maximumAge: 600000, timeout: 10000 },
			);
			// a permission prompt left unanswered should not hold things up for ever
			setTimeout( fallback, 15000 );

		}

	}

	// a link pasted into the address bar while the app is open only changes the hash: follow it
	// (our own position updates use replaceState, which does not fire this)
	window.addEventListener( 'hashchange', () => {

		const to = fromHash();
		if ( to ) place( to.lat, to.lng );

	} );

	const resize = () => {

		renderer.setSize( window.innerWidth, window.innerHeight, false );
		atmosphere.setSize( window.innerWidth, window.innerHeight );
		camera.aspect = window.innerWidth / window.innerHeight;
		camera.updateProjectionMatrix();
		world.tiles.setResolutionFromRenderer( camera, renderer );

	};
	window.addEventListener( 'resize', resize );
	resize();

	// Remember the place: in the address bar, so the link can be shared, and in this browser,
	// so the next visit within a week picks up where this one ended.
	const remember = () => {

		if ( ! placed || player.settling ) return;
		const ll = world.toLatLng( player.position );
		history.replaceState( null, '', `#${ ll.lat.toFixed( 5 ) },${ ll.lng.toFixed( 5 ) }` );
		try {

			localStorage.setItem( LAST_STORE, JSON.stringify( {
				lat: ll.lat, lng: ll.lng, height: ll.height,
				mode: player.mode, heading: player.heading, pitch: player.pitch, t: Date.now(),
			} ) );

		} catch { /* storage is blocked: only the address bar remembers */ }

	};
	setInterval( remember, 2000 );
	window.addEventListener( 'pagehide', remember );

	window.addEventListener( 'keydown', e => {

		if ( e.code === 'KeyK' && ! e.repeat && ! ( e.target instanceof HTMLInputElement ) ) hud.showClouds( atmosphere.toggleClouds() );

	} );

	// If frames stay slow, draw fewer pixels, one step at a time.
	// Arriving somewhere is not counted: those hitches are not the graphics chip's doing. Tiles
	// keep loading for as long as you move, so that cannot rule a frame out, but decoding them
	// causes hitches of its own: while they load it takes twice as long to blame the chip.
	// A step taken while loading may still have been the loading's fault, so once things are calm
	// and there are frames to spare it is tried back; twice at most, so the picture cannot see-saw.
	let slowFor = 0, fastFor = 0, smoothed = 1 / 60, settledAt = Infinity;
	let owed = 0, retries = 2; // steps taken while tiles were loading, and how many may still be undone
	const setPixelRatio = ( to: number ) => {

		pixelRatio = to;
		renderer.setPixelRatio( to );
		resize();

	};
	const watchSpeed = ( dt: number, time: number ) => {

		if ( player.settling ) return void ( settledAt = Infinity );
		if ( settledAt === Infinity ) settledAt = time;
		if ( time - settledAt < 8000 ) return void ( slowFor = fastFor = 0, smoothed = 1 / 60 );
		smoothed += ( dt - smoothed ) * 0.05;
		const loading = world.tiles.loadProgress < 1;

		slowFor = smoothed > 1 / 30 ? slowFor + dt : 0;
		if ( slowFor >= ( loading ? 8 : 4 ) && pixelRatio > quality.minPixelRatio ) {

			slowFor = 0;
			if ( loading ) owed ++;
			return setPixelRatio( Math.max( quality.minPixelRatio, pixelRatio - 0.25 ) );

		}

		fastFor = owed > 0 && retries > 0 && ! loading && smoothed < 1 / 50 ? fastFor + dt : 0;
		if ( fastFor >= 15 ) {

			fastFor = 0;
			owed --;
			retries --;
			setPixelRatio( pixelRatio + 0.25 );

		}

	};

	const timer = new Timer();
	const frame = ( dt: number, time: number ) => {

		if ( ! placed ) return hud.update( time ); // still finding out where to begin

		player.update( dt );

		// see to the horizon from wherever we are, without wasting depth precision
		const h = player.settling ? 1500 : Math.max( player.heightAboveGround, 2 );
		// never let the near plane reach a wall beside you, or you would see through it
		// (at most half the distance to it, which keeps even the corners of the view on your side)
		const reach = player.settling ? Infinity : player.clearance * 0.5;
		camera.near = MathUtils.clamp( Math.min( Math.max( h * 0.05, 0.3 ), reach ), 0.1, 50 );
		camera.far = MathUtils.clamp( Math.sqrt( 2 * EARTH_RADIUS * h ) * 1.5 + 5000, 8000, 1e6 );
		camera.fov = player.fov;
		camera.updateProjectionMatrix();

		atmosphere.update( world.tiles.group.matrixWorldInverse );

		// more detail up close when on foot
		world.tiles.errorTarget = player.mode === 'walk' ? quality.walkError : quality.flyError;
		world.update();

		atmosphere.render( dt );
		hud.update( time );
		watchSpeed( dt, time );

	};

	// `capture` lets a script pause the live loop and advance frame by frame (used to record the README video)
	const capture = { paused: false, step: frame };
	renderer.setAnimationLoop( time => {

		timer.update( time );
		const dt = Math.min( timer.getDelta(), 0.05 );
		if ( dt > 0 && ! capture.paused ) frame( dt, time );

	} );

	// handy when debugging from the console
	const resolution = { get pixelRatio() { return pixelRatio; }, get owed() { return owed; } };
	Object.assign( window, { player, world, atmosphere, capture, resolution } );

}
