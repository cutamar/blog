import { defineConfig } from "astro/config";

import tailwind from "@astrojs/tailwind";
import mermaid from 'astro-mermaid';

// https://astro.build/config
export default defineConfig({
	site: 'https://cutura.me',
	integrations: [
		tailwind(),
		mermaid({
			theme: 'forest',
			autoTheme: true
		})
	],
});
