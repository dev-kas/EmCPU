"use strict";

if (!(window?.config && window?.EmCPU)) throw new Error("Missing config or EmCPU");
const { CPU, Memory, IOManager, log } = window.EmCPU;

let bootsector;

/**
 * Fetch the boot sector from the server and store it in the global variable 'bootsector'.
 *
 * This is a Promise that resolves once the boot sector has been loaded.
 *
 * The boot sector is an array of bytes, and is usually loaded from a file on the server.
 * It is stored in the 'bootsector' variable so that it can be accessed by other parts of
 * the code.
 */
{
    const response = await fetch("/out/boot.bin");
    if (!response.ok) {
        throw new EmError("Failed to load boot sector: " + response.statusText);
    }
    const buffer = await response.arrayBuffer();
    bootsector = new Uint8Array(buffer);
}

const formatRegister = (value, bits = 64) => {
    const bigVal = BigInt(value);
    const mask = (1n << BigInt(bits)) - 1n;
    const maskedValue = bigVal & mask;
    const hexStr = maskedValue.toString(16).padStart(bits / 4, '0');
    return `0x${hexStr}`;
};

function printFinalState(cpu) {
    console.log("\nEmulation completed");
    console.log("--- Final Register States ---");
    console.log("Final AL:", formatRegister(cpu.readRegister('al', 1), 8));
    console.log("Final RAX:", formatRegister(cpu.rax));
    console.log("Final RBX:", formatRegister(cpu.rbx));
    console.log("Final RCX:", formatRegister(cpu.rcx));
    console.log("Final RDX:", formatRegister(cpu.rdx));
    console.log("Final R8:", formatRegister(cpu.r8));
    console.log("Final RDI:", formatRegister(cpu.rdi));

    console.log("\n--- Final Control Registers ---");
    console.log("Final CR0:", `0x${cpu.cr0.toString(16).padStart(16, '0')}`);
    console.log("Final CR3:", `0x${cpu.cr3.toString(16).padStart(16, '0')}`);
    console.log("Final CR4:", `0x${cpu.cr4.toString(16).padStart(16, '0')}`);
    console.log("Final EFER:", `0x${cpu.efer.toString(16).padStart(16, '0')}`);

    console.log("\n--- Final Flags ---");
    console.log("Final Flags (CF, ZF, SF, OF):", cpu.flags);
}

const memory = new Memory(window.config.MEM_SIZE);
const io = new IOManager();
const cpu = new CPU(memory, io);

window.cpu = cpu;

// --- Load Devices ---
await import("./devices/COM1_Serial_Port.js");
await import("./devices/PS_2_Keyboard_Controller.js");

// --- Setup Paging ---
cpu.cr3 = CPU.setupIdentityPaging(memory, 0n, 0n, 0x200000n, 0x200000n);

// --- Load Boot Sector ---
memory.load(0x7C00, bootsector);
cpu.rip = 0x7C00n;

const scheduleNextTick = (() => {
    if ('requestIdleCallback' in window) {
        return (fn) => requestIdleCallback(fn, { timeout: 50 });
    } else if (typeof MessageChannel !== "undefined") {
        const channel = new MessageChannel();
        const queue = [];
        channel.port1.onmessage = () => queue.shift()?.();
        return (fn) => {
            queue.push(fn);
            channel.port2.postMessage(null);
        };
    } else {
        return (fn) => setTimeout(fn, 0);
    }
})();

let stepsPerChunk = 200;
let timeBudget = 5;

function run() {
    try {
        const start = performance.now();

        let i = 0;
        while (i++ < stepsPerChunk && performance.now() - start < timeBudget) {
            if (!cpu.step()) {
                printFinalState(cpu); // HLT
                return;
            }

            if (cpu.rip >= BigInt(window.config.MEM_SIZE)) {
                console.error("Segmentation fault");
                printFinalState(cpu);
                return;
            }
        }

        scheduleNextTick(run);
    } catch (e) {
        console.error("A fatal error occurred during emulation:", e);
        printFinalState(cpu);
    }
}

function tunePerformance() {
    const t0 = performance.now();
    for (let i = 0; i < stepsPerChunk; i++) cpu.step();
    const elapsed = performance.now() - t0;

    if (elapsed < timeBudget - 1) {
        stepsPerChunk += 50;
    } else if (elapsed > timeBudget + 1) {
        stepsPerChunk = Math.max(50, stepsPerChunk - 50);
    }

    log(`Steps per chunk: ${stepsPerChunk}, Time budget: ${timeBudget}`);
}

setInterval(tunePerformance, 1000);

let last = performance.now();
document.body.appendChild(document.createElement("div")).id = "fps";
function showFPS() {
    const now = performance.now();
    const fps = (1000 / (now - last)).toFixed(1);
    last = now;
    document.getElementById("fps").textContent = `FPS: ${fps}`;
    requestAnimationFrame(showFPS);
}
showFPS();

console.log("--- STARTING EMULATION ---")
run();
