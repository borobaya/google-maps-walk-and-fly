import {
	Data3DTexture, HalfFloatType, LinearFilter, LinearMipMapLinearFilter, Matrix4, NoColorSpace, RedFormat, RepeatWrapping,
	TextureLoader, Vector3, type Camera, type Scene, type WebGLRenderer,
} from 'three';
import { EffectComposer, EffectPass, RenderPass, SMAAEffect, ToneMappingEffect, ToneMappingMode } from 'postprocessing';
import {
	AerialPerspectiveEffect, PrecomputedTexturesGenerator,
} from '@takram/three-atmosphere';
import { CLOUD_SHAPE_DETAIL_TEXTURE_SIZE, CLOUD_SHAPE_TEXTURE_SIZE, CloudsEffect } from '@takram/three-clouds';
import { DEFAULT_STBN_URL, DataTextureLoader, STBNLoader, parseUint8Array } from '@takram/three-geospatial';

// A fixed mid-afternoon sun: 50 degrees up in the south-west (scene axes: +Y up, +Z north, -X east).
const SUN_ELEVATION = 50 * Math.PI / 180;
const SUN_LOCAL = new Vector3(
	Math.cos( SUN_ELEVATION ) * Math.SQRT1_2,
	Math.sin( SUN_ELEVATION ),
	- Math.cos( SUN_ELEVATION ) * Math.SQRT1_2,
);

/**
 * Physically based sky, sunlight and haze (three-geospatial), applied as a
 * post-process over the tiles. The tiles are treated as surface colour and lit
 * by a sun and sky that stay the same everywhere.
 */
export class Atmosphere {

	private composer: EffectComposer;
	private aerial: AerialPerspectiveEffect;
	private clouds: CloudsEffect;
	private cloudsOn = true;
	private sun = new Vector3();
	private linkClouds: () => void = () => {};

	constructor( renderer: WebGLRenderer, scene: Scene, camera: Camera ) {

		// the sky is far brighter than a screen can show; expose for daylight
		renderer.toneMappingExposure = 8;

		this.aerial = new AerialPerspectiveEffect( camera, {
			sky: true,
			moon: false,
			sunLight: true,
			skyLight: true,
			// No normals are supplied, so every surface is lit as if it faced straight up. Google's
			// textures already carry the real shading; deriving normals from depth instead turned
			// the undersides of bridges and overhangs black.
			// Google's textures already contain baked light and shadow; soften the contrast
			albedoScale: 2 / 3,
		} );

		// radiance needs a floating-point buffer
		this.composer = new EffectComposer( renderer, { frameBufferType: HalfFloatType } );
		this.composer.addPass( new RenderPass( scene, camera ) );
		this.clouds = this.createClouds( camera );
		this.composer.addPass( new EffectPass( camera, this.clouds, this.aerial, new ToneMappingEffect( { mode: ToneMappingMode.AGX } ) ) );
		this.composer.addPass( new EffectPass( camera, new SMAAEffect() ) );

		// the scattering tables are computed once on the GPU at start-up
		const generator = new PrecomputedTexturesGenerator( renderer );
		generator.update().catch( ( error: unknown ) => console.error( error ) );
		Object.assign( this.aerial, generator.textures );
		Object.assign( this.clouds, generator.textures );

	}

	/** Volumetric clouds, drawn into a buffer that the aerial-perspective effect composites over the scene. */
	private createClouds( camera: Camera ): CloudsEffect {

		const clouds = new CloudsEffect( camera );
		clouds.qualityPreset = 'medium';
		clouds.coverage = 0.35;
		clouds.localWeatherVelocity.set( 0.001, 0 ); // a gentle drift

		const base = `${ import.meta.env.BASE_URL }clouds/`;
		const tiled = ( url: string ) => new TextureLoader().load( url, texture => {

			texture.minFilter = LinearMipMapLinearFilter;
			texture.magFilter = LinearFilter;
			texture.wrapS = texture.wrapT = RepeatWrapping;
			texture.colorSpace = NoColorSpace;
			texture.needsUpdate = true;

		} );
		const volume = ( url: string, size: number ) => new DataTextureLoader( Data3DTexture, parseUint8Array, {
			width: size, height: size, depth: size,
			format: RedFormat,
			minFilter: LinearFilter, magFilter: LinearFilter,
			wrapS: RepeatWrapping, wrapT: RepeatWrapping, wrapR: RepeatWrapping,
			colorSpace: NoColorSpace,
		} ).load( url );

		clouds.localWeatherTexture = tiled( `${ base }local_weather.png` );
		clouds.turbulenceTexture = tiled( `${ base }turbulence.png` );
		clouds.shapeTexture = volume( `${ base }shape.bin`, CLOUD_SHAPE_TEXTURE_SIZE );
		clouds.shapeDetailTexture = volume( `${ base }shape_detail.bin`, CLOUD_SHAPE_DETAIL_TEXTURE_SIZE );
		// blue noise that hides the ray-marching steps; fetched from the library's own host
		clouds.stbnTexture = new STBNLoader().load( DEFAULT_STBN_URL );

		const link = () => {

			const on = this.cloudsOn;
			this.aerial.overlay = on ? clouds.atmosphereOverlay : null;
			// cloud shadows are deliberately not passed on, so the ground stays evenly lit
			this.aerial.shadow = null;
			this.aerial.shadowLength = null;

		};
		clouds.events.addEventListener( 'change', link );
		this.linkClouds = link;
		link();
		return clouds;

	}

	/** Clouds are the most expensive effect; they can be switched off. */
	toggleClouds(): boolean {

		this.cloudsOn = ! this.cloudsOn;
		this.clouds.coverage = this.cloudsOn ? 0.35 : 0;
		this.linkClouds();
		return this.cloudsOn;

	}

	setSize( width: number, height: number ) {

		this.composer.setSize( width, height );

	}

	/** @param sceneToECEF the tiles group's inverse world matrix */
	update( sceneToECEF: Matrix4 ) {

		this.aerial.worldToECEFMatrix.copy( sceneToECEF );
		this.clouds.worldToECEFMatrix.copy( sceneToECEF );

		// the sun sits at the same place in the local sky wherever you are
		this.sun.copy( SUN_LOCAL ).transformDirection( sceneToECEF );
		this.aerial.sunDirection.copy( this.sun );
		this.clouds.sunDirection.copy( this.sun );

	}

	render( dt: number ) {

		this.composer.render( dt );

	}

}
