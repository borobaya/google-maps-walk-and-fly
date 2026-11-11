import { Matrix4, Raycaster, Vector3, type Camera, type Intersection, type WebGLRenderer } from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { TilesRenderer } from '3d-tiles-renderer';
import { GLTFExtensionsPlugin, GoogleCloudAuthPlugin, TileCompressionPlugin, TilesFadePlugin } from '3d-tiles-renderer/plugins';

export interface Hit {
	point: Vector3;
	normal: Vector3;
	distance: number;
}

export interface LatLng {
	/** degrees */
	lat: number;
	/** degrees */
	lng: number;
	/** metres above the ellipsoid */
	height: number;
}

const DEG = Math.PI / 180;
const UP = new Vector3( 0, 1, 0 );
const DOWN = new Vector3( 0, - 1, 0 );
// east-north-up coordinates -> scene coordinates (-X east, +Y up, +Z north)
const ENU_TO_SCENE = new Matrix4().set(
	- 1, 0, 0, 0,
	0, 0, 1, 0,
	0, 1, 0, 0,
	0, 0, 0, 1,
);

/**
 * Google's photorealistic 3D tiles, placed so that a chosen point on Earth sits
 * at the scene origin with +Y up, +Z north and -X east.
 */
export class World {

	readonly tiles: TilesRenderer;
	/** `fatal` is false when tiles start failing after the world had loaded. */
	onError: ( ( message: string, fatal: boolean ) => void ) | null = null;
	private failures: number[] = [];
	private lastWarned = - Infinity;

	private raycaster = new Raycaster();
	private frame = new Matrix4();
	private hits: Intersection[] = [];
	private tmp = new Vector3();

	constructor( apiKey: string, camera: Camera, renderer: WebGLRenderer ) {

		const tiles = new TilesRenderer();
		tiles.registerPlugin( new GoogleCloudAuthPlugin( { apiToken: apiKey, autoRefreshToken: true } ) );
		tiles.registerPlugin( new TileCompressionPlugin() );
		tiles.registerPlugin( new GLTFExtensionsPlugin( {
			dracoLoader: new DRACOLoader().setDecoderPath( `${ import.meta.env.BASE_URL }draco/` ),
		} ) );

		// cross-fade tiles as detail levels swap, instead of popping
		tiles.registerPlugin( new TilesFadePlugin() );

		// keep more of the world in memory and load it faster
		tiles.lruCache.minBytesSize = 0.5 * 2 ** 30;
		tiles.lruCache.maxBytesSize = 0.75 * 2 ** 30;
		tiles.parseQueue.maxJobs = 10;

		// sharpen textures seen at shallow angles (the ground when walking)
		const anisotropy = renderer.capabilities.getMaxAnisotropy();
		tiles.addEventListener( 'load-model', ( e: any ) => {

			e.scene.traverse( ( o: any ) => {

				const map = o.material?.map;
				if ( map ) {

					map.anisotropy = anisotropy;
					map.needsUpdate = true;

				}

			} );

		} );

		tiles.setCamera( camera );
		tiles.setResolutionFromRenderer( camera, renderer );
		tiles.addEventListener( 'load-error', ( e: any ) => {

			const message = String( e.error?.message ?? e.error ?? 'Tiles failed to load' );
			// the root failing is fatal (bad key, API not enabled, quota)
			if ( ! tiles.root ) return this.onError?.( message, true );

			// One tile failing is normal. A run of them means the quota ran out, the session
			// expired or the network dropped: say so, instead of leaving silent holes.
			const now = performance.now();
			this.failures = this.failures.filter( t => now - t < 10000 );
			this.failures.push( now );
			if ( this.failures.length >= 5 && now - this.lastWarned > 30000 ) {

				this.lastWarned = now;
				this.onError?.( message, false );

			}

		} );

		( this.raycaster as any ).firstHitOnly = true;
		this.tiles = tiles;

	}

	/** Re-centre the world so the given point is at the origin. */
	anchor( latDeg: number, lngDeg: number ) {

		const { group, ellipsoid } = this.tiles;
		ellipsoid.getEastNorthUpFrame( latDeg * DEG, lngDeg * DEG, 0, this.frame );
		this.frame.invert().premultiply( ENU_TO_SCENE ).decompose( group.position, group.quaternion, group.scale );
		group.updateMatrixWorld( true );

	}

	/**
	 * Re-anchor on a scene position, keeping it at the same place on Earth.
	 * `position` and `direction` are rewritten into the new frame.
	 */
	reanchorOn( position: Vector3, direction: Vector3 ) {

		const group = this.tiles.group;
		const ll = this.toLatLng( position );
		position.applyMatrix4( group.matrixWorldInverse );
		direction.transformDirection( group.matrixWorldInverse );
		this.anchor( ll.lat, ll.lng );
		position.applyMatrix4( group.matrixWorld );
		direction.transformDirection( group.matrixWorld );

	}

	toLatLng( position: Vector3 ): LatLng {

		const { group, ellipsoid } = this.tiles;
		const ecef = this.tmp.copy( position ).applyMatrix4( group.matrixWorldInverse );
		const c = ellipsoid.getPositionToCartographic( ecef, {} );
		return { lat: c.lat / DEG, lng: c.lon / DEG, height: c.height };

	}

	/** First surface hit along a ray, or null. */
	cast( origin: Vector3, direction: Vector3, far = Infinity ): Hit | null {

		const rc = this.raycaster;
		rc.set( origin, direction );
		rc.near = 0;
		rc.far = far;
		this.hits.length = 0;
		rc.intersectObject( this.tiles.group, true, this.hits );
		const hit = this.hits[ 0 ];
		if ( ! hit ) return null;

		const normal = new Vector3( 0, 1, 0 );
		if ( hit.face ) normal.copy( hit.face.normal ).transformDirection( hit.object.matrixWorld );
		// make the normal face the ray origin regardless of triangle winding
		if ( normal.dot( direction ) > 0 ) normal.negate();
		return { point: hit.point.clone(), normal, distance: hit.distance };

	}

	/** The surface directly below a point (optionally starting `lift` metres higher), or null. */
	ground( position: Vector3, lift = 0 ): Hit | null {

		return this.cast( this.tmp.copy( position ).addScaledVector( UP, lift ).clone(), DOWN );

	}

	/** Height of the surface directly below a point, or null if nothing is loaded there. */
	groundBelow( position: Vector3, lift = 0 ): number | null {

		const hit = this.ground( position, lift );
		return hit ? hit.point.y : null;

	}

	/** Height of the topmost surface in this column (used to recover from being underground). */
	topSurface( position: Vector3 ): number | null {

		return this.groundBelow( position, 9000 );

	}

	update() {

		this.tiles.update();

	}

	attributions(): string {

		return this.tiles.getAttributions()
			.filter( a => a.type === 'string' )
			.map( a => String( a.value ) )
			.join( '; ' );

	}

}
