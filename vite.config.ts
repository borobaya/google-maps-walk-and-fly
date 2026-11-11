import { defineConfig } from 'vite';

export default defineConfig( {
	resolve: {
		// every library must share one copy of three.js, or instanceof checks between them fail
		dedupe: [ 'three' ],
	},
	optimizeDeps: {
		include: [ 'three', '3d-tiles-renderer', '3d-tiles-renderer/plugins', 'postprocessing', '@takram/three-atmosphere', '@takram/three-clouds', '@takram/three-geospatial' ],
	},
} );
