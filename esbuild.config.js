import * as esbuild from "esbuild";

await esbuild.build({
	entryPoints: ["src/index.ts"],
	bundle: true,
	platform: "node",
	target: "node18",
	format: "esm",
	outfile: "server/index.js",
	// src/index.ts already carries its own shebang line - esbuild preserves
	// it verbatim, so no banner is needed here (a banner would duplicate it).
	// The MCP SDK is bundled directly into server/index.js so the .mcpb
	// package has no node_modules dependency at runtime.
	external: [],
});

console.log("built server/index.js");
