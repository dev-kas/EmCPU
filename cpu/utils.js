const _console = console;

let mode = "prod";

export function getMode() {
    return mode;
}

export function setMode(m) {
    if (m !== "dev" && m !== "prod") throw new Error("Invalid mode");
    mode = m;
}

export function log(...args) {
    if (mode === "dev") _console.log(...args);
}
