import type { Player } from './player';
import { installed, quality, upright } from './quality';
import type { World } from './world';

export const PLACES: Array<{ name: string, lat: number, lng: number }> = [
	{ name: 'London — Tower Bridge', lat: 51.5055, lng: - 0.0754 },
	{ name: 'New York — Midtown', lat: 40.7484, lng: - 73.9857 },
	{ name: 'Paris — Eiffel Tower', lat: 48.8584, lng: 2.2945 },
	{ name: 'San Francisco — Embarcadero', lat: 37.7955, lng: - 122.3937 },
	{ name: 'Tokyo — Tokyo Tower', lat: 35.6586, lng: 139.7454 },
	{ name: 'Sydney — Opera House', lat: - 33.8568, lng: 151.2153 },
	{ name: 'Rome — Colosseum', lat: 41.8902, lng: 12.4922 },
	{ name: 'Grand Canyon', lat: 36.0998, lng: - 112.1125 },
];

/**
 * Parse "51.5, -0.12", or a pasted Google Maps URL containing @lat,lng. Anything else
 * (such as "10 5th Avenue") is not coordinates and is left for the search by name.
 */
export function parseLatLng( text: string ): { lat: number, lng: number } | null {

	const number = String.raw`(-?\d+(?:\.\d+)?)`;
	const m = text.match( new RegExp( String.raw`^\s*${ number }\s*[,\s]\s*${ number }\s*$` ) )
		?? ( /^\s*(?:https?:\/\/|www\.|maps\.)/i.test( text ) ? text.match( new RegExp( `@${ number },${ number }` ) ) : null );
	if ( ! m ) return null;
	const lat = Number( m[ 1 ] ), lng = Number( m[ 2 ] );
	if ( Math.abs( lat ) > 90 || Math.abs( lng ) > 180 ) return null;
	return { lat, lng };

}

const el = <K extends keyof HTMLElementTagNameMap>( tag: K, cls = '', html = '' ) => {

	const node = document.createElement( tag );
	if ( cls ) node.className = cls;
	if ( html ) node.innerHTML = html;
	return node;

};

let mapsLoading: Promise<any> | null = null;
let mapsDenied = false;
let onDenied: ( () => void ) | null = null;

/** Load Google's Maps JavaScript API on first use (only needed for searching by name). */
function loadMaps( key: string ): Promise<any> {

	mapsLoading ??= new Promise( ( resolve, reject ) => {

		const w = window as any;
		w.__mapsReady = () => resolve( w.google.maps );
		// Google calls this when the key is not allowed to use the Maps JavaScript API
		w.gm_authFailure = () => {

			mapsDenied = true;
			onDenied?.();
			reject( new Error( 'REQUEST_DENIED' ) );

		};
		const script = document.createElement( 'script' );
		script.src = `https://maps.googleapis.com/maps/api/js?key=${ encodeURIComponent( key ) }&loading=async&libraries=geocoding&callback=__mapsReady`;
		script.onerror = () => {

			// a network failure is not permanent: forget this attempt so the next search tries again
			script.remove();
			mapsLoading = null;
			reject( new Error( 'Could not reach Google' ) );

		};
		document.head.append( script );

	} );
	return mapsLoading;

}

/** Look a place name up with Google's geocoder. Throws an Error with a readable message. */
export async function findPlace( query: string, key: string ): Promise<{ lat: number, lng: number }> {

	try {

		if ( mapsDenied ) throw new Error( 'REQUEST_DENIED' );
		const maps = await loadMaps( key );

		// a blocked key leaves the lookup hanging, so also listen for the denial and give up after a while
		const { results } = await Promise.race( [
			new maps.Geocoder().geocode( { address: query } ),
			new Promise<never>( ( _, reject ) => {

				onDenied = () => reject( new Error( 'REQUEST_DENIED' ) );
				setTimeout( () => reject( new Error( mapsDenied ? 'REQUEST_DENIED' : 'timed out' ) ), 8000 );

			} ),
		] );
		const loc = results[ 0 ].geometry.location;
		return { lat: loc.lat(), lng: loc.lng() };

	} catch ( e: any ) {

		const code = String( e?.code ?? e?.message ?? e );
		if ( code.includes( 'ZERO_RESULTS' ) ) throw new Error( `No place found for "${ query }"` );
		if ( code.includes( 'DENIED' ) || code.includes( 'NotActivated' ) || code.includes( 'ApiTargetBlocked' ) ) {

			throw new Error( 'Searching by name needs the Maps JavaScript API and Geocoding API enabled on your key. Coordinates still work.' );

		}

		throw new Error( `Search failed (${ code })` );

	}

}

/**
 * The start screen shown when no key is built in: the visitor pastes their own.
 * @param onKey given the key, and whether to remember it on this device rather than for this tab only
 */
export function showSetup( root: HTMLElement, onKey: ( key: string, remember: boolean ) => void ) {

	const box = el( 'div', 'setup', `
		<h1>Walk &amp; Fly</h1>
		<p>Walk the streets or fly like a bird through Google's photorealistic 3D world. To load it, this page needs your own Google Maps Platform API key.</p>
		<ol>
			<li>In <a href="https://console.cloud.google.com/google/maps-apis" target="_blank" rel="noreferrer">Google Cloud Console</a>, enable the <b>Map Tiles API</b> and create an API key.</li>
			<li>Restrict the key to the <b>Map Tiles API</b> and to this website: <code class="origin"></code></li>
			<li>Paste the key here.</li>
		</ol>
		<form>
			<input aria-label="Google Maps Platform API key" placeholder="Your API key" autocomplete="off" autocapitalize="off" spellcheck="false">
			<button>Start</button>
		</form>
		<label class="remember"><input type="checkbox" checked> Remember the key on this device</label>
		<p class="problem" role="alert"></p>
		<p class="muted">Your key is sent only to Google. Remembered, it stays in this browser on this device until you choose <b>Change API key</b>; otherwise it is forgotten when you close the tab. Untick it on a shared computer. Google bills usage beyond its free monthly allowance to the key's owner, so consider setting a quota on it.</p>
		<p class="muted">Running your own copy? You can put the key in <code>.env.local</code> instead; see the <a href="https://github.com/borobaya/google-maps-walk-and-fly#readme" target="_blank" rel="noreferrer">README</a>.</p>
	` );
	box.querySelector( '.origin' )!.textContent = `${ location.origin }/*`;

	const input = box.querySelector( 'form input' ) as HTMLInputElement;
	const remember = box.querySelector( '.remember input' ) as HTMLInputElement;
	const problem = box.querySelector( '.problem' )!;
	box.querySelector( 'form' )!.addEventListener( 'submit', e => {

		e.preventDefault();
		const key = input.value.trim();
		// Google's keys are one unbroken run of letters, digits, dashes and underscores
		if ( ! /^[\w-]{20,}$/.test( key ) ) {

			problem.textContent = key ? 'That does not look like an API key. Copy the whole key, with nothing else.' : 'Paste your API key first.';
			input.classList.add( 'bad' );
			return;

		}

		onKey( key, remember.checked );

	} );
	root.append( box );
	input.focus();

}

/** Shown instead of the app when the browser cannot draw it at all. */
export function showUnsupported( root: HTMLElement ) {

	// Apple's Lockdown Mode switches WebGL off: in Safari on a Mac, and in every browser on an
	// iPhone or iPad (they all use Safari's engine there). A page cannot ask whether it is on,
	// so on those browsers it is named as the likely cause.
	const ua = navigator.userAgent;
	const apple = /AppleWebKit/.test( ua ) && ! /Chrome\/|Chromium|Edg\//.test( ua );
	root.append( el( 'div', 'setup', `
		<h1>Walk &amp; Fly</h1>
		<p>This browser cannot draw the 3D world: 3D graphics (WebGL 2 with floating-point rendering) are switched off or not supported.</p>
		${ apple ? `
			<p><b>Using Lockdown Mode?</b> It switches 3D graphics off. To use this page you can leave Lockdown Mode on and exclude just this website:</p>
			<ul>
				<li><b>Safari on iPhone or iPad:</b> open the page menu in the address bar, choose <b>Website Settings</b> and turn off <b>Lockdown Mode</b>.</li>
				<li><b>Safari on a Mac:</b> <b>Safari</b> menu → <b>Settings for ${ location.hostname }</b> → untick <b>Enable Lockdown Mode</b>.</li>
				<li><b>Another browser on iPhone or iPad</b> (Chrome, Firefox, Edge): open this page in Safari instead. Those browsers cannot exclude a single website, and may not appear in the list of apps under <b>Settings</b> → <b>Privacy &amp; Security</b> → <b>Lockdown Mode</b>.</li>
			</ul>
			<p class="muted">Then reload. Excluding a website lowers Lockdown Mode's protection for it, so only do this if you trust this page.</p>
			<p class="muted">Not using Lockdown Mode? Then updating the browser, or trying a newer device, usually fixes this.</p>
		` : `
			<p class="muted">Updating the browser, or trying a newer phone or computer, usually fixes this.</p>
		` }
	` ) );

}

/** How long after the last click, touch or key press the status panel comes back, milliseconds. */
const QUIET_AFTER = 10000;

export class Hud {

	onGoTo: ( ( lat: number, lng: number ) => void ) | null = null;
	/** Switches the clouds and reports whether they are now on. */
	onClouds: ( () => boolean ) | null = null;
	/** True while waiting for the browser to say where the visitor is. */
	locating = false;

	private mode = el( 'span', 'mode' );
	private stats = el( 'div', 'stats' );
	private hint = el( 'div', 'hint' );
	private credit = el( 'span' );
	private banner = el( 'div', 'banner' );
	private help = el( 'div', 'panel help' );
	private places: HTMLElement | null = null;
	/** The mouse is over (or just beside) the Places box, so it should show. */
	private nearPlaces = false;
	private dial = el( 'div', 'dial', '<i>N</i><i>E</i><i>S</i><i>W</i>' );
	private compass = el( 'div', 'compass' );
	private note = el( 'div', 'note' );
	/** Clouds are switched by this button; a phone has no clouds at all (too costly), so no button. */
	private cloudsButton = quality.phone ? null : el( 'button', 'clouds' );
	private nextSlow = 0;
	private status = el( 'div', 'panel status' );
	/** When the visitor last clicked, touched, scrolled or typed; -Infinity until they first do. */
	private lastInput = - Infinity;
	private bannerTimer = 0;

	/** @param changeKey forgets a key the visitor typed in and returns to the start screen; null when the key is built in */
	constructor( root: HTMLElement, private player: Player, private world: World, apiKey: string, private changeKey: ( () => void ) | null ) {

		// status
		const status = this.status;
		status.append( this.mode, this.stats );
		// While you are clicking, touching or typing, the status panel and the controls panel fade
		// away to leave the view clear. They come back once nothing has been touched for QUIET_AFTER.
		const touched = () => { this.lastInput = performance.now(); };
		for ( const type of [ 'pointerdown', 'keydown', 'wheel' ] ) window.addEventListener( type, touched, { capture: true, passive: true } );
		window.addEventListener( 'pointermove', e => { if ( e.buttons || e.pointerType === 'touch' ) touched(); }, { capture: true, passive: true } );

		// go-to
		const go = el( 'form', 'panel goto' );
		this.places = go;
		// moving the mouse to where the Places box sits brings it back, faded or not
		// (only measured while it matters: when the box is faded, or to notice the mouse leaving it)
		window.addEventListener( 'pointermove', e => {

			if ( e.pointerType !== 'mouse' || ( ! this.nearPlaces && ! go.classList.contains( 'quiet' ) ) ) return;
			const r = go.getBoundingClientRect(), m = 24;
			this.nearPlaces = e.clientX > r.left - m && e.clientX < r.right + m && e.clientY > r.top - m && e.clientY < r.bottom + m;

		}, { passive: true } );
		// the mouse leaving the window from beside the box is no longer on its way to it
		document.documentElement.addEventListener( 'mouseleave', () => { this.nearPlaces = false; } );
		const input = el( 'input' );
		input.placeholder = 'Place or lat, lng';
		input.setAttribute( 'aria-label', 'Place name or latitude, longitude' );
		// a place, not a form field: no contact suggestions, and the keyboard's return key says "go"
		input.autocomplete = 'off';
		input.enterKeyHint = 'go';
		const select = el( 'select' );
		select.setAttribute( 'aria-label', 'Places' );
		select.append( new Option( 'Places…', '' ), ...PLACES.map( ( p, i ) => new Option( p.name, String( i ) ) ) );
		const button = el( 'button', '', 'Go' );
		go.append( input, button, select, this.note );

		// "My location": one tap to where you are. Browsers only answer on a secure page.
		if ( navigator.geolocation && window.isSecureContext ) {

			const locate = el( 'button', 'locate', `
				<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
					<circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none"/>
					<path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4"/>
				</svg><span>My location</span>` );
			locate.type = 'button';
			locate.title = 'Go to my location';
			locate.setAttribute( 'aria-label', 'Go to my location' );
			locate.addEventListener( 'click', () => {

				this.note.textContent = '';
				locate.disabled = true;
				navigator.geolocation.getCurrentPosition(
					at => {

						locate.disabled = false;
						close();
						this.onGoTo?.( at.coords.latitude, at.coords.longitude );

					},
					error => {

						locate.disabled = false;
						this.note.textContent = error.code === error.PERMISSION_DENIED
							? 'Location is switched off for this page. Allow it in your browser or device settings, then try again.'
							: 'Could not find your location. Try again, or type a place.';

					},
					// a fix from the last minute will do; otherwise ask for a good one
					{ enableHighAccuracy: true, maximumAge: 60000, timeout: 15000 },
				);

			} );
			button.after( locate );

		}
		if ( changeKey ) {

			const forget = el( 'button', 'forget', 'Change API key' );
			forget.type = 'button';
			forget.addEventListener( 'click', changeKey );
			go.append( forget );

		}

		if ( this.cloudsButton ) {

			this.cloudsButton.type = 'button';
			this.cloudsButton.addEventListener( 'click', () => { if ( this.onClouds ) this.showClouds( this.onClouds() ); } );
			go.append( this.cloudsButton );

		}

		// Fullscreen, where the browser can do it (an iPhone cannot; there, add the page to the
		// home screen instead). Opened from the home screen it already is.
		const page = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
		const doc = document as Document & { webkitFullscreenEnabled?: boolean, webkitFullscreenElement?: Element, webkitExitFullscreen?: () => void };
		if ( ( document.fullscreenEnabled || doc.webkitFullscreenEnabled ) && ! installed ) {

			const full = el( 'button', 'fullscreen', 'Fullscreen' );
			full.type = 'button';
			const isFull = () => !! ( document.fullscreenElement ?? doc.webkitFullscreenElement );
			full.addEventListener( 'click', () => {

				// a refusal (the browser's choice) simply leaves things as they are
				try {

					if ( isFull() ) void ( document.exitFullscreen ? document.exitFullscreen() : doc.webkitExitFullscreen?.() );
					else void ( page.requestFullscreen ? page.requestFullscreen().catch( () => {} ) : page.webkitRequestFullscreen?.() );

				} catch { /* not allowed just now */ }

				close();

			} );
			const label = () => { full.textContent = isFull() ? 'Exit fullscreen' : 'Fullscreen'; };
			document.addEventListener( 'fullscreenchange', label );
			document.addEventListener( 'webkitfullscreenchange', label );
			go.append( full );

		}

		// on a small screen the whole box folds away behind this button
		const open = el( 'button', 'panel goto-open', 'Go to…' );
		open.type = 'button';
		open.setAttribute( 'aria-label', 'Go to a place, and settings' );
		open.setAttribute( 'aria-expanded', 'false' );
		const show = ( on: boolean ) => { go.classList.toggle( 'open', on ); open.setAttribute( 'aria-expanded', String( on ) ); };
		open.addEventListener( 'click', () => show( ! go.classList.contains( 'open' ) ) );
		const close = () => show( false );
		// Escape puts it away too, and hands the keyboard back to its button
		window.addEventListener( 'keydown', e => {

			if ( e.key !== 'Escape' || ! go.classList.contains( 'open' ) ) return;
			close();
			if ( getComputedStyle( open ).display !== 'none' ) open.focus();

		} );
		// touching the scene (or anything else) puts the box away again
		window.addEventListener( 'pointerdown', e => {

			if ( e.target instanceof Node && ( go.contains( e.target ) || open.contains( e.target ) ) ) return;
			if ( document.activeElement instanceof HTMLElement && go.contains( document.activeElement ) ) document.activeElement.blur();
			close();

		} );

		const submit = async () => {

			const text = input.value.trim();
			if ( ! text ) return;
			this.note.textContent = '';
			input.classList.remove( 'bad' );

			// coordinates go straight there; anything else is looked up by name
			let ll = parseLatLng( text );
			if ( ! ll ) {

				button.disabled = true;
				try {

					ll = await findPlace( text, apiKey );

				} catch ( err: any ) {

					this.note.textContent = err.message;
					input.classList.add( 'bad' );

				}

				button.disabled = false;

			}

			if ( ! ll ) return;
			input.blur();
			close();
			this.onGoTo?.( ll.lat, ll.lng );

		};
		go.addEventListener( 'submit', e => {

			e.preventDefault();
			submit().catch( ( error: unknown ) => console.error( error ) );

		} );
		select.addEventListener( 'change', () => {

			const p = PLACES[ Number( select.value ) ];
			if ( select.value !== '' && p ) this.onGoTo?.( p.lat, p.lng );
			select.value = '';
			select.blur();
			close();

		} );

		// One key (or pair) and one short action a row, for what you are doing now; the rest of the
		// controls (Space twice, landing with C) are in the README.
		const row = ( keys: string, action: string, only = '' ) =>
			`<div${ only ? ` class="${ only }"` : '' }><span>${ keys.split( ' ' ).map( k => `<kbd>${ k }</kbd>` ).join( '' ) }</span><span>${ action }</span></div>`;
		this.help.innerHTML = [
			row( '↑ ↓', 'walk', 'walk-only' ),
			row( '↑ ↓', 'fly', 'fly-only' ),
			row( '← →', 'turn' ),
			row( 'W S', 'look up / down' ),
			row( 'A D', 'step aside' ),
			row( 'Mouse&nbsp;drag', 'look around' ),
			row( 'Space', 'jump', 'walk-only' ),
			row( 'Space C', 'up / down', 'fly-only' ),
			row( 'F', 'take off', 'walk-only' ),
			row( 'F', 'land', 'fly-only' ),
		].join( '' );

		const credits = el( 'div', 'credits' );
		// Google's own logo, as its attribution rules require; the data providers follow it
		const logo = el( 'img' );
		logo.src = `${ import.meta.env.BASE_URL }google-maps-logo.svg`;
		logo.alt = 'Google Maps';
		credits.append( this.credit, logo );

		// read out as the way you face; the turning letters are only for the eye
		this.compass.setAttribute( 'role', 'img' );
		this.compass.setAttribute( 'aria-label', 'Facing north' ); // kept up to date in `update`
		this.dial.setAttribute( 'aria-hidden', 'true' );
		this.compass.append( this.dial );
		root.append( this.compass, status, open, go, this.help, this.hint, credits, this.banner );

	}

	showClouds( on: boolean ) {

		if ( this.cloudsButton ) this.cloudsButton.textContent = on ? 'Clouds: on' : 'Clouds: off';

	}

	/** The device took the graphics away (phones do this when memory runs low); only a reload brings them back. */
	lost() {

		this.offerReload( 'Your device reset the graphics, usually because memory ran low.' );

	}

	/** Part of the app could not be fetched, most likely because a newer version went up while this page was open. */
	outdated() {

		this.offerReload( 'This page is out of date: a newer version is online. Reload to finish updating.' );

	}

	private offerReload( message: string ) {

		clearTimeout( this.bannerTimer );
		this.banner.textContent = message;
		const reload = el( 'button', '', 'Reload' );
		reload.addEventListener( 'click', () => location.reload() );
		this.banner.append( reload );
		this.banner.classList.add( 'show' );

	}

	/** @param fatal false when the world had loaded and tiles then began to fail (quota, session, network) */
	error( message: string, fatal = true ) {

		this.banner.textContent = fatal
			? `Could not load Google 3D Tiles: ${ message }. Check the API key and that the Map Tiles API is enabled.`
			: `Google 3D Tiles have stopped loading: ${ message }. Check your connection and the key's quota, then reload.`;
		// a key typed in by the visitor can be replaced on the spot
		if ( fatal && this.changeKey ) {

			const retry = el( 'button', '', 'Enter a different key' );
			retry.addEventListener( 'click', this.changeKey );
			this.banner.append( retry );

		}

		this.banner.classList.add( 'show' );
		clearTimeout( this.bannerTimer );
		if ( ! fatal ) this.bannerTimer = window.setTimeout( () => this.banner.classList.remove( 'show' ), 15000 );

	}

	update( now: number ) {

		// holding a key, button or thumb counts as still interacting, however long it is held
		if ( this.player.steering ) this.lastInput = performance.now();
		// while a new place loads, say so whatever you are doing
		const quiet = ! this.player.settling && performance.now() - this.lastInput < QUIET_AFTER;
		this.status.classList.toggle( 'quiet', quiet );
		this.help.classList.toggle( 'quiet', quiet );
		// the Places box too, unless it is in use, opened by hand, or the mouse is on its way to it;
		// never while the screen is touched, as a finger cannot hover to bring it back
		const box = this.places;
		if ( box ) box.classList.toggle( 'quiet', quiet && ! this.nearPlaces && ! document.body.classList.contains( 'touch' )
			&& ! box.contains( document.activeElement ) && ! box.classList.contains( 'open' ) );

		const p = this.player;
		document.body.dataset.mode = p.mode;
		document.body.classList.toggle( 'looking', p.dragging );
		this.dial.style.transform = `rotate(${ - p.heading }deg)`;
		this.dial.style.setProperty( '--h', `${ p.heading }deg` );
		this.mode.textContent = p.settling ? 'Loading' : p.mode === 'walk' ? 'Walking' : 'Flying';

		this.hint.textContent = this.locating ? 'Finding your location…' : p.settling ? 'Loading terrain…' : p.hasLooked ? ''
			: document.body.classList.contains( 'touch' )
				? ( upright() ? 'Drag to move and turn' : 'Drag the left side to move, the right side to look' )
			: 'Hold the mouse button and drag to look around';
		// an error banner says something more important, and on a phone would sit on top of the hint
		this.hint.classList.toggle( 'show', this.hint.textContent !== '' && ! this.banner.classList.contains( 'show' ) );

		// text that does not need to change every frame
		if ( now < this.nextSlow ) return;
		this.nextSlow = now + 200;

		const facing = `Facing ${ DIRECTIONS[ Math.round( p.heading / 45 ) % 8 ] }`;
		if ( this.compass.getAttribute( 'aria-label' ) !== facing ) this.compass.setAttribute( 'aria-label', facing );
		const ll = this.world.toLatLng( p.position );
		const kmh = p.speed * 3.6;
		this.stats.innerHTML = p.settling ? '' : `
			<span>${ Math.max( 0, p.heightAboveGround ).toFixed( p.heightAboveGround < 10 ? 1 : 0 ) } m<i> above ground</i></span>
			<span>${ kmh.toFixed( 0 ) } km/h</span>
			<span>${ compass( p.heading ) } ${ p.heading.toFixed( 0 ) }°</span>
			<span>${ ll.lat.toFixed( 5 ) }, ${ ll.lng.toFixed( 5 ) }</span>
		`;
		// "Google" is already shown as the logo text; list only the other data providers
		this.credit.textContent = this.world.attributions()
			.split( /;\s*/ ).filter( s => s && s !== 'Google' ).join( '; ' );

	}

}

const DIRECTIONS = [ 'north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west' ];

function compass( deg: number ) {

	return [ 'N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW' ][ Math.round( deg / 45 ) % 8 ];

}
