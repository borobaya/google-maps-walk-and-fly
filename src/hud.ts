import type { Player } from './player';
import { upright } from './quality';
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

/** The start screen shown when no key is built in: the visitor pastes their own. */
export function showSetup( root: HTMLElement, onKey: ( key: string ) => void ) {

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
		<p class="problem" role="alert"></p>
		<p class="muted">Your key stays in this browser tab. It is sent only to Google and is forgotten when you close the tab. Google bills usage beyond its free monthly allowance to the key's owner, so consider setting a quota on it.</p>
		<p class="muted">Running your own copy? You can put the key in <code>.env.local</code> instead; see the <a href="https://github.com/borobaya/google-maps-walk-and-fly#readme" target="_blank" rel="noreferrer">README</a>.</p>
	` );
	box.querySelector( '.origin' )!.textContent = `${ location.origin }/*`;

	const input = box.querySelector( 'input' )!;
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

		onKey( key );

	} );
	root.append( box );
	input.focus();

}

/** Shown instead of the app when the browser cannot draw it at all. */
export function showUnsupported( root: HTMLElement ) {

	root.append( el( 'div', 'setup', `
		<h1>Walk &amp; Fly</h1>
		<p>This browser or device cannot draw the 3D world: it needs WebGL 2 with floating-point rendering.</p>
		<p class="muted">Updating the browser, or trying a newer phone or computer, usually fixes this.</p>
	` ) );

}

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
	private dial = el( 'div', 'dial', '<i>N</i><i>E</i><i>S</i><i>W</i>' );
	private note = el( 'div', 'note' );
	private cloudsButton = el( 'button', 'clouds' );
	private nextSlow = 0;
	private bannerTimer = 0;

	/** @param changeKey forgets a key the visitor typed in and returns to the start screen; null when the key is built in */
	constructor( root: HTMLElement, private player: Player, private world: World, apiKey: string, private changeKey: ( () => void ) | null ) {

		// status
		const status = el( 'div', 'panel status' );
		status.append( this.mode, this.stats );

		// go-to
		const go = el( 'form', 'panel goto' );
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
		if ( changeKey ) {

			const forget = el( 'button', 'forget', 'Change API key' );
			forget.type = 'button';
			forget.addEventListener( 'click', changeKey );
			go.append( forget );

		}

		// touch devices have no K key
		this.cloudsButton.type = 'button';
		this.cloudsButton.addEventListener( 'click', () => { if ( this.onClouds ) this.showClouds( this.onClouds() ); } );
		go.append( this.cloudsButton );

		// on a small screen the whole box folds away behind this button
		const open = el( 'button', 'panel goto-open', 'Go to…' );
		open.type = 'button';
		open.setAttribute( 'aria-label', 'Go to a place, and settings' );
		open.addEventListener( 'click', () => go.classList.toggle( 'open' ) );
		const close = () => go.classList.remove( 'open' );
		// touching the scene (or anything else) puts the box away again
		window.addEventListener( 'pointerdown', e => {

			if ( e.target instanceof Node && ( go.contains( e.target ) || open.contains( e.target ) ) ) return;
			if ( document.activeElement instanceof HTMLElement && go.contains( document.activeElement ) ) document.activeElement.blur();
			close();

		} );

		go.addEventListener( 'submit', async e => {

			e.preventDefault();
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

		} );
		select.addEventListener( 'change', () => {

			const p = PLACES[ Number( select.value ) ];
			if ( select.value !== '' && p ) this.onGoTo?.( p.lat, p.lng );
			select.value = '';
			select.blur();
			close();

		} );

		this.help.innerHTML = `
			<div class="walk-only"><kbd>↑</kbd><kbd>↓</kbd> forward / back &nbsp;<kbd>←</kbd><kbd>→</kbd> turn</div>
			<div class="fly-only"><kbd>↑</kbd><kbd>↓</kbd> fly forward / back &nbsp;<kbd>←</kbd><kbd>→</kbd> turn</div>
			<div><kbd>A</kbd><kbd>D</kbd> sidestep &nbsp;<kbd>W</kbd><kbd>S</kbd> look up / down</div>
			<div><kbd>Mouse</kbd> hold a button and drag to look</div>
			<div class="walk-only"><kbd>Shift</kbd> run &nbsp;<kbd>Space</kbd> jump</div>
			<div class="walk-only"><kbd>Space</kbd><kbd>Space</kbd> or <kbd>F</kbd> take off</div>
			<div class="fly-only"><kbd>Shift</kbd> boost &nbsp;<kbd>Space</kbd> up &nbsp;<kbd>C</kbd> down &nbsp;<kbd>Scroll</kbd> speed</div>
			<div class="fly-only"><kbd>Space</kbd><kbd>Space</kbd> or <kbd>F</kbd> drop &nbsp;·&nbsp; <kbd>C</kbd> to the ground lands</div>
			<div><kbd>K</kbd> clouds &nbsp;<kbd>U</kbd> hide all &nbsp;<kbd>H</kbd> hide help</div>
		`;
		window.addEventListener( 'keydown', e => {

			if ( e.code === 'KeyH' && ! ( e.target instanceof HTMLInputElement ) ) this.help.classList.toggle( 'hidden' );
			// U hides the whole interface (the attribution stays), for an unobstructed view
			if ( e.code === 'KeyU' && ! ( e.target instanceof HTMLInputElement ) ) document.body.classList.toggle( 'bare' );

		} );

		const credits = el( 'div', 'credits' );
		// Google's own logo, as its attribution rules require; the data providers follow it
		const logo = el( 'img' );
		logo.src = `${ import.meta.env.BASE_URL }google-maps-logo.svg`;
		logo.alt = 'Google Maps';
		credits.append( this.credit, logo );

		const compass = el( 'div', 'compass' );
		compass.append( this.dial );
		root.append( compass, status, open, go, this.help, this.hint, credits, this.banner );

	}

	showClouds( on: boolean ) {

		this.cloudsButton.textContent = on ? 'Clouds: on' : 'Clouds: off';

	}

	/** The device took the graphics away (phones do this when memory runs low); only a reload brings them back. */
	lost() {

		clearTimeout( this.bannerTimer );
		this.banner.textContent = 'Your device reset the graphics, usually because memory ran low.';
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

function compass( deg: number ) {

	return [ 'N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW' ][ Math.round( deg / 45 ) % 8 ];

}
