// index.js
import { CPU } from "./cpu.js";
import { Memory } from "./memory.js";

import fs from 'fs'; // Required for fs.readFileSync

async function runEmulator() {
    const memSize = 1024 * 1024 * 64; // 64 MB of RAM
    const memory = new Memory(memSize);
    const cpu = new CPU(memory);
    
    // --- Initial Setup for Testing Memory Access ---
    cpu.rax = 0x00020000n; // Set RAX to 128KB, will be overwritten by Nasm bootsector
    cpu.r8 = 0x00010000n;  // Set R8 to 64KB, will be overwritten by Nasm bootsector
    memory.writeBigUint64(0x10020, 0xAABBCCDDEEFF0011n);
    console.log("Memory initialised at 0x10020 with: 0xAABBCCDDEEFF0011n");
    // --- End Initial Setup ---

    // --- Setup Paging Tables ---
    const PAGE_TABLE_BASE_ADDRESS = 0x200000n; 
    const MAPPED_VIRTUAL_START = 0n;         
    const MAPPED_PHYSICAL_START = 0n;        
    const MAPPED_SIZE = 0x200000n; // Map only 2MB for now      

    const pml4PhysAddr = CPU.setupIdentityPaging(
        memory, 
        MAPPED_VIRTUAL_START, 
        MAPPED_PHYSICAL_START, 
        MAPPED_SIZE, 
        PAGE_TABLE_BASE_ADDRESS
    );
    cpu.cr3 = pml4PhysAddr; 

    const bootSectorData = new Uint8Array(fs.readFileSync('bootsector.bin'));
    memory.load(0x7C00, bootSectorData); 
    cpu.rip = 0x7C00n; 

    let running = true;
    while (running) {
        running = cpu.step();
        if (!running) break;
        if (cpu.rip >= BigInt(memSize)) {
            console.error("Segmentation fault");
            break;
        }
    }

    console.log("\nEmulation completed");
    console.log("--- Final Register States ---");
    console.log("Final AL:", `0x${cpu.readRegister('al', 1).toString(16).padStart(2, '0')}`);
    console.log("Final RAX:", `0x${cpu.rax.toString(16).padStart(16, '0')}`);
    console.log("Final RBX:", `0x${cpu.rbx.toString(16).padStart(16, '0')}`); 
    console.log("Final RCX:", `0x${cpu.rcx.toString(16).padStart(16, '0')}`);
    console.log("Final RDX:", `0x${cpu.rdx.toString(16).padStart(16, '0')}`);
    console.log("Final R8:", `0x${cpu.r8.toString(16).padStart(16, '0')}`);
    console.log("Final RDI:", `0x${cpu.rdi.toString(16).padStart(16, '0')}`);

    console.log("\n--- Final Control Registers ---");
    console.log("Final CR0:", `0x${cpu.cr0.toString(16).padStart(16, '0')}`);
    console.log("Final CR3:", `0x${cpu.cr3.toString(16).padStart(16, '0')}`);
    console.log("Final CR4:", `0x${cpu.cr4.toString(16).padStart(16, '0')}`);
    console.log("Final EFER:", `0x${cpu.efer.toString(16).padStart(16, '0')}`);

    console.log("\n--- Final Flags ---");
    console.log("Final Flags (CF, ZF, SF, OF):", cpu.flags); // Updated order for common display

    console.log("\n--- Memory Verification ---");
    const actualWrittenAddress = 0x201aan; 
    console.log(`Memory at 0x${actualWrittenAddress.toString(16)}: 0x${memory.readBigUint64(Number(actualWrittenAddress)).toString(16)}`);
}

runEmulator();