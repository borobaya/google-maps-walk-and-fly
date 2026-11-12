import { MathUtils, PerspectiveCamera, Scene, Timer, WebGLRenderer } from 'three';
import { Atmosphere } from './atmosphere';
import { Hud, PLACES, parseLatLng, showSetup } from './hud';
import { Player } from './player';
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

	const renderer = new WebGLRenderer( { canvas, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' } );
	renderer.setPixelRatio( Math.min( window.devicePixelRatio, 2 ) );

	const scene = new Scene();
	const camera = new PerspectiveCamera( 70, 1, 0.3, 20000 );
	scene.add( camera );

	const world = new World( key, camera, renderer );
	scene.add( world.tiles.group );
	const atmosphere = new Atmosphere( renderer, scene, camera );

	const player = new Player( world, camera, canvas );
	// forgetting a typed key reloads the page, which lands back on the start screen
	const changeKey = typed ? () => { session.set( null ); location.reload(); } : null;
	const hud = new Hud( ui, player, world, key, changeKey );
	world.onError = ( message, fatal ) => hud.error( message, fatal );
	hud.onGoTo = ( lat, lng ) => player.teleport( lat, lng );

	// start where the URL says (#lat,lng), otherwise the first preset
	const fromHash = () => {

		try {

			return parseLatLng( decodeURIComponent( location.hash.slice( 1 ) ) );

		} catch {

			return null; // a mangled link is not worth a blank page

		}

	};
	const begin = fromHash() ?? PLACES[ 0 ];
	player.teleport( begin.lat, begin.lng );
	// a link pasted into the address bar while the app is open only changes the hash: follow it
	// (our own position updates use replaceState, which does not fire this)
	window.addEventListener( 'hashchange', () => {

		const to = fromHash();
		if ( to ) player.teleport( to.lat, to.lng );

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

	// remember the place in the URL so a reload returns to it
	setInterval( () => {

		if ( player.settling ) return;
		const ll = world.toLatLng( player.position );
		history.replaceState( null, '', `#${ ll.lat.toFixed( 5 ) },${ ll.lng.toFixed( 5 ) }` );

	}, 2000 );

	window.addEventListener( 'keydown', e => {

		if ( e.code === 'KeyK' && ! e.repeat && ! ( e.target instanceof HTMLInputElement ) ) atmosphere.toggleClouds();

	} );

	const timer = new Timer();
	const frame = ( dt: number, time: number ) => {

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
		world.tiles.errorTarget = player.mode === 'walk' ? 6 : 12;
		world.update();

		atmosphere.render( dt );
		hud.update( time );

	};

	// `capture` lets a script pause the live loop and advance frame by frame (used to record the README video)
	const capture = { paused: false, step: frame };
	renderer.setAnimationLoop( time => {

		timer.update( time );
		const dt = Math.min( timer.getDelta(), 0.05 );
		if ( dt > 0 && ! capture.paused ) frame( dt, time );

	} );

	// handy when debugging from the console
	Object.assign( window, { player, world, atmosphere, capture } );

}
