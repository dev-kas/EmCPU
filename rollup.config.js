import terser from "@rollup/plugin-terser";

/**
 * @type {import('rollup').RollupOptions}
 */
export default {
    input: "cpu/index.js",
    output: {
        file: "public/emcpu.umd.js",
        format: "umd",
        name: "EmCPU",
        sourcemap: true,
    },
    plugins: [
        terser(),
    ]
};
