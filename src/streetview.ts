/*
 * Street View on the buildings: off until its button switches it on (main.ts remembers the choice
 * on the device, and fetches this code only then).
 *
 * Projects Google Street View panoramas onto the 3D tiles around you, so close walls show the
 * panoramas' photographs instead of the softer aerial texture. The app stores no imagery: photos
 * are kept in memory only (up to KEPT), so coming back during a visit costs no new download.
 * Between visits only Google's session token is remembered, which keeps each tile's address the
 * same, so the browser's own cache can serve tiles again for as long as Google's headers allow.
 *
 * Which panoramas: Google's own (not uploaded photo spheres) nearest you, nearest to points all
 * around you, and Street View's links along the street; up to SLOTS drawn at once. Each fades in
 * once loaded and out when no longer wanted, so walking along a street hands over gradually.
 * They download one at a time, nearest first, and are stitched together in a worker so the walk
 * does not stutter. On a computer each photo's top row (mostly sky) is left out.
 *
 * For each point of a tile, a panorama may paint it if:
 * - it could see the point: a depth cube rendered from the panorama's centre, from every tile in
 *   use (in view or not), says nothing stood in between;
 * - the point faces it rather than being seen edge-on;
 * - the point is within PAINT_RANGE of it;
 * - it is not straight down (that is the Street View car itself).
 * Of those, the nearest one paints the point alone: mixing photos taken from different places
 * doubles every edge that does not lie exactly on the mesh.
 */
import {
	AdditiveBlending, CanvasTexture, Color, CubeCamera, DoubleSide, HalfFloatType, LinearFilter, MathUtils, Mesh, NoColorSpace, RGBAFormat, SRGBColorSpace,
	ShaderMaterial, Sprite, SpriteMaterial, Texture, Vector3, WebGLCubeRenderTarget, type Material, type Object3D, type Scene, type WebGLRenderer,
} from 'three';
import type { World } from './world';
import { quality } from './quality';

const API = 'https://tile.googleapis.com/v1';
const DEG = Math.PI / 180;
/** Panoramas used at once: the nearest and its neighbours either way along the street. */
const SLOTS = 6;
/**
 * Panorama zoom: 3 gives about 9 pixels per degree, around 50 pixels per metre on a wall 10 m away
 * (4096 x 2048, 32 MB of graphics memory). Phones take 2, a quarter of that: half as sharp,
 * still several times the 3D tiles' own detail, and far less likely to run out of memory.
 */
const ZOOM = quality.phone ? 2 : 3;
/** Street View cameras ride on a car roof, about this high above the road. */
const CAMERA_HEIGHT = 2.5;
/** Look again for the nearest panorama after moving this far across the map (rising or falling does not count). */
const REQUERY = 6;
/**
 * Photos held in memory, drawn or not, so walking back down a street needs no new download. On a
 * computer each takes 32 MB of graphics memory, or, never yet drawn, 32 MB for the picture
 * waiting to go there.
 */
const KEPT = quality.phone ? 10 : 30;
/**
 * Panoramas are looked for at points SPACING metres apart out to REACH from you, each finding the
 * nearest within SPACING of it: one request of about 37 points. Each point finds only its nearest,
 * so at a sight crowded with visitors' uploads it takes points this close to find Google's own.
 */
const REACH = 20, SPACING = 6;
/**
 * A look-up asks for the details of the panoramas it found only until it has this many of
 * Google's own to choose from besides the nearest: enough to fill the other slots with one to
 * spare, rather than every one found all around.
 */
const CHOOSE_FROM = SLOTS;
/**
 * Most details one look-up asks for, whatever it finds. Following links ends once there are enough
 * of Google's own, but where the photos around are not Google's (other owners' official coverage,
 * whose IDs look the same) it would otherwise walk the whole street network, at a request each.
 */
const MOST_DETAILS = 4 * CHOOSE_FROM;
/** metres of advantage a panorama already showing has over a newcomer */
const KEEP = 8;
/**
 * A panorama's photograph paints points up to this far from where it was taken, in metres, and
 * nothing beyond. A photo is about 516 / distance pixels a metre on a computer (half that on a
 * phone), against the aerial texture's 5 or so, but the farther a point, the worse it lines up
 * with the rough mesh.
 */
const PAINT_RANGE = 40;
/** Width of an orb, metres. */
const ORB_SIZE = 2.5;
/** Seconds for a panorama to fade in or out. */
const FADE_TIME = 0.8;
/**
 * After Google answers "too many requests", nothing more is asked for this long, milliseconds; when
 * it is the day's quota that is used up, for REFUSED_DAY_WAIT (it comes back at midnight, Pacific time).
 */
const REFUSED_WAIT = 60000, REFUSED_DAY_WAIT = 10 * 60000;
/** The depth cubes are redrawn at most this often while tiles are changing, milliseconds. */
const DEPTH_EVERY = quality.phone ? 1500 : 600;
/**
 * How far a depth cube looks (metres). A photo paints nothing beyond PAINT_RANGE, so only something
 * nearer than that can hide a point from it: everything further is left out of the cube.
 */
const DEPTH_REACH = PAINT_RANGE + 10;
/**
 * A look-up that could not be made (ground not loaded yet, or an error) is tried again after this,
 * milliseconds, doubling with each failure in a row up to RETRY_MOST.
 */
const RETRY = 3000, RETRY_MOST = 5 * 60000;
/** A panorama whose pieces would not download is not asked for again for this long, milliseconds. */
const FAILED_WAIT = 5 * 60000;
/** A panorama with no ground found under it (its tiles not loaded yet) is tried again after this, milliseconds. */
const NO_GROUND_WAIT = 5000;

interface Metadata {
	panoId: string; lat: number; lng: number; heading: number; tilt: number; roll: number;
	imageWidth: number; imageHeight: number; tileWidth: number; tileHeight: number;
	date?: string; copyright?: string; reportProblemLink?: string;
	links?: { panoId: string, heading?: number }[];
}

interface Slot {
	meta: Metadata | null;
	map: Texture | null;
	cube: WebGLCubeRenderTarget;
	ground: number;
	/** 0..1, eased towards 1 while wanted and loaded, towards 0 otherwise */
	strength: number;
	wanted: boolean;
	depthDirty: boolean;
	/** False until its depth cube has been drawn: it does not fade in before then. */
	depthReady: boolean;
}

/**
 * Where the session is remembered between visits. Tiles are addressed with it, so a new session
 * every visit would give every tile a new address and the browser's own cache could never be used.
 * Only the token and its expiry are kept, never any imagery.
 */
const SESSION_STORE = 'walk-and-fly-streetview-session';
/** A remembered session this close to expiring is not used (seconds). */
const SESSION_MARGIN = 60 * 60;
/**
 * Rows of a panorama lying wholly above this elevation (degrees) are not downloaded: at zoom 3 that
 * is the top row, mostly sky, a quarter of the tiles. At zoom 2 (phones) no row lies that high.
 */
const SKIP_ABOVE = 40;

/**
 * Stitches a panorama's tiles together off the main thread, drawing each as it arrives, and hands
 * back one ImageBitmap. Started from a blob, so Street View stays one file.
 */
const STITCHER = `
	const jobs = new Map();
	onmessage = async ( { data } ) => {
		try {
			if ( data.kind === 'start' ) {
				const canvas = new OffscreenCanvas( data.width, data.height );
				const g = canvas.getContext( '2d' );
				if ( ! g ) throw new Error( 'no room for a ' + data.width + ' x ' + data.height + ' picture' );
				jobs.set( data.id, { canvas, g, drawing: [], broken: 0 } );
				return;
			}
			const job = jobs.get( data.id );
			if ( data.kind === 'cancel' ) return void jobs.delete( data.id );
			if ( ! job ) throw new Error( 'not started' ); // its start failed: say so when it is finished
			if ( data.kind === 'tile' ) {
				job.drawing.push( createImageBitmap( data.blob )
					.then( img => { job.g.drawImage( img, data.x, data.y ); img.close(); } )
					.catch( () => { job.broken ++; } ) );
			} else if ( data.kind === 'finish' ) {
				await Promise.all( job.drawing );
				jobs.delete( data.id );
				const bitmap = job.canvas.transferToImageBitmap();
				postMessage( { id: data.id, bitmap, broken: job.broken }, [ bitmap ] );
			}
		} catch ( e ) {
			jobs.delete( data.id );
			if ( data.kind === 'finish' || data.kind === 'start' ) postMessage( { id: data.id, error: String( e ) } );
		}
	};
`;
/** A photo not stitched by then is given up (milliseconds): a stuck job must not stop every later one. */
const STITCH_WAIT = 30000;

const blank = new Texture();

/** Thrown while Google is asking for fewer requests: the photo is fine, it simply has to wait. */
class Refused extends Error {}

interface Stitched { bitmap: ImageBitmap, broken: number }
/** Shared by every tile's shader. */
const uniforms = {
	svMap: { value: [] as Texture[] },
	svDepth: { value: [] as Texture[] },
	svCenter: { value: [] as Vector3[] },
	svHeading: { value: [] as number[] },
	svPitch: { value: [] as number[] },
	/** How far down each photo its picture starts (0..1): the rows above were not downloaded. */
	svTop: { value: [] as number[] },
	svStrength: { value: [] as number[] },
};

/** The fragment code, written out once per slot: GLSL cannot index an array of textures in a loop. */
function slotCode( i: number ) {

	return /* glsl */`
		if ( svStrength[ ${ i } ] > 0.0 ) {
			vec3 ray = vSvWorld - svCenter[ ${ i } ];
			float d = length( ray );
			vec3 dir = ray / d;
			// could the panorama see this point? Nothing at all in that direction (0) means open sky
			float seen = textureCube( svDepth[ ${ i } ], dir ).r;
			float visible = seen <= 0.0 ? 1.0 : step( d, seen + 0.4 + d * 0.03 );
			float facing = smoothstep( 0.25, 0.55, abs( dot( svNormal, dir ) ) );
			// scene axes: +Y up, +Z north, -X east
			float azimuth = atan( - dir.x, dir.z ) / ( 2.0 * PI );
			float elevation = asin( clamp( dir.y, - 1.0, 1.0 ) ) + svPitch[ ${ i } ];
			float below = smoothstep( - 1.15, - 0.95, elevation );
			float w = svStrength[ ${ i } ] * visible * facing * below * step( d, ${ PAINT_RANGE.toFixed( 1 ) } );
			vec2 uv = vec2( fract( azimuth - svHeading[ ${ i } ] / 360.0 + 0.5 ), 0.5 - elevation / PI );
			// nothing to paint where the photo's top rows were not downloaded
			w *= smoothstep( svTop[ ${ i } ], svTop[ ${ i } ] + 0.01, uv.y );
			// the nearest that can paint the point does, alone
			float pull = w * pow( 1.0 + d, - 6.0 );
			if ( pull > svPull ) { svColor = texture2D( svMap[ ${ i } ], uv ).rgb; svPull = pull; }
			svCover = max( svCover, w );
		}`;

}

/**
 * Only Google's own panoramas: ones people upload (photo spheres) are placed by hand, often metres
 * out and at whatever height they were taken, so they land on the wrong walls.
 */
const byGoogle = ( m: Metadata ) => /Photo by: Google|^© ?\d* ?Google/.test( m.copyright ?? '' );
/**
 * Whether a panorama ID looks like one of Google's own: theirs are 22 characters, uploads are
 * longer (starting `CAoS`). Lets uploads be passed over without paying to ask about them; `byGoogle`
 * still checks the details of every one used. At a sight like Westminster Bridge nearly every
 * panorama found is an upload, and Google offers no way to ask for its own only.
 */
const looksGoogle = ( id: string ) => /^[\w-]{22}$/.test( id );

export class StreetView {

	/** One session, shared by every request; started by whichever needs it first. */
	private session: Promise<string> | null = null;
	/** Failed look-ups in a row, for spacing out the next try. */
	private failures = 0;
	/** False while flying or arriving: photos already in memory may still be used, but nothing is downloaded. */
	private walking = false;
	/** The panoramas the credit last named, so it is redrawn only when that changes. */
	private credited = '';
	private clearColor = new Color();
	/** Whether a panorama is downloading: one at a time, nearest first, so the nearest arrives soonest. */
	private downloading = false;
	private stitcher: Worker | null = null;
	private stitched = new Map<number, { resolve: ( result: Stitched ) => void, reject: ( error: Error ) => void }>();
	/** Set once the worker has failed, or the browser has none that can draw: stitching is then done here. */
	private noWorker = typeof OffscreenCanvas === 'undefined';
	private nextJob = 0;
	private lastQuery = new Vector3( Infinity, 0, 0 );
	/** Where photos in memory were last chosen from, while flying. */
	private lastCached = new Vector3( Infinity, 0, 0 );
	private busy = false;
	private nearest: string | null = null;
	private slots: Slot[] = [];
	/** A glowing orb at the centre of each slot's panorama, where its photo was taken from. */
	private orbs: Sprite[] = [];
	/** Whether the orbs are shown (the debug panel switches them on). */
	showOrbs = false;
	private cubeCamera: CubeCamera;
	private distance: ShaderMaterial;
	private depthCenter = { value: new Vector3() };
	private nextDepth = 0;
	private credit = document.createElement( 'div' );
	private tmp = new Vector3();
	private pending = new Set<string>();
	/** The panoramas the last look-up wanted, and the street it was made from, for filling slots as they free up. */
	private wantedList: Metadata[] = [];
	private street = 0;
	/** Until when nothing is asked of Google, after it answered "too many requests" (429). */
	private refusedUntil = 0;
	/** When Google last answered "too many requests" (Date.now()), for the debug panel. */
	private refusedAt = 0;
	/** Whether Google was being left alone last frame, to notice the wait ending. */
	private wasRefused = false;
	/** Until when no look-up is tried, after one could not be made. */
	private retryAt = 0;
	/** Panoramas whose pieces would not download, and when they may be tried again. */
	private failed = new Map<string, number>();
	/** The slot whose depth cube was drawn last, so the others take their turn. */
	private lastDepth = - 1;

	constructor( private key: string, private world: World, private renderer: WebGLRenderer, private scene: Scene ) {

		for ( let i = 0; i < SLOTS; i ++ ) {

			const cube = new WebGLCubeRenderTarget( quality.phone ? 256 : 512, { type: HalfFloatType, format: RGBAFormat, generateMipmaps: false, minFilter: LinearFilter, magFilter: LinearFilter } );
			cube.texture.colorSpace = NoColorSpace;
			this.slots.push( { meta: null, map: null, cube, ground: 0, strength: 0, wanted: false, depthDirty: false, depthReady: false } );
			uniforms.svMap.value.push( blank );
			uniforms.svDepth.value.push( cube.texture );
			uniforms.svCenter.value.push( new Vector3() );
			uniforms.svHeading.value.push( 0 );
			uniforms.svPitch.value.push( 0 );
			uniforms.svTop.value.push( 0 );
			uniforms.svStrength.value.push( 0 );

		}

		// a soft glow, painted once: a bright core fading to nothing (no mipmaps, as with every texture)
		const glow = document.createElement( 'canvas' );
		glow.width = glow.height = 128;
		const g = glow.getContext( '2d' )!;
		const ramp = g.createRadialGradient( 64, 64, 0, 64, 64, 64 );
		ramp.addColorStop( 0, 'rgba(255,255,255,1)' );
		ramp.addColorStop( 0.18, 'rgba(255,225,150,0.95)' );
		ramp.addColorStop( 0.45, 'rgba(255,170,60,0.35)' );
		ramp.addColorStop( 1, 'rgba(255,140,0,0)' );
		g.fillStyle = ramp;
		g.fillRect( 0, 0, 128, 128 );
		const glowTexture = new CanvasTexture( glow );
		glowTexture.generateMipmaps = false;
		glowTexture.minFilter = LinearFilter;
		glowTexture.colorSpace = SRGBColorSpace;
		for ( let i = 0; i < SLOTS; i ++ ) {

			const orb = new Sprite( new SpriteMaterial( { map: glowTexture, blending: AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false } ) );
			orb.visible = false;
			orb.renderOrder = 10;
			this.orbs.push( orb );
			scene.add( orb );

		}

		this.cubeCamera = new CubeCamera( 0.5, DEPTH_REACH, this.slots[ 0 ].cube );
		this.distance = new ShaderMaterial( {
			uniforms: { center: this.depthCenter },
			vertexShader: 'varying vec3 vWorld; void main() { vec4 w = modelMatrix * vec4( position, 1.0 ); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
			fragmentShader: 'uniform vec3 center; varying vec3 vWorld; void main() { gl_FragColor = vec4( length( vWorld - center ), 0.0, 0.0, 1.0 ); }',
			side: DoubleSide,
		} );

		// every tile, now and as they load, is taught to read the panoramas; tiles coming and going
		// change what each panorama can see
		world.tiles.group.traverse( o => this.teach( o ) );
		world.tiles.addEventListener( 'load-model', ( e: { scene: Object3D } ) => { e.scene.traverse( o => this.teach( o ) ); this.markDepth(); } );
		world.tiles.addEventListener( 'dispose-model', () => this.markDepth() );

		// a line of Google's own credits, above them: it takes their size and place on every screen
		// and can never overlap them. Only the link takes clicks and touches.
		this.credit.className = 'streetview-credit';
		const credits = document.querySelector( '#ui .credits' );
		// below the debug panel, when there is one
		if ( credits ) credits.insertBefore( this.credit, credits.querySelector( ':scope > :not(.debug)' ) ); else document.body.append( this.credit );

	}

	/** What it is doing, in a few words, for the debug panel. */
	get status() {

		const now = performance.now();
		const s = ( ms: number ) => `${ Math.ceil( ms / 1000 ) } s`;
		const what = ! this.enabled ? 'off'
			: this.refused ? `waiting ${ s( this.refusedUntil - now ) }: Google asked for fewer requests`
				: this.downloading ? `downloading: ${ this.wantedList.filter( m => ! this.slots.some( s => s.meta?.panoId === m.panoId ) ).length } photos to go`
					: this.busy ? 'searching'
						: ! this.walking ? 'flying: only photos already held are shown'
							: now < this.retryAt ? `trying again in ${ s( this.retryAt - now ) }`
								: 'up to date';
		return {
			shown: this.slots.filter( s => s.meta && s.strength > 0.99 ).length,
			slots: SLOTS,
			kept: this.kept.size,
			what,
			refusedAt: this.refusedAt,
		};

	}

	/** What it is doing, for the tests and the browser console. */
	get debug() {

		return {
			uniforms,
			slots: this.slots.map( ( s, i ) => ( { ready: s.depthReady, pano: s.meta?.panoId ?? null, strength: + s.strength.toFixed( 2 ), wanted: s.wanted, centre: uniforms.svCenter.value[ i ].toArray().map( v => + v.toFixed( 1 ) ), ground: + s.ground.toFixed( 1 ), copyright: s.meta?.copyright } ) ),
			nearest: this.nearest,
			kept: [ ...this.kept.keys() ],
		};

	}

	private teach( o: Object3D ) {

		const material = ( o as Mesh ).material as Material | undefined;
		if ( ! material || material.userData.streetview ) return;
		material.userData.streetview = true;
		// added to whatever else changes the tile's shader (the fade between levels of detail), not
		// in place of it; the fade plugin likewise keeps this when it wraps a tile later
		const key = material.customProgramCacheKey.bind( material );
		material.customProgramCacheKey = () => key() + '|streetview';
		const before = material.onBeforeCompile.bind( material );
		material.onBeforeCompile = ( shader, renderer ) => {

			before( shader, renderer );
			Object.assign( shader.uniforms, uniforms );
			shader.vertexShader = 'varying vec3 vSvWorld;\n' + shader.vertexShader.replace( '#include <project_vertex>',
				'#include <project_vertex>\nvSvWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;' );
			let slots = '';
			for ( let i = 0; i < SLOTS; i ++ ) slots += slotCode( i );
			shader.fragmentShader = /* glsl */`
				uniform sampler2D svMap[ ${ SLOTS } ]; uniform samplerCube svDepth[ ${ SLOTS } ];
				uniform vec3 svCenter[ ${ SLOTS } ]; uniform float svHeading[ ${ SLOTS } ], svPitch[ ${ SLOTS } ], svTop[ ${ SLOTS } ], svStrength[ ${ SLOTS } ];
				varying vec3 vSvWorld;
			` + shader.fragmentShader.replace( '#include <dithering_fragment>', /* glsl */`
				{
					vec3 svNormal = normalize( cross( dFdx( vSvWorld ), dFdy( vSvWorld ) ) );
					vec3 svColor = vec3( 0.0 ); float svPull = 0.0, svCover = 0.0;
					${ slots }
					if ( svPull > 0.0 ) gl_FragColor.rgb = mix( gl_FragColor.rgb, svColor, svCover );
				}
				#include <dithering_fragment>
			` );

		};
		material.needsUpdate = true;

	}

	private markDepth() {

		for ( const s of this.slots ) if ( s.meta ) s.depthDirty = true;

	}

	/**
	 * Called every frame with where you are. `settled` is false while arriving somewhere (high up, with
	 * the ground still loading) and while flying, when nothing is looked up.
	 */
	update( position: Vector3, settled = true, dt = 1 / 60 ) {

		this.walking = settled;
		// the wait after "too many requests" is over: photos it cut short, or kept from starting, start now
		const refused = this.refused;
		if ( this.wasRefused && ! refused ) this.fill();
		this.wasRefused = refused;
		let freed = false;
		const shown: boolean[] = [];
		const pulse = 0.9 + 0.1 * Math.sin( performance.now() / 400 );
		this.slots.forEach( ( s, i ) => {

			const orb = this.orbs[ i ];
			orb.visible = false;
			if ( ! s.meta ) return;
			// the world is re-anchored as you travel: place each panorama afresh from its latitude and longitude
			this.place( s.meta.lat, s.meta.lng, s.ground + CAMERA_HEIGHT, uniforms.svCenter.value[ i ] );
			const near = uniforms.svCenter.value[ i ].distanceTo( position ) < PAINT_RANGE + 20;
			shown[ i ] = s.wanted && near;
			s.strength = MathUtils.clamp( s.strength + ( s.wanted && near && s.depthReady ? dt : - dt ) / FADE_TIME, 0, 1 );
			uniforms.svStrength.value[ i ] = s.strength * s.strength * ( 3 - 2 * s.strength );
			// the orb, if switched on, marks where the photo was taken from, fading as the photo does
			if ( this.showOrbs && s.strength > 0 ) {

				orb.visible = true;
				orb.position.copy( uniforms.svCenter.value[ i ] );
				orb.scale.setScalar( ORB_SIZE * pulse );
				orb.material.opacity = s.strength;

			}

			// faded right out and no longer wanted: the slot is free again
			if ( s.strength === 0 && ! s.wanted ) { this.free( i ); freed = true; }

		} );
		// a wanted panorama that found no free slot takes the one that just freed up
		if ( freed ) this.fill();
		// the credit names exactly the photos on screen, fading ones included
		const credited = this.slots.map( s => s.meta && s.strength > 0 ? s.meta.panoId : '' ).join();
		if ( credited !== this.credited ) { this.credited = credited; this.showCredit(); }

		// one depth cube every DEPTH_EVERY / SLOTS while tiles are changing, and only for panoramas
		// wanted and near you: a panorama still waiting for its first goes first, then the others in
		// turn, so tiles streaming in cannot keep any waiting
		const now = performance.now();
		if ( now > this.nextDepth ) {

			let i = this.slots.findIndex( ( s, j ) => shown[ j ] && ! s.depthReady );
			for ( let k = 1; i < 0 && k <= SLOTS; k ++ ) {

				const j = ( this.lastDepth + k ) % SLOTS;
				if ( shown[ j ] && this.slots[ j ].depthDirty ) i = j;

			}

			if ( i >= 0 ) {

				this.renderDepth( i );
				this.lastDepth = i;
				this.nextDepth = now + DEPTH_EVERY / SLOTS;

			}

		}

		// flying: nothing is asked of Google, but photos already held in memory are still put where they fit
		if ( this.enabled && ! settled && Math.hypot( position.x - this.lastCached.x, position.z - this.lastCached.z ) >= REQUERY ) { this.lastCached.copy( position ); this.lastQuery.set( Infinity, 0, 0 ); this.chooseHeld( position ); } // landing then looks afresh
		if ( ! this.enabled || ! settled || this.busy || this.refused || now < this.retryAt || Math.hypot( position.x - this.lastQuery.x, position.z - this.lastQuery.z ) < REQUERY ) return;
		this.lastQuery.copy( position );
		this.busy = true;
		// one that could not be made is tried again from here rather than only after moving on: soon
		// if the ground was not there yet, and ever more slowly while Google keeps answering with errors
		const retry = ( wait: number ) => { this.lastQuery.set( Infinity, 0, 0 ); this.retryAt = performance.now() + wait; };
		this.choose( position )
			.then( done => { this.failures = 0; if ( ! done ) retry( RETRY ); } )
			.catch( ( e: unknown ) => {

				if ( ! ( e instanceof Refused ) ) { console.warn( 'Street View:', e ); this.failures ++; }
				retry( Math.min( RETRY * 2 ** Math.max( this.failures - 1, 0 ), RETRY_MOST ) );

			} )
			.finally( () => { this.busy = false; } );

	}

	private async call( path: string, init?: RequestInit ) {

		if ( this.refused ) throw new Refused( 'waiting: Google asked for fewer requests' );
		const session = this.session ??= this.startSession();
		const r = await fetch( `${ API }/${ path }${ path.includes( '?' ) ? '&' : '?' }session=${ await session }&key=${ this.key }`, init );
		// too many requests, or the day's quota used up: ask nothing more for a while
		if ( r.status === 429 ) throw await this.refuse( r );

		if ( ! r.ok ) {

			const text = await r.text();
			// the session refused (expired, or another key's): the next request starts a new one. Any
			// other bad request keeps it, so the tiles keep their addresses and the browser's cache
			if ( ( r.status === 401 || r.status === 403 || ( r.status === 400 && /session/i.test( text ) ) ) && this.session === session ) this.forgetSession();
			throw new Error( `${ path.split( '?' )[ 0 ] } ${ r.status }: ${ text }` );

		}

		return r;

	}

	/** Google said "too many requests": wait, and say so once (not for every request turned away meanwhile). */
	private async refuse( r: Response ) {

		const text = await r.text();
		let message = text;
		try { message = ( JSON.parse( text ) as { error?: { message?: string } } ).error?.message ?? text; } catch { /* not JSON: as sent */ }
		const daily = /per day/i.test( message );
		if ( ! this.refused ) console.warn( `Street View: Google refused (429), nothing asked for ${ daily ? 10 : 1 } min.`, message );
		this.refusedUntil = performance.now() + ( daily ? REFUSED_DAY_WAIT : REFUSED_WAIT );
		this.refusedAt = Date.now();
		return new Refused( message );

	}

	/** Drop the session, here and on the device: the next request starts a new one. */
	private forgetSession() {

		this.session = null;
		try { localStorage.removeItem( SESSION_STORE ); } catch { /* storage blocked: nothing kept */ }

	}

	private async startSession() {

		// the one from an earlier visit, while it has a while left (Google's sessions last about two weeks)
		try {

			const kept = JSON.parse( localStorage.getItem( SESSION_STORE ) ?? 'null' ) as { session?: string, expiry?: string } | null;
			if ( kept?.session && Number( kept.expiry ) - Date.now() / 1000 > SESSION_MARGIN ) return kept.session;

		} catch { /* storage blocked or unreadable: start a new one */ }

		try {

			const r = await fetch( `${ API }/createSession?key=${ this.key }`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify( { mapType: 'streetview', language: 'en-GB', region: 'GB' } ) } );
			if ( r.status === 429 ) throw await this.refuse( r );

			if ( ! r.ok ) throw new Error( `session ${ r.status }: ${ await r.text() }` );
			const { session, expiry } = await r.json() as { session: string, expiry: string };
			try { localStorage.setItem( SESSION_STORE, JSON.stringify( { session, expiry } ) ); } catch { /* not kept: a new one next visit */ }
			return session;

		} catch ( e ) {

			this.session = null; // tried again by the next request
			throw e;

		}

	}

	/** Whether Google is still to be left alone after "too many requests". */
	private get refused() {

		return performance.now() < this.refusedUntil;

	}

	private metaCache = new Map<string, Metadata>();
	private async metadata( id: string ): Promise<Metadata> {

		let meta = this.metaCache.get( id );
		if ( ! meta ) {

			meta = await ( await this.call( `streetview/metadata?panoId=${ id }` ) ).json() as Metadata;
			this.metaCache.set( id, meta );

		}

		return meta;

	}

	/**
	 * Pick the panoramas to use. Each point takes the nearest one that can see it, so the more of the
	 * panoramas near you are on hand, the closer the photo each wall gets: the nearest to you, the
	 * nearest to points all around you, and the ones Street View links along the street.
	 */
	private async choose( position: Vector3 ): Promise<boolean> {

		const here = this.world.toLatLng( position );
		// the street you are on; nothing is looked up while you are above anything walkable
		const street = this.world.groundBelow( position, 0.5 );
		if ( street === null || position.y - street > 30 ) return false;
		// photos placed earlier, perhaps from somewhere else, are placed again from here
		for ( const s of this.slots ) {

			const ground = s.meta ? this.groundAt( s.meta, street ) : null;
			if ( ground !== null ) s.ground = ground;

		}

		// a grid of points within REACH of you, nearest first, so what is found runs roughly nearest first
		const points: { lat: number, lng: number, d: number }[] = [];
		const n = Math.floor( REACH / SPACING );
		for ( let i = - n; i <= n; i ++ ) for ( let j = - n; j <= n; j ++ ) {

			const d = Math.hypot( i, j ) * SPACING;
			if ( d <= REACH ) points.push( { lat: here.lat + i * SPACING / 111320, lng: here.lng + j * SPACING / ( 111320 * Math.cos( here.lat * DEG ) ), d } );

		}

		points.sort( ( a, b ) => a.d - b.d );
		const locations = points.map( ( { lat, lng } ) => ( { lat, lng } ) );
		const answer = await ( await this.call( 'streetview/panoIds', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify( { locations, radius: SPACING } ) } ) ).json() as { panoIds?: string[] };
		// Google sometimes answers with nothing at all, not even the empty places; that is not "no
		// Street View here", so it is tried again, ever more slowly while it lasts (see `update`)
		if ( ! Array.isArray( answer.panoIds ) ) throw new Error( 'Google answered the search with nothing' );
		const found = answer.panoIds.filter( id => id && looksGoogle( id ) );
		// switched off meanwhile: what was found is not used (switching on looks again)
		if ( ! this.enabled ) return true;
		// The first of Google's own found (at your spot if there is one there) is where the search
		// starts. None among the uploads: one already shown will do, its neighbours being nearby.
		const nearest = found[ 0 ] ?? this.slots.find( s => s.meta && s.wanted )?.meta?.panoId;
		// no Street View of Google's here: an answer all the same, not asked again until you move on
		if ( ! nearest ) return true;
		this.nearest = nearest;
		const meta = await this.metadata( nearest );
		if ( ! this.enabled ) return true;
		// The others, most likely useful first: the neighbours along the street of those known, then
		// those found all around. Google's own link only to Google's own, so following the links finds
		// them even where uploads crowd the search. Details already in memory cost nothing; the rest
		// are asked for as many at a time as are still needed, until there are enough to choose from.
		const linked = ( m: Metadata ) => ( m.links ?? [] ).map( l => l.panoId ).filter( looksGoogle );
		const queue = [ ...linked( meta ), ...found.slice( 1 ) ];
		const seen = new Set( [ nearest ] );
		const candidates: Metadata[] = [];
		const enough = () => candidates.filter( byGoogle ).length >= CHOOSE_FROM;
		let asked = 0;
		while ( queue.length && ! enough() && asked < MOST_DETAILS ) {

			const batch: string[] = [];
			while ( queue.length && batch.length < CHOOSE_FROM - candidates.filter( byGoogle ).length ) {

				const id = queue.shift()!;
				if ( seen.has( id ) ) continue;
				seen.add( id );
				const known = this.metaCache.get( id );
				if ( known ) { candidates.push( known ); queue.push( ...linked( known ) ); }
				else if ( performance.now() >= ( this.failed.get( id ) ?? 0 ) ) batch.push( id ); // one that failed lately is not asked again yet

			}

			asked += batch.length;
			const answers = await Promise.all( batch.map( id => this.metadata( id ).catch( ( e: unknown ) => {

				if ( ! ( e instanceof Refused ) ) this.failed.set( id, performance.now() + FAILED_WAIT );
				return null;

			} ) ) );
			if ( ! this.enabled ) return true;
			for ( const m of answers ) if ( m ) { candidates.push( m ); queue.push( ...linked( m ) ); }

		}

		const placed = candidates.filter( byGoogle ).map( m => ( { m, d: this.place( m.lat, m.lng, here.height, new Vector3() ).distanceTo( position ) } ) );
		// panoramas already showing stay unless a newcomer is clearly nearer, so two at nearly the
		// same distance do not take turns being loaded
		for ( const s of this.slots ) {

			if ( ! s.meta || s.meta.panoId === nearest || placed.some( p => p.m.panoId === s.meta?.panoId ) ) continue;
			placed.push( { m: s.meta, d: this.place( s.meta.lat, s.meta.lng, here.height, new Vector3() ).distanceTo( position ) } );

		}

		const loaded = ( id: string ) => this.slots.some( s => s.meta?.panoId === id );
		placed.sort( ( a, b ) => ( a.d - ( loaded( a.m.panoId ) ? KEEP : 0 ) ) - ( b.d - ( loaded( b.m.panoId ) ? KEEP : 0 ) ) );
		const wanted = [ ...( byGoogle( meta ) ? [ meta ] : [] ), ...placed.map( p => p.m ) ].slice( 0, SLOTS );
		const ids2 = new Set( wanted.map( m => m.panoId ) );
		for ( const s of this.slots ) s.wanted = !! s.meta && ids2.has( s.meta.panoId );
		this.wantedList = wanted;
		this.street = street;
		this.fill();
		return true;

	}

	/**
	 * `choose` without Google: while flying, the nearest photos already in memory (showing, or kept)
	 * are wanted, so flying low over streets walked earlier shows them again at no cost. Nothing is
	 * searched for or downloaded; only the details and photos this visit already has are used.
	 */
	private chooseHeld( position: Vector3 ) {

		const street = this.world.groundBelow( position, 0.5 );
		if ( street === null || position.y - street > 30 ) return;
		for ( const s of this.slots ) {

			const ground = s.meta ? this.groundAt( s.meta, street ) : null;
			if ( ground !== null ) s.ground = ground;

		}

		const here = this.world.toLatLng( position );
		const held = ( id: string ) => this.kept.has( id ) || this.slots.some( s => s.meta?.panoId === id );
		const wanted = [ ...this.metaCache.values() ].filter( m => byGoogle( m ) && held( m.panoId ) )
			.map( m => ( { m, d: this.place( m.lat, m.lng, here.height, new Vector3() ).distanceTo( position ) } ) )
			.filter( p => p.d < PAINT_RANGE + 20 )
			.sort( ( a, b ) => a.d - b.d ).slice( 0, SLOTS ).map( p => p.m );
		const ids = new Set( wanted.map( m => m.panoId ) );
		for ( const s of this.slots ) s.wanted = !! s.meta && ids.has( s.meta.panoId );
		this.wantedList = wanted;
		this.street = street;
		this.fill();

	}

	/**
	 * Load each wanted panorama not yet in a slot: from memory if it was seen before, otherwise
	 * downloaded, unless you are flying, Google is asking for fewer requests, or its pieces failed a
	 * short while ago.
	 */
	private fill() {

		if ( ! this.enabled ) return;
		const now = performance.now();
		// the list runs nearest first: photos in memory all come back at once; of the rest, only the
		// first not yet here downloads, and the next starts when it is done
		for ( const m of this.wantedList ) {

			if ( this.slots.some( s => s.meta?.panoId === m.panoId ) || this.pending.has( m.panoId ) ) continue;
			if ( this.kept.has( m.panoId ) ) { this.load( m, this.street ).catch( e => console.warn( 'Street View:', e ) ); continue; }
			if ( this.downloading || ! this.walking || this.refused || now < ( this.failed.get( m.panoId ) ?? 0 ) ) continue;
			this.downloading = true;
			this.load( m, this.street )
				.catch( e => console.warn( 'Street View:', e ) )
				.finally( () => { this.downloading = false; this.fill(); } );

		}

	}

	/**
	 * The ground under a panorama, so its centre sits at the camera's height above the road. Searched
	 * from just above the street you are on: from higher up the first hit could be a roof or a tree.
	 */
	private groundAt( meta: Metadata, street: number ) {

		return this.withAllTiles( () => this.world.groundBelow( this.place( meta.lat, meta.lng, street, this.tmp ), 3 ) );

	}

	/**
	 * Runs `work` with every tile in use in the scene, not only those in view: the renderer takes
	 * tiles outside the view out of the scene, but a panorama behind you stands on them, and they hide
	 * what it can see. They are put back for the moment, then taken out again.
	 */
	private withAllTiles<T>( work: () => T ): T {

		const { tiles } = this.world;
		const added: Object3D[] = [];
		const inScene = new Set( tiles.group.children );
		for ( const tile of tiles.activeTiles as Set<{ engineData?: { scene?: Object3D } }> ) {

			const sc = tile.engineData?.scene;
			if ( sc && ! inScene.has( sc ) ) { tiles.group.add( sc ); added.push( sc ); }

		}

		try { return work(); } finally {

			// out of the scene again, still attached to the group for raycasting (as the renderer leaves them)
			for ( const sc of added ) { tiles.group.remove( sc ); sc.parent = tiles.group; }

		}

	}

	private async load( meta: Metadata, street: number ) {

		this.pending.add( meta.panoId );
		try {

			const ground = this.groundAt( meta, street );
			// nothing loaded under it yet: tried again shortly, not straight away (which, as `fill`
			// starts the next download when one ends, would be at once and for ever)
			if ( ground === null ) { this.failed.set( meta.panoId, performance.now() + NO_GROUND_WAIT ); return; }
			// a photo seen earlier this session is still in memory: no download, no wait
			const kept = this.kept.get( meta.panoId );
			this.kept.delete( meta.panoId );
			let map = kept;
			if ( ! map ) {

				try { map = await this.loadImage( meta ); } catch ( e ) {

					// pieces that would not come, rather than Google asking to wait: not tried again for a while
					if ( ! ( e instanceof Refused ) ) this.failed.set( meta.panoId, performance.now() + FAILED_WAIT );
					throw e;

				}

			}

			// switched off while it was downloading, or no longer wanted since you walked on: paid for, so
			// kept for later. And it needs an empty slot; if none, it waits in memory until one fading out
			// is free (see `update`), rather than cutting that one off mid-fade.
			const i = this.slots.findIndex( s => ! s.meta );
			if ( ! this.enabled || i < 0 || ! this.wantedList.some( m => m.panoId === meta.panoId ) ) { this.keep( meta.panoId, map ); return; }
			const s = this.slots[ i ];
			s.meta = meta;
			s.map = map;
			s.ground = ground;
			s.wanted = true;
			s.strength = 0;
			// its depth is drawn by `update`, within the frame budget; it fades in once that is done
			s.depthDirty = true;
			s.depthReady = false;
			uniforms.svMap.value[ i ] = map;
			uniforms.svHeading.value[ i ] = meta.heading;
			uniforms.svPitch.value[ i ] = ( ( meta.tilt ?? 90 ) - 90 ) * DEG;
			uniforms.svTop.value[ i ] = ( map.userData.top as number | undefined ) ?? 0;
			this.place( meta.lat, meta.lng, ground + CAMERA_HEIGHT, uniforms.svCenter.value[ i ] );
			this.trim();

		} finally {

			this.pending.delete( meta.panoId );

		}

	}

	private enabled = true;

	/**
	 * Off: the photos fade away and nothing more is looked up or downloaded, but every photo stays in
	 * memory (up to KEPT), so switching back on shows them again without paying for them twice.
	 * On: looked up afresh from where you are.
	 */
	setEnabled( on: boolean ) {

		if ( on === this.enabled ) return;
		this.enabled = on;
		// switching on looks again at once, whether walking (a search) or flying (the photos held)
		this.lastQuery.set( Infinity, 0, 0 );
		this.lastCached.set( Infinity, 0, 0 );
		if ( on ) return;
		for ( const s of this.slots ) s.wanted = false;

	}

	/**
	 * Photos no longer drawn, kept for this session in case you come back (most recently used last).
	 * Only in memory: Google's terms allow no storing beyond the session.
	 */
	private kept = new Map<string, Texture>();

	/** Keep a photo that is no longer drawn. */
	private keep( id: string, map: Texture ) {

		this.kept.delete( id );
		this.kept.set( id, map );
		this.trim();

	}

	/** Past KEPT photos in all, drawn or kept, the longest unused go. */
	private trim() {

		const inUse = this.slots.filter( s => s.map ).length;
		for ( const [ old, texture ] of this.kept ) {

			if ( this.kept.size + inUse <= KEPT ) break;
			texture.dispose();
			// one never drawn still holds its picture (drawing it is what lets that go)
			const image: unknown = texture.image;
			if ( image instanceof ImageBitmap ) image.close();
			this.kept.delete( old );

		}

	}

	private free( i: number ) {

		const s = this.slots[ i ];
		const { meta, map } = s;
		s.map = null;
		s.meta = null;
		s.strength = 0;
		s.wanted = false;
		uniforms.svMap.value[ i ] = blank;
		uniforms.svStrength.value[ i ] = 0;
		// counted once, as kept, now that the slot no longer holds it
		if ( meta && map ) this.keep( meta.panoId, map );

	}

	/** Each panorama's date and copyright, and its link to report a problem, as Street View requires. */
	private showCredit() {

		// One short line for all the photos on screen, fading ones included: each copyright once (Google
		// requires it with every panorama) and the report link of the panorama nearest you (also required;
		// each panorama has its own).
		const shown = this.slots.filter( s => s.meta && s.strength > 0 ).map( s => s.meta! );
		this.credit.replaceChildren();
		if ( ! shown.length ) return;
		const owners = [ ...new Set( shown.map( m => ( m.copyright ?? '' ).replace( /^From the Owner, /, '' ) ).filter( Boolean ) ) ].join( '; ' );
		this.credit.append( owners || 'Street View' );
		const nearest = shown.find( m => m.panoId === this.nearest ) ?? shown[ 0 ];
		if ( nearest.reportProblemLink?.startsWith( 'https://' ) ) {

			this.credit.append( ' · ' );
			const a = document.createElement( 'a' );
			a.href = nearest.reportProblemLink; a.target = '_blank'; a.rel = 'noreferrer'; a.textContent = 'Report problem';
			a.style.cssText = 'color:#fff;pointer-events:auto';
			this.credit.append( a );

		}

	}

	/** The panorama at ZOOM, stitched from its tiles into one equirectangular image. */
	private async loadImage( meta: Metadata ): Promise<Texture> {

		const maxZoom = Math.ceil( Math.log2( meta.imageWidth / meta.tileWidth ) );
		const scale = 2 ** ( maxZoom - ZOOM );
		const width = Math.round( meta.imageWidth / scale ), height = Math.round( meta.imageHeight / scale );
		const cols = Math.ceil( width / meta.tileWidth ), rows = Math.ceil( height / meta.tileHeight );
		// rows wholly above SKIP_ABOVE degrees are not fetched (row y's lower edge is at this elevation)
		let first = 0;
		while ( first < rows - 1 && 90 - ( first + 1 ) * meta.tileHeight / height * 180 >= SKIP_ABOVE ) first ++;
		const fetched = ( rows - first ) * cols;
		const job = this.stitch( width, height );
		const jobs: Promise<void>[] = [];
		let missing = 0, firstError: unknown = null, refused = false;
		for ( let y = first; y < rows; y ++ ) for ( let x = 0; x < cols; x ++ ) {

			// a tile that fails is tried once more; one still missing leaves a gap rather than no panorama
			const tile = () => this.call( `streetview/tiles/${ ZOOM }/${ x }/${ y }?panoId=${ meta.panoId }` ).then( r => r.blob() );
			jobs.push( tile().catch( () => tile() )
				.then( blob => job.add( blob, x * meta.tileWidth, y * meta.tileHeight ) )
				.catch( ( e: unknown ) => { missing ++; firstError ??= e; refused ||= e instanceof Refused; } ) );

		}

		await Promise.all( jobs );
		// Google asked to wait part-way through: the gaps are not the photo's, so neither shown nor
		// kept; it is downloaded whole once the wait is over (see `update`)
		if ( refused ) { job.cancel(); throw new Refused( `${ meta.panoId } cut short: Google asked for fewer requests` ); }
		// Stitched in the worker; handed over as an ImageBitmap, which the graphics card takes as it
		// is. The bitmap is freed once it is on the card (a lost context means a reload in this app).
		const { bitmap, broken } = await job.finish();
		missing += broken;
		// more gap than photo: not shown (it would paint the walls black), and not kept
		if ( missing > fetched / 4 ) { bitmap.close(); throw new Error( `${ missing } of ${ fetched } pieces of ${ meta.panoId } missing`, { cause: firstError } ); }
		if ( missing ) console.warn( `Street View: ${ missing } of ${ fetched } pieces of ${ meta.panoId } missing`, firstError );
		const texture = new Texture( bitmap );
		texture.userData.top = first * meta.tileHeight / height;
		texture.onUpdate = () => bitmap.close();
		texture.colorSpace = SRGBColorSpace;
		texture.flipY = false;
		// no mipmaps, as for the 3D tiles: they add nothing here (the photo is seldom shrunk), take a
		// third more memory, and would draw a seam where the photo's two edges meet
		texture.generateMipmaps = false;
		texture.minFilter = LinearFilter;
		texture.needsUpdate = true;
		return texture;

	}

	/** A stitching job in the worker: tiles are sent as they arrive, the photo comes back at the end. */
	private stitch( width: number, height: number ) {

		if ( ! this.stitcher && ! this.noWorker ) {

			try {

				const url = URL.createObjectURL( new Blob( [ STITCHER ], { type: 'text/javascript' } ) );
				this.stitcher = new Worker( url );
				URL.revokeObjectURL( url );
				this.stitcher.onmessage = ( { data }: MessageEvent<{ id: number, bitmap?: ImageBitmap, broken?: number, error?: string }> ) => {

					const job = this.stitched.get( data.id );
					this.stitched.delete( data.id );
					if ( data.bitmap ) job?.resolve( { bitmap: data.bitmap, broken: data.broken ?? 0 } );
					else job?.reject( new Error( `stitching failed: ${ data.error }` ) );

				};
				// the worker itself broke: every job waiting on it fails, and later ones are stitched here
				this.stitcher.onerror = this.stitcher.onmessageerror = () => this.dropWorker();

			} catch { this.noWorker = true; }

		}

		const worker = this.stitcher;
		if ( ! worker ) return this.stitchHere( width, height );
		const id = this.nextJob ++;
		worker.postMessage( { id, kind: 'start', width, height } );
		return {
			add: ( blob: Blob, x: number, y: number ) => worker.postMessage( { id, kind: 'tile', blob, x, y } ),
			cancel: () => worker.postMessage( { id, kind: 'cancel' } ),
			finish: () => new Promise<Stitched>( ( resolve, reject ) => {

				const timer = setTimeout( () => { this.stitched.delete( id ); worker.postMessage( { id, kind: 'cancel' } ); reject( new Error( 'stitching took too long' ) ); }, STITCH_WAIT );
				this.stitched.set( id, {
					resolve: result => { clearTimeout( timer ); resolve( result ); },
					reject: error => { clearTimeout( timer ); reject( error ); },
				} );
				worker.postMessage( { id, kind: 'finish' } );

			} ),
		};

	}

	private dropWorker() {

		this.noWorker = true;
		this.stitcher?.terminate();
		this.stitcher = null;
		for ( const job of this.stitched.values() ) job.reject( new Error( 'the stitching worker stopped' ) );
		this.stitched.clear();

	}

	/** The same, on the page itself, where there is no worker that can draw (Safari before 16.4). */
	private stitchHere( width: number, height: number ) {

		const canvas = document.createElement( 'canvas' );
		canvas.width = width; canvas.height = height;
		const g = canvas.getContext( '2d' );
		const drawing: Promise<void>[] = [];
		let broken = 0;
		return {
			add: ( blob: Blob, x: number, y: number ) => void drawing.push( createImageBitmap( blob )
				.then( img => { g?.drawImage( img, x, y ); img.close(); } )
				.catch( () => { broken ++; } ) ),
			cancel: () => { canvas.width = canvas.height = 1; },
			finish: async (): Promise<Stitched> => {

				if ( ! g ) throw new Error( `no room for a ${ width } x ${ height } picture` );
				await Promise.all( drawing );
				const bitmap = await createImageBitmap( canvas );
				canvas.width = canvas.height = 1;
				return { bitmap, broken };

			},
		};

	}

	/** Scene position of a latitude, longitude and height above the ellipsoid. */
	private place( lat: number, lng: number, height: number, target: Vector3 ) {

		const { ellipsoid, group } = this.world.tiles;
		ellipsoid.getCartographicToPosition( lat * DEG, lng * DEG, height, target );
		return target.applyMatrix4( group.matrixWorld );

	}

	/**
	 * Distances from a panorama's centre to the nearest surface, in every direction, out to
	 * DEPTH_REACH, drawn from every tile in use, not only those in view (see `withAllTiles`; those
	 * beyond the cube's reach are left out by the cube's own cameras).
	 */
	private renderDepth( i: number ) {

		const s = this.slots[ i ];
		s.depthDirty = false;
		s.depthReady = true;
		this.withAllTiles( () => this.drawDepth( i ) );

	}

	private drawDepth( i: number ) {

		const s = this.slots[ i ];
		const { renderer } = this;
		const target = renderer.getRenderTarget();
		const before = this.scene.overrideMaterial;
		// Each face starts empty: distance 0, read as open sky. The effects pipeline turns the
		// renderer's own clearing off, so it is switched on just for this, or the cube would keep the
		// distances of whatever it showed before (another panorama, or tiles since replaced).
		const autoClear = renderer.autoClear, clearAlpha = renderer.getClearAlpha();
		renderer.getClearColor( this.clearColor );
		renderer.autoClear = true;
		renderer.setClearColor( 0x000000, 0 );
		this.scene.overrideMaterial = this.distance;
		this.depthCenter.value.copy( uniforms.svCenter.value[ i ] );
		this.cubeCamera.renderTarget = s.cube;
		this.cubeCamera.position.copy( uniforms.svCenter.value[ i ] );
		this.cubeCamera.update( renderer, this.scene );
		this.scene.overrideMaterial = before;
		renderer.autoClear = autoClear;
		renderer.setClearColor( this.clearColor, clearAlpha );
		renderer.setRenderTarget( target );

	}

}
