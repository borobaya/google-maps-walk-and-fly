import { defineConfig } from 'vite';

export default defineConfig( {
	// relative paths, so the built site works at any address (such as a GitHub Pages sub-folder)
	base: './',
	resolve: {
		// every library must share one copy of three.js, or instanceof checks between them fail
		dedupe: [ 'three' ],
	},
	optimizeDeps: {
		include: [ 'three', '3d-tiles-renderer', '3d-tiles-renderer/plugins', 'postprocessing', '@takram/three-atmosphere', '@takram/three-clouds', '@takram/three-geospatial' ],
	},
} );
