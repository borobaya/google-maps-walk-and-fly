import { MathUtils, Vector3, type PerspectiveCamera } from 'three';
import type { World } from './world';

export type Mode = 'walk' | 'fly';

const EYE = 1.7; // eye height above the feet, metres
const RADIUS = 0.4; // body radius for wall checks
const STEP = 0.6; // tallest ledge you can step onto
const WALK_SPEED = 4;
const RUN_SPEED = 11;
const JUMP_SPEED = 5.5;
const GRAVITY = 20;
const TERMINAL = 70;
const FLY_CLEARANCE = 1.2;
const SPAWN_HEIGHT = 180; // metres above ground after a teleport
const REANCHOR_DISTANCE = 1000;
const LOOK_SENSITIVITY = 0.004; // radians per pixel dragged
const KEY_TURN_RATE = 2.0; // rad/s when turning with the arrow keys
const KEY_PITCH_RATE = 1.2; // rad/s when tilting the view with W / S
const BASE_FOV = 70;
const MAX_DROP = 150; // a ground reading this far below the last one is not believed straight away
const BODY = 1.0; // when flying, stay at least this far from walls on every side
const FEELER = 60; // how far to look for nearby walls, metres
const DOUBLE_TAP = 0.3; // seconds between Space presses that toggles flying

const UP = new Vector3( 0, 1, 0 );

export class Player {

	mode: Mode = 'fly';
	/** Eye position in scene space. */
	readonly position = new Vector3( 0, 1500, 0 );
	readonly velocity = new Vector3();
	yaw = Math.PI; // facing north
	pitch = - 0.35;
	/** True while waiting for terrain to load under a new location. */
	settling = true;
	/** Height of the feet (walk) or eyes (fly) above the surface below. */
	heightAboveGround = 0;
	speed = 0;
	/** Distance to the nearest wall around you when flying (capped), used to set how close the camera can draw. */
	clearance = 60;
	/** Frames in flight where no ground could be found (tiles still loading); for diagnostics. */
	groundMisses = 0;
	/** Scroll-wheel multiplier for flying speed. */
	flyScale = 1;
	/** True while a mouse button is held on the scene to look around. */
	dragging = false;
	/** True once the mouse has been used to look, so the hint can go away. */
	hasLooked = false;
	/** Camera field of view in degrees; widens with speed. */
	fov = BASE_FOV;

	private keys = new Set<string>();
	private grounded = false;
	private roll = 0;
	private yawRate = 0;
	private yawBefore = Math.PI;
	private renderY = 1500;
	private settleTime = 0;
	private lastSpace = - Infinity;
	private lastGround = - Infinity;
	private suspectFrames = 0;
	private speedHeight = SPAWN_HEIGHT;
	private fovTarget = BASE_FOV;
	private bob = 0;

	private forward = new Vector3();
	private right = new Vector3();
	private move = new Vector3();
	private tmp = new Vector3();
	private last = new Vector3();

	private world: World;
	private camera: PerspectiveCamera;
	private dom: HTMLElement;

	constructor( world: World, camera: PerspectiveCamera, dom: HTMLElement ) {

		this.world = world;
		this.camera = camera;
		this.dom = dom;
		camera.rotation.order = 'YXZ';
		this.bindInput();

	}

	get heading(): number {

		// compass bearing in degrees, clockwise from north
		return MathUtils.euclideanModulo( 180 - this.yaw * MathUtils.RAD2DEG, 360 );

	}

	/** Jump to a place on Earth; you arrive in the air above it. */
	teleport( lat: number, lng: number ) {

		this.world.anchor( lat, lng );
		this.position.set( 0, 1500, 0 );
		this.renderY = 1500;
		this.velocity.set( 0, 0, 0 );
		this.pitch = - 0.35;
		this.mode = 'fly';
		this.grounded = false;
		this.settling = true;
		this.settleTime = 0;
		this.lastGround = - Infinity;

	}

	toggleMode() {

		if ( this.settling ) return;
		if ( this.mode === 'fly' ) {

			// fold the wings: gravity takes over until you land
			this.mode = 'walk';
			this.grounded = false;

		} else {

			this.mode = 'fly';
				this.velocity.y = Math.max( this.velocity.y, 6 );

		}

	}

	update( dt: number ) {

		this.keyLook( dt );
		this.last.copy( this.position );

		if ( this.settling ) this.settle( dt );
		else if ( this.mode === 'walk' ) this.walk( dt );
		else this.fly( dt );

		this.speed = this.settling ? 0 : this.position.distanceTo( this.last ) / dt;
		this.reanchor();
		// turning measured since the last frame, so steering with the mouse banks too
		this.applyCamera( dt, ( this.yaw - this.yawBefore ) / dt );
		this.yawBefore = this.yaw;

	}

	// --- movement -------------------------------------------------------

	private settle( dt: number ) {

		const top = this.world.topSurface( this.position );
		if ( top === null ) return;

		// give the coarse terrain a moment to refine before trusting its height
		this.settleTime += dt;
		if ( this.settleTime < 0.8 ) return;
		this.position.y = top + SPAWN_HEIGHT;
		this.lastGround = top;
		this.speedHeight = SPAWN_HEIGHT;
		this.renderY = this.position.y;
		this.heightAboveGround = SPAWN_HEIGHT;
		this.settling = false;

	}

	private axes() {

		const k = this.keys;
		return {
			z: ( k.has( 'ArrowUp' ) ? 1 : 0 ) - ( k.has( 'ArrowDown' ) ? 1 : 0 ),
			x: ( k.has( 'KeyD' ) ? 1 : 0 ) - ( k.has( 'KeyA' ) ? 1 : 0 ),
			y: ( k.has( 'Space' ) ? 1 : 0 ) - ( k.has( 'KeyC' ) || k.has( 'ControlLeft' ) ? 1 : 0 ),
			fast: k.has( 'ShiftLeft' ) || k.has( 'ShiftRight' ),
		};

	}

	private walk( dt: number ) {

		const { world, position, velocity } = this;
		const a = this.axes();

		// horizontal intent, relative to where you face
		this.forward.set( - Math.sin( this.yaw ), 0, - Math.cos( this.yaw ) );
		this.right.set( Math.cos( this.yaw ), 0, - Math.sin( this.yaw ) );
		const target = this.move.set( 0, 0, 0 )
			.addScaledVector( this.forward, a.z )
			.addScaledVector( this.right, a.x );
		if ( target.lengthSq() > 0 ) target.normalize().multiplyScalar( a.fast ? RUN_SPEED : WALK_SPEED );

		// quick response on the ground, little control in the air
		const blend = 1 - Math.exp( - dt * ( this.grounded ? 12 : 1.5 ) );
		velocity.x += ( target.x - velocity.x ) * blend;
		velocity.z += ( target.z - velocity.z ) * blend;

		this.blockWalls( dt );
		position.x += velocity.x * dt;
		position.z += velocity.z * dt;

		// vertical: follow the ground, or fall
		let feet = position.y - EYE;
		const probe = this.tmp.set( position.x, feet, position.z );
		// in the air the feet may already be below a surface, so look down from eye level
		let ground = this.trusted( world.groundBelow( probe, this.grounded ? STEP : EYE ) );

		if ( ground === null ) {

			// nothing below: either we slipped under the mesh or it is not loaded yet
			const top = world.topSurface( probe );
			if ( top === null || top < this.lastGround - MAX_DROP ) {

				// no ground we can believe in: stay put until the tiles arrive
				velocity.y = 0;
				return;

			}

			ground = feet = top;
			this.grounded = true;
			velocity.y = 0;

		}

		if ( this.grounded ) {

			if ( a.y > 0 ) {

				velocity.y = JUMP_SPEED;
				this.grounded = false;

			} else if ( feet - ground > STEP ) {

				this.grounded = false; // walked off a ledge

			} else {

				feet = ground;
				velocity.y = 0;

			}

		}

		if ( ! this.grounded ) {

			// bump your head on anything overhead
			if ( velocity.y > 0 ) {

				const head = this.tmp.set( position.x, feet + EYE, position.z );
				if ( world.cast( head, UP, velocity.y * dt + 0.25 ) ) velocity.y = 0;

			}

			velocity.y = Math.max( velocity.y - GRAVITY * dt, - TERMINAL );
			feet += velocity.y * dt;
			if ( feet <= ground && velocity.y <= 0 ) {

				feet = ground;
				velocity.y = 0;
				this.grounded = true;

			}

		}

		position.y = feet + EYE;
		this.heightAboveGround = feet - ground;
		this.lastGround = ground;
		this.fovTarget = BASE_FOV + ( a.fast && a.z > 0 && this.grounded ? 5 : 0 );

	}

	/**
	 * Stop horizontal motion into steep surfaces, sliding along them instead.
	 * Feelers at knee, waist and head height, plus one at each shoulder, give the
	 * body some width so it cannot clip corners or squeeze through gaps.
	 */
	private blockWalls( dt: number ) {

		const { world, position, velocity } = this;
		const feet = position.y - EYE;
		const waist = feet + 1.0;
		const side = RADIUS * 0.85;

		for ( let pass = 0; pass < 2; pass ++ ) {

			const dir = this.move.set( velocity.x, 0, velocity.z );
			const stepLength = dir.length() * dt;
			if ( stepLength < 1e-5 ) return;
			dir.normalize();

			// [ sideways offset, height ]
			const feelers = [
				[ 0, feet + STEP + 0.1 ], [ 0, waist ], [ 0, position.y - 0.1 ],
				[ side, waist ], [ - side, waist ],
			];

			let blocked = false;
			for ( const [ offset, height ] of feelers ) {

				// dir is horizontal, so ( -dir.z, 0, dir.x ) points to one side
				const origin = this.tmp.set( position.x - dir.z * offset, height, position.z + dir.x * offset );
				const hit = world.cast( origin, dir, RADIUS + stepLength );
				if ( ! hit || Math.abs( hit.normal.y ) > 0.7 ) continue;

				const n = hit.normal.setY( 0 ).normalize();
				const into = velocity.x * n.x + velocity.z * n.z;
				if ( into < 0 ) {

					velocity.x -= n.x * into;
					velocity.z -= n.z * into;

				}

				blocked = true;
				break;

			}

			if ( ! blocked ) return;

		}

		// still blocked after sliding (a corner): stop
		velocity.x = velocity.z = 0;

	}

	/**
	 * Feel around in flight: push away from anything closer than BODY (so the view never
	 * pokes through a wall or a steep hillside) and note the nearest obstacle.
	 */
	private keepClear() {

		const { world, position } = this;
		let nearest = FEELER;
		const sin = Math.sin( this.yaw ), cos = Math.cos( this.yaw );
		const dirs = [ [ - sin, 0, - cos ], [ sin, 0, cos ], [ cos, 0, - sin ], [ - cos, 0, sin ], [ 0, 1, 0 ] ];

		for ( const [ x, y, z ] of dirs ) {

			const dir = this.move.set( x, y, z );
			const hit = world.cast( position, dir, FEELER );
			if ( ! hit ) continue;

			if ( hit.distance < BODY ) {

				position.addScaledVector( dir, hit.distance - BODY );
				const into = this.velocity.dot( dir );
				if ( into > 0 ) this.velocity.addScaledVector( dir, - into );
				hit.distance = BODY;

			}

			nearest = Math.min( nearest, hit.distance );

		}

		this.clearance = nearest;

	}

	/**
	 * While tiles are being swapped for finer ones there can briefly be a hole under you, and a
	 * ray through it reports "ground" kilometres down. Ignore a reading that suddenly drops far
	 * below the last one unless it keeps saying so (a real cliff edge does).
	 */
	private trusted( ground: number | null ): number | null {

		if ( ground === null ) return null;
		if ( ground < this.lastGround - MAX_DROP && ++ this.suspectFrames < 30 ) return null;
		this.suspectFrames = 0;
		return ground;

	}

	private fly( dt: number ) {

		const { world, position, velocity } = this;
		const a = this.axes();
		const cp = Math.cos( this.pitch );

		// you go where you look
		this.forward.set( - Math.sin( this.yaw ) * cp, Math.sin( this.pitch ), - Math.cos( this.yaw ) * cp );
		this.right.set( Math.cos( this.yaw ), 0, - Math.sin( this.yaw ) );

		// faster the higher you are, so streets and whole cities both feel right
		// (the height is smoothed, so passing over a rooftop or a cliff edge does not jolt your speed)
		this.speedHeight += ( this.heightAboveGround - this.speedHeight ) * ( 1 - Math.exp( - dt * 1.5 ) );
		const base = MathUtils.clamp( this.speedHeight * 0.5, 15, 1500 );
		const top = base * this.flyScale * ( a.fast ? 3 : 1 );

		// You only move while a key is held: forward or (more slowly) backward along the view,
		// sideways, and gently straight up or down. Let go and you come to a stop.
		const target = this.move.set( 0, 0, 0 )
			.addScaledVector( this.forward, a.z > 0 ? top : a.z < 0 ? - top * 0.5 : 0 )
			.addScaledVector( this.right, a.x * top * 0.5 )
			.addScaledVector( UP, a.y * top * 0.25 );

		// ease in and out quickly, so starts and stops are smooth but there is no gliding on
		velocity.addScaledVector( target.sub( velocity ), 1 - Math.exp( - dt * 4 ) );
		if ( target.lengthSq() === 0 && velocity.lengthSq() < 0.01 ) velocity.set( 0, 0, 0 );

		// don't fly through buildings or hillsides: slide along them
		const stepLength = velocity.length() * dt;
		if ( stepLength > 1e-5 ) {

			const dir = this.tmp.copy( velocity ).normalize();
			const hit = world.cast( position, dir, stepLength + FLY_CLEARANCE );
			if ( hit ) {

				// treat lumpy, overhanging walls as vertical so you can always climb up them
				if ( Math.abs( hit.normal.y ) < 0.7 ) hit.normal.setY( 0 ).normalize();
				const into = velocity.dot( hit.normal );
				if ( into < 0 ) velocity.addScaledVector( hit.normal, - into );

			}

		}

		position.addScaledVector( velocity, dt );
		this.keepClear();

		// keep above the surface
		const ground = this.trusted( world.groundBelow( position ) );
		if ( ground !== null ) {

			if ( position.y < ground + FLY_CLEARANCE ) {

				position.y = ground + FLY_CLEARANCE;
				velocity.y = Math.max( velocity.y, 0 );

			}

			// descending onto the ground lands you
			if ( a.y < 0 && position.y < ground + FLY_CLEARANCE + 0.3 ) {

				// stand on the surface (eyes are higher on foot than when skimming it)
				this.mode = 'walk';
				this.grounded = true;
				velocity.set( 0, 0, 0 );
				position.y = ground + EYE;

			}

			this.heightAboveGround = position.y - ground;
			this.lastGround = ground;

		} else {

			const topSurface = world.topSurface( position );
			if ( topSurface !== null && topSurface > position.y ) {

				position.y = topSurface + FLY_CLEARANCE;
				velocity.y = Math.max( velocity.y, 0 );
				this.heightAboveGround = FLY_CLEARANCE;
				this.lastGround = topSurface;

			} else {

				// Nothing reliable to measure against: the tiles here are still loading. Hold the
				// last known ground level so you cannot sink through the world in the meantime.
				this.groundMisses ++;
				if ( position.y < this.lastGround + FLY_CLEARANCE ) {

					position.y = this.lastGround + FLY_CLEARANCE;
					velocity.y = Math.max( velocity.y, 0 );

				}

				this.heightAboveGround = position.y - this.lastGround;

			}

		}

		// the view widens as you pick up speed
		this.fovTarget = BASE_FOV + 16 * MathUtils.clamp( velocity.length() / ( base * this.flyScale * 3 ), 0, 1 );

	}

	/** Keep the player near the scene origin so "up" stays up anywhere on Earth. */
	private reanchor() {

		const p = this.position;
		if ( Math.hypot( p.x, p.z ) < REANCHOR_DISTANCE ) return;

		const dir = this.tmp.set( - Math.sin( this.yaw ), 0, - Math.cos( this.yaw ) );
		const dy = this.renderY - p.y;
		const dGround = this.lastGround - p.y;
		this.world.reanchorOn( p, dir );
		this.lastGround = p.y + dGround;
		const before = this.yaw;
		this.yaw = Math.atan2( - dir.x, - dir.z );
		this.yawBefore += this.yaw - before;
		this.renderY = p.y + dy;

	}

	private applyCamera( dt: number, yawRate: number ) {

		const cam = this.camera;

		// smooth out steps and kerbs while walking
		if ( this.mode === 'walk' && this.grounded ) {

			this.renderY += ( this.position.y - this.renderY ) * ( 1 - Math.exp( - dt * 18 ) );
			this.bob += Math.hypot( this.velocity.x, this.velocity.z ) * dt * 2.2;

		} else {

			this.renderY = this.position.y;

		}

		// bank into turns when flying
		this.yawRate += ( yawRate - this.yawRate ) * ( 1 - Math.exp( - dt * 8 ) );
		const a = this.axes();
		const bank = this.mode === 'fly' && ! this.settling
			? MathUtils.clamp( this.yawRate * 0.22, - 0.6, 0.6 ) - a.x * 0.1
			: 0;
		this.roll += ( bank - this.roll ) * ( 1 - Math.exp( - dt * 4 ) );
		this.fov += ( ( this.settling ? BASE_FOV : this.fovTarget ) - this.fov ) * ( 1 - Math.exp( - dt * 3 ) );

		// a slight bounce in your step
		const bounce = this.mode === 'walk' && this.grounded ? Math.sin( this.bob ) * 0.03 : 0;
		cam.position.set( this.position.x, this.renderY + bounce, this.position.z );
		cam.rotation.set( this.pitch, this.yaw, this.roll );
		cam.updateMatrixWorld();

	}

	// --- input ----------------------------------------------------------

	private look( dx: number, dy: number ) {

		this.yaw -= dx;
		this.pitch = MathUtils.clamp( this.pitch - dy, - 1.55, 1.55 );

	}

	private keyLook( dt: number ) {

		const k = this.keys;
		const x = ( k.has( 'ArrowRight' ) ? 1 : 0 ) - ( k.has( 'ArrowLeft' ) ? 1 : 0 );
		const y = ( k.has( 'KeyS' ) ? 1 : 0 ) - ( k.has( 'KeyW' ) ? 1 : 0 ); // W looks up, S looks down
		if ( x || y ) this.look( x * KEY_TURN_RATE * dt, y * KEY_PITCH_RATE * dt );

		// keyboard-only walking: the view drifts back to level as you move, like classic shooters
		const moving = k.has( 'ArrowUp' ) || k.has( 'ArrowDown' );
		if ( this.mode === 'walk' && moving && ! y && ! this.dragging ) {

			this.pitch *= Math.exp( - dt * 2.5 );

		}

	}

	private bindInput() {

		const dom = this.dom;
		const typing = ( e: Event ) => e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;

		window.addEventListener( 'keydown', e => {

			if ( typing( e ) || e.metaKey ) return;
			if ( e.code === 'KeyF' && ! e.repeat ) this.toggleMode();
			if ( e.code === 'Space' && ! e.repeat ) {

				// double-tap Space to take off or land
				const now = performance.now() / 1000;
				if ( now - this.lastSpace < DOUBLE_TAP ) {

					this.toggleMode();
					this.lastSpace = - Infinity;

				} else {

					this.lastSpace = now;

				}

			}

			if ( e.code === 'Space' || e.code.startsWith( 'Arrow' ) ) e.preventDefault();
			this.keys.add( e.code );

		} );
		window.addEventListener( 'keyup', e => this.keys.delete( e.code ) );
		window.addEventListener( 'blur', () => this.keys.clear() );

		// the mouse only steers the view while a button is held down on the scene
		dom.addEventListener( 'mousedown', () => {

			this.dragging = true;
			this.hasLooked = true;
			// leave any text box, so the keys go back to moving you
			if ( document.activeElement instanceof HTMLElement ) document.activeElement.blur();

		} );
		window.addEventListener( 'mouseup', () => this.dragging = false );
		window.addEventListener( 'blur', () => this.dragging = false );
		window.addEventListener( 'mousemove', e => {

			if ( this.dragging ) this.look( e.movementX * LOOK_SENSITIVITY, e.movementY * LOOK_SENSITIVITY );

		} );

		dom.addEventListener( 'wheel', e => {

			e.preventDefault();
			this.flyScale = MathUtils.clamp( this.flyScale * Math.exp( - e.deltaY * 0.001 ), 0.2, 8 );

		}, { passive: false } );

	}

}
