(function (global, factory) {
    typeof exports === 'object' && typeof module !== 'undefined' ? factory(exports) :
    typeof define === 'function' && define.amd ? define(['exports'], factory) :
    (global = typeof globalThis !== 'undefined' ? globalThis : global || self, factory(global.EmCPU = {}));
})(this, (function (exports) { 'use strict';

    const _console = console;

    let mode = "prod";

    function getMode() {
        return mode;
    }

    function setMode(m) {
        if (m !== "dev" && m !== "prod") throw new Error("Invalid mode");
        mode = m;
    }

    function log(...args) {
        if (mode === "dev") _console.log(...args);
    }

    class Memory {
        constructor(size) {
            this.buffer = new ArrayBuffer(size);
            this.view = new DataView(this.buffer);
            new Uint8Array(this.buffer).fill(0); 
        }

        // Read methods
        readUint8(addr) { return this.view.getUint8(addr); }
        readUint16(addr) { return this.view.getUint16(addr, true); } // true for little-endian
        readUint32(addr) { return this.view.getUint32(addr, true); }
        readBigUint64(addr) { return this.view.getBigUint64(addr, true); }

        // Write methods
        writeUint8(addr, value) { this.view.setUint8(addr, Number(value)); }
        writeUint16(addr, value) { this.view.setUint16(addr, Number(value), true); } // true for little-endian
        writeUint32(addr, value) { this.view.setUint32(addr, Number(value), true); }
        writeBigUint64(addr, value) { this.view.setBigUint64(addr, value, true); }

        // Helper to load binary data into memory (eg. boot sector)
        load(addr, data) {
            const sourceUint8Array = new Uint8Array(data);
            const mainBufferView = new Uint8Array(this.buffer);

            if (Number(addr) < 0 || (Number(addr) + sourceUint8Array.byteLength) > mainBufferView.byteLength) {
                throw new Error(`Memory.load: Attempted to load 0x${sourceUint8Array.byteLength.toString(16)} bytes at 0x${addr.toString(16)} which is outside the allocated memory bounds (0x0 to 0x${mainBufferView.byteLength.toString(16)}).`);
            }

            mainBufferView.set(sourceUint8Array, Number(addr));
            log(`Memory.load: Loaded 0x${sourceUint8Array.byteLength.toString(16)} bytes to 0x${addr.toString(16)}`);
        }
    }

    class IOManager {
        constructor() {
            this.devices = new Map();
        }

        registerDevice(ports, device) {
            const portArray = Array.isArray(ports) ? ports : [ports];
            for (const port of portArray) {
                this.devices.set(port, device);
                log(`Registered device ${device.name} at port ${port}`);
            }
        }

        portIn(port, size) {
            const device = this.devices.get(port);
            if (device && device.portIn) {
                return device.portIn(port, size);
            }
            return 0;
        }

        portOut(port, value, size) {
            const device = this.devices.get(port);
            if (device && device.portOut) {
                device.portOut(port, value, size);
            }
        }
    }

    class Device {
        /**
         * @param {string} name A descriptive name for the device for logging/debugging.
         */
        constructor(name = 'Unnamed Device') {
            this.name = name;
        }

        /**
         * Handles a read from an I/O port associated with this device.
         * @param {number} port The port number being read from.
         * @param {number} size The size of the read in bytes (1, 2, or 4).
         * @returns {number} The value to be returned to the CPU.
         */
        portIn(port, size) {
            // Default behavior for a write-only or unimplemented device.
            // Real hardware often returns 0xFF on reads from empty ports, but 0 is also fine.
            return 0;
        }

        /**
         * Handles a write to an I/O port associated with this device.
         * @param {number} port The port number being written to.
         * @param {number} value The value being written by the CPU.
         * @param {number} size The size of the write in bytes (1, 2, or 4).
         */
        portOut(port, value, size) {
            // Default behavior for a read-only or unimplemented device is to do nothing.
            // This is exactly like real hardware.
        }
    }

    class PageFaultException extends Error {
        constructor(message, errorCode) {
            super(message);
            this.name = "PageFaultException";
            this.errorCode = errorCode;
        }
    }

    class CPU {
        // --- STATIC CONSTANTS ---
        static CR0_PE = 1n << 0n;  // Protected Mode Enable
        static CR0_PG = 1n << 31n; // Paging Enable

        static CR4_PAE = 1n << 5n; // Physical Address Extension

        static FLAG_CF_BIT = 0n;
        static FLAG_ZF_BIT = 6n;
        static FLAG_SF_BIT = 7n;
        static FLAG_IF_BIT = 9n;
        static FLAG_OF_BIT = 11n;

        static EFER_LME = 1n << 8n; // Long Mode Enable
        static EFER_NXE = 1n << 11n; // No-Execute Enable (for future NX bit support)

        // Constants for Page Table Entry (PTE) bits
        // These apply to PML4E, PDPTE, PDE, PTE
        static PTE_PRESENT       = 1n << 0n;   // P: Present (must be 1 for valid entry)
        static PTE_READ_WRITE    = 1n << 1n;   // RW: Read/Write (0=read-only, 1=read/write)
        static PTE_USER_SUPER    = 1n << 2n;   // US: User/Supervisor (0=supervisor-only, 1=user/supervisor)
        static PTE_WRITE_THROUGH = 1n << 3n;   // PWT: Page Write-Through
        static PTE_CACHE_DISABLE = 1n << 4n;   // PCD: Page Cache Disable
        static PTE_ACCESSED      = 1n << 5n;   // A: Accessed (set by CPU on access)
        static PTE_DIRTY         = 1n << 6n;   // D: Dirty (set by CPU on write) - only for last-level entries (PTE, PDE for 2MB, PDPTE for 1GB)
        static PTE_PAGE_SIZE     = 1n << 7n;   // PS: Page Size (0=4KB, 1=2MB or 1GB depending on level)
        static PTE_GLOBAL        = 1n << 8n;   // G: Global (prevents TLB flush on CR3 load - for kernel pages)
        // Bits 9-11 are ignored for software use
        // Bits 12-51 for physical page address (for 4KB pages) or bits 21-51 for 2MB/1GB pages
        // Bits 52-62 ignored for software use
        // Bit 63 (NXE in EFER, if enabled) for No-Execute

        /**
         * Creates a minimal 4-level page table structure to identity-map a range of virtual addresses to physical.
         * Assumes 4KB pages.
         * @param {Memory} memory The emulated memory object.
         * @param {BigInt} virtualStart The starting virtual address to map.
         * @param {BigInt} physicalStart The starting physical address to map.
         * @param {BigInt} sizeBytes The size of the region to map (must be a multiple of 4KB).
         * @param {BigInt} pageTableBasePhysAddr The base physical address where page tables will be stored.
         * @returns {BigInt} The physical address of the PML4 table.
         */
        static setupIdentityPaging(memory, virtualStart, physicalStart, sizeBytes, pageTableBasePhysAddr) {
            const PAGE_SIZE = 4096n; // 4KB
            if (sizeBytes % PAGE_SIZE !== 0n) {
                throw new Error("Mapped size must be a multiple of 4KB.");
            }
            const numPages = sizeBytes / PAGE_SIZE;

            let currentTableAddr = pageTableBasePhysAddr;

            const pml4TablePhys = currentTableAddr;
            currentTableAddr += PAGE_SIZE;

            const pdptTablePhys = currentTableAddr;
            currentTableAddr += PAGE_SIZE;

            const pdTablePhys = currentTableAddr;
            currentTableAddr += PAGE_SIZE;

            const ptTablePhys = currentTableAddr;
            currentTableAddr += PAGE_SIZE;

            log(`Setting up identity map from VA 0x${virtualStart.toString(16)} to PA 0x${physicalStart.toString(16)}, size 0x${sizeBytes.toString(16)}`);
            log(`  PML4 Table at PA 0x${pml4TablePhys.toString(16)}`);
            log(`  PDPT Table at PA 0x${pdptTablePhys.toString(16)}`);
            log(`  PD Table at PA 0x${pdTablePhys.toString(16)}`);
            log(`  PT Table at PA 0x${ptTablePhys.toString(16)}`);


            // Initialize all tables to 0
            for (let i = 0n; i < PAGE_SIZE / 8n; i++) {
                memory.writeBigUint64(Number(pml4TablePhys + i * 8n), 0n);
                memory.writeBigUint64(Number(pdptTablePhys + i * 8n), 0n);
                memory.writeBigUint64(Number(pdTablePhys + i * 8n), 0n);
                memory.writeBigUint64(Number(ptTablePhys + i * 8n), 0n);
            }

            // Helper for writing and verifying page table entries
            const writeAndVerifyPTE = (addr, value, description) => {
                memory.writeBigUint64(Number(addr), value);
                const readBack = memory.readBigUint64(Number(addr));
                if (readBack !== value) {
                    console.error(`ERROR: ${description} write mismatch at 0x${addr.toString(16)}! Written: 0x${value.toString(16)}, Readback: 0x${readBack.toString(16)}`);
                    throw new Error("Page table write verification failed.");
                } else {
                    log(`  VERIFIED: ${description} at 0x${addr.toString(16)} is 0x${readBack.toString(16)}`);
                }
            };

            // Map the first entry in each table to point to the next table
            // PML4[0] -> PDPT[0]
            let pml4e_value = pdptTablePhys | CPU.PTE_PRESENT | CPU.PTE_READ_WRITE | CPU.PTE_USER_SUPER;
            writeAndVerifyPTE(pml4TablePhys, pml4e_value, `PML4E[0] -> PDPT[0]`);

            // PDPT[0] -> PD[0]
            let pdpte_value = pdTablePhys | CPU.PTE_PRESENT | CPU.PTE_READ_WRITE | CPU.PTE_USER_SUPER;
            writeAndVerifyPTE(pdptTablePhys, pdpte_value, `PDPTE[0] -> PD[0]`);

            // PD[0] -> PT[0]
            let pde_value = ptTablePhys | CPU.PTE_PRESENT | CPU.PTE_READ_WRITE | CPU.PTE_USER_SUPER;
            writeAndVerifyPTE(pdTablePhys, pde_value, `PDE[0] -> PT[0]`); 

            // Now, map the actual pages in the Page Table
            for (let i = 0n; i < numPages; i++) {
                const currentVirtualPage = virtualStart + i * PAGE_SIZE;
                const currentPhysicalPage = physicalStart + i * PAGE_SIZE;
                
                let pte_value = currentPhysicalPage | CPU.PTE_PRESENT | CPU.PTE_READ_WRITE | CPU.PTE_USER_SUPER;
                // The index into the Page Table depends on the virtual address's bits 12-20
                const ptIndex = (currentVirtualPage >> 12n) & 0x1FFn;
                const pteWriteAddr = ptTablePhys + ptIndex * 8n; // Calculate the specific address for this PTE

                // For detailed debugging, log every 100th page, or specific pages (like 0x7C00 or 0x8000)
                if (i % 100n === 0n || currentVirtualPage === 0x7C00n || currentVirtualPage === 0x8000n) { 
                    writeAndVerifyPTE(pteWriteAddr, pte_value, `PTE for VA 0x${currentVirtualPage.toString(16)}`);
                } else {
                    // If not logging, just perform the write
                    memory.writeBigUint64(Number(pteWriteAddr), pte_value);
                }
            }

            return pml4TablePhys; // Return the base address of the PML4 table for CR3
        }

        constructor(memory = new Memory(1024 * 1024 * 1), io = new IOManager()) {
            this.memory = memory;
            this.io = io;

            // Interrupt Descriptor Table Register
            this.idtr = {
                base: 0n,
                limit: 0
            };

            // Global Descriptor Table Register
            this.gdtr = {
                base: 0n,
                limit: 0
            };

            // Interrupt Queue
            this.interruptQueue = [];

            // General Purpose Registers
            this.rax = 0n; this.rbx = 0n; this.rcx = 0n; this.rdx = 0n;
            this.rsp = 0n; this.rbp = 0n; this.rsi = 0n; this.rdi = 0n;
            this.r8 = 0n; this.r9 = 0n; this.r10 = 0n; this.r11 = 0n;
            this.r12 = 0n; this.r13 = 0n; this.r14 = 0n; this.r15 = 0n;

            // Segment Registers
            this.cs = 0n;
            this.ds = 0n;
            this.ss = 0n;
            this.es = 0n;
            this.fs = 0n;
            this.gs = 0n;

            // RFLAGS Register
            this.rflags = 0n;

            // Instruction Pointer
            this.rip = 0n;

            // Flags
            this.halted = false;
            this.flags = {
                cf: 0, // Carry Flag
                zf: 0, // Zero Flag
                sf: 0, // Sign Flag
                of: 0, // Overflow Flag
                if: 1, // Interrupt Flag
                // TODO: Add more flags
            };

            // CPU Modes and Control Registers
            this.mode = "real"; // real, protected, long
            this.cr0 = 0n; // Control Register 0
            this.cr3 = 0n; // Control Register 3
            this.cr4 = 0n; // Control Register 4
            this.efer = 0n; // Extended Feature Enable Register

            // Mapping register names to their internal names
            this.registers = {
                // Full 64-bit
                'rax': 'rax', 'rcx': 'rcx', 'rdx': 'rdx', 'rbx': 'rbx',
                'rsp': 'rsp', 'rbp': 'rbp', 'rsi': 'rsi', 'rdi': 'rdi',
                'r8': 'r8', 'r9': 'r9', 'r10': 'r10', 'r11': 'r11',
                'r12': 'r12', 'r13': 'r13', 'r14': 'r14', 'r15': 'r15',
                // 32-bit (low half of 64-bit)
                'eax': 'rax', 'ecx': 'rcx', 'edx': 'rdx', 'ebx': 'rbx',
                'esp': 'rsp', 'ebp': 'rbp', 'esi': 'rsi', 'edi': 'rdi',
                'r8d': 'r8', 'r9d': 'r9', 'r10d': 'r10', 'r11d': 'r11',
                'r12d': 'r12', 'r13d': 'r13', 'r14d': 'r14', 'r15d': 'r15',
                // 16-bit (low half of 32-bit)
                'ax': 'rax', 'cx': 'rcx', 'dx': 'rdx', 'bx': 'rbx',
                'sp': 'rsp', 'bp': 'rbp', 'si': 'rsi', 'di': 'rdi',
                'r8w': 'r8', 'r9w': 'r9', 'r10w': 'r10', 'r11w': 'r11',
                'r12w': 'r12', 'r13w': 'r13', 'r14w': 'r14', 'r15w': 'r15',
                // 8-bit (low byte of 16-bit) - AL, CL, DL, BL
                'al': 'rax', 'cl': 'rcx', 'dl': 'rdx', 'bl': 'rbx',
                // 8-bit (high byte of 16-bit) - AH, CH, DH, BH
                'ah': 'rax', 'ch': 'rcx', 'dh': 'rdx', 'bh': 'rbx',
                // 8-bit (low byte of RBP/RSP/RSI/RDI when REX prefix is used) - SPL, BPL, SIL, DIL
                'spl': 'rsp', 'bpl': 'rbp', 'sil': 'rsi', 'dil': 'rdi',
                // 8-bit (low byte of R8-R15) - R8B-R15B
                'r8b': 'r8', 'r9b': 'r9', 'r10b': 'r10', 'r11b': 'r11',
                'r12b': 'r12', 'r13b': 'r13', 'r14b': 'r14', 'r15b': 'r15',
                // 64-bit flags register
                'rflags': 'rflags', 'eflags': 'rflags',
                // Segment Registers
                'cs': 'cs', 'ds': 'ds', 'es': 'es', 'ss': 'ss', 'fs': 'fs', 'gs': 'gs',
            };
        }

        // Helper to read register values with size handling
        readRegister(regName, sizeBytes) {
            if (regName === 'rflags' || regName === 'eflags') {
                return this.assembleRFlags();
            }
            const fullReg = this.registers[regName];
            if (!fullReg) {
                throw new Error(`Attempted to read unknown register name: ${regName}`);
            }
            let val = this[fullReg]; // val is BigInt (e.g. this.rax)
            if (sizeBytes === 1) {
                // Handle AH, CH, DH, BH (high byte of 16-bit)
                if (['ah', 'ch', 'dh', 'bh'].includes(regName)) {
                    return (val >> 8n) & 0xFFn;
                }
                // For AL, CL, DL, BL, SPL, BPL, SIL, DIL, R8B-R15B, it's the lowest byte
                return (val & 0xFFn);
            }
            if (sizeBytes === 2) return (val & 0xFFFFn);
            if (sizeBytes === 4) return (val & 0xFFFFFFFFn);
            if (sizeBytes === 8) return val;
            throw new Error(`Invalid register size: ${sizeBytes}`);
        }

        // Helper to write values to register values with size handling
        writeRegister(regName, value, sizeBytes) {
            const fullReg = this.registers[regName];
            if (fullReg === undefined) {
                throw new Error(`Attempted to write to unknown register name: ${regName}`);
            }
            let currentVal = this[fullReg];
            let valToWrite = BigInt(value);

            if (sizeBytes === 1) {
                if (['ah', 'ch', 'dh', 'bh'].includes(regName)) {
                    // Clear the old AH/CH/DH/BH byte, then set the new one
                    this[fullReg] = (currentVal & ~(0xFFn << 8n)) | ((valToWrite & 0xFFn) << 8n);
                } else {
                    // AL, CL, DL, BL, SPL, BPL, SIL, DIL, R8B-R15B
                    // Clear the lowest byte, then set the new one. Upper bits untouched.
                    this[fullReg] = (currentVal & ~0xFFn) | (valToWrite & 0xFFn);
                }
            } else if (sizeBytes === 2) {
                // AX, CX, DX, BX, SP, BP, SI, DI, R8W-R15W
                // Clear the lowest 16 bits, then set the new one. Upper bits untouched.
                this[fullReg] = (currentVal & ~0xFFFFn) | (valToWrite & 0xFFFFn);
            } else if (sizeBytes === 4) {
                // EAX, ECX, EDX, EBX, ESP, EBP, ESI, EDI, R8D-R15D
                // In 64-bit mode, writing to a 32-bit register (like EAX) zeros the upper 32 bits of the 64-bit register (RAX).
                this[fullReg] = valToWrite & 0xFFFFFFFFn; // THIS IS THE CRITICAL CHANGE
            } else if (sizeBytes === 8) {
                // RAX, RCX, etc. Full 64-bit write.
                this[fullReg] = valToWrite;
            } else {
                throw new Error(`Invalid register size for writing: ${sizeBytes} for register ${regName}`);
            }
        }

        // Updates arithmetic flags based on result and operands
        // Result, operand1, operand2 should be BigInts.
        // 'operation' can be 'add' or 'sub'
        updateArithmeticFlags(result, operand1, operand2, sizeBytes, operation) {
            const bitWidth = BigInt(sizeBytes * 8);
            const bitMask = (1n << bitWidth) - 1n; 
            const signBitPos = bitWidth - 1n; 
            const signBitMask = 1n << signBitPos;

            // Apply the size mask to ensure correct behavior for operations that wrap around
            const maskedResult = result & bitMask;
            const maskedOperand1 = operand1 & bitMask;
            const maskedOperand2 = operand2 & bitMask;

            // Zero Flag (ZF): Set if result is 0
            this.flags.zf = (maskedResult === 0n) ? 1 : 0;

            // Sign Flag (SF): Set if result's MSB is 1
            this.flags.sf = ((maskedResult & signBitMask) !== 0n) ? 1 : 0;

            // Carry Flag (CF): For unsigned overflow
            // For ADD: CF = 1 if result (unsigned) > max_unsigned_value_for_size
            // For SUB: CF = 1 if operand1 (unsigned) < operand2 (unsigned) (borrow occurred)
            if (operation === 'add') {
                this.flags.cf = (result > bitMask) ? 1 : 0;
            } else if (operation === 'sub') {
                this.flags.cf = (maskedOperand1 < maskedOperand2) ? 1 : 0;
            } else {
                // For logical operations (AND, OR, XOR), CF is always 0
                this.flags.cf = 0; 
            }

            // Overflow Flag (OF): For signed overflow
            // OF is set if the result's sign is different from the operands' sign (for ADD)
            // or if the result's sign is different from the minuend's sign when the subtrahend's sign is inverted (for SUB).
            // This is often checked by XORing sign bits:
            // For ADD: OF = ( (Op1 ^ Res) & (Op2 ^ Res) ) >> signBitPos
            // For SUB: OF = ( (Op1 ^ Res) & (~Op2 ^ Res) ) >> signBitPos  (where ~Op2 means bitwise NOT of Op2 within its size)

            const s1 = (maskedOperand1 & signBitMask) !== 0n; // Sign of first operand
            const s2 = (maskedOperand2 & signBitMask) !== 0n; // Sign of second operand
            const sR = (maskedResult & signBitMask) !== 0n;   // Sign of result

            this.flags.of = 0; // Assume no overflow initially

            if (operation === 'add') {
                if ((s1 === s2) && (s1 !== sR)) { // Adding two positives makes negative, or two negatives makes positive
                    this.flags.of = 1;
                }
            } else if (operation === 'sub') {
                // OF is set if: (positive - negative = negative) OR (negative - positive = positive)
                // This is equivalent to: (s1 XOR s2) AND (s1 XOR sR)
                if ((s1 !== s2) && (s1 !== sR)) { // e.g., 7 - (-1) = 8. s1=0, s2=1, sR=0. (0!=1) && (0!=0) -> false (no OF)
                                                 // e.g., 127 - (-1) = 128. s1=0, s2=1, sR=1. (0!=1) && (0!=1) -> true (OF)
                    this.flags.of = 1;
                }
            } else {
                // For logical operations (AND, OR, XOR), OF is always 0
                this.flags.of = 0;
            }
        }

        step() {
            let rexPrefix = 0;
            let defaultOperandSize; // Default bits are determined on current CPU mode (unless REX.W or 0x66 override)

            this.operandSizeOverride = false;
            this.addressSizeOverride = false;

            let rex_w = 0;
            let rex_r = 0;
            let rex_x = 0;
            let rex_b = 0;

            let currentRIPBeforeFetch = this.rip; // Store RIP to calculate instruction start accurately

            if (this.flags.if && this.interruptQueue.length > 0) {
                this.halted = false;
                const interruptNumber = this.interruptQueue.shift();
                this.triggerInterrupt(interruptNumber);
            }

            if (this.halted) {
                return true;
            }

            let opcode; // Declare opcode here, will be assigned inside prefix loop

            try {

            // --- Handle Prefixes (Loop to consume all prefixes) ---
            // Read bytes one by one, processing as prefixes until main opcode or 0x0F is found.
                let byte = this.readInstructionByte(); // Read the first byte of the potential instruction

                while (true) {
                    if (byte === 0x66) { // Operand Size Override Prefix
                        this.operandSizeOverride = true;
                        byte = this.readInstructionByte(); // Consume 0x66, read next byte
                    } else if (byte === 0x67) { // Address Size Override Prefix
                        this.addressSizeOverride = true;
                        byte = this.readInstructionByte(); // Consume 0x67, read next byte
                    } else if ((byte & 0xF0) === 0x40) { // REX prefix: 0x40 - 0x4F
                        rexPrefix = byte;
                        rex_w = (rexPrefix & 0x08) >>> 3;
                        rex_r = (rexPrefix & 0x04) >>> 2;
                        rex_x = (rexPrefix & 0x02) >>> 1;
                        rex_b = (rexPrefix & 0x01);
                        byte = this.readInstructionByte(); // Consume REX, read next byte
                    } 
                    // Add other prefixes here (e.g., segment overrides 0x2E, 0x36, REP prefixes 0xF2, 0xF3)
                    else {
                        // If it's not a known prefix, it must be the main opcode or 0x0F prefix
                        opcode = byte; // Assign the actual opcode
                        break; // Exit loop
                    }
                }

                // Determine the final default operand size based on mode and prefixes.
                if (this.mode === 'long') {
                    // In long mode, REX.W takes precedence for 64-bit.
                    if (rex_w) {
                        defaultOperandSize = 8;
                    }
                    // 0x66 prefix forces 16-bit.
                    else if (this.operandSizeOverride) {
                        defaultOperandSize = 2;
                    }
                    // Default for most instructions is 32-bit.
                    else {
                        defaultOperandSize = 4;
                    }
                } else if (this.mode === 'real') {
                    // In Real Mode, default is 16. 0x66 toggles to 32.
                    defaultOperandSize = this.operandSizeOverride ? 4 : 2;
                } else { // Protected Mode
                    // Default is 16-bit. A 0x66 prefix toggles it to 32-bit.
                    // TODO: Add CS.D bit logic for protected mode here later.
                    defaultOperandSize = this.operandSizeOverride ? 2 : 4;
                }

                // 2-byte opcode prefix (0x0F) - This comes *after* other prefixes
                let twoByteOpcode = false;
                if (opcode === 0x0F) {
                    twoByteOpcode = true;
                    opcode = this.readInstructionByte(); // Read the second byte of the opcode
                }

                // --- Logging the Instruction ---
                log(`RIP: 0x${currentRIPBeforeFetch.toString(16).padStart(4, '0')}, OPCODE: 0x${(twoByteOpcode ? '0F' : '')}${opcode.toString(16).padStart(2, '0')}${rexPrefix ? ` (REX: 0x${rexPrefix.toString(16)})` : ''}${this.operandSizeOverride ? ' (0x66)' : ''}`);

                // --- Instruction Decoding and Execution ---

                // Priority 1: Handle two-byte opcodes (opcodes that follow 0x0F)
                if (twoByteOpcode) {
                    // MOV Reg, CRn (0x0F 20)
                    if (opcode === 0x20) {
                        const modrm = this.readModRMByte();
                        const crIdx = modrm.reg;
                        const destRegFullIndex = modrm.rm + (rex_b << 3);

                        // The operand size is determined by the effective operand size.
                        // In long mode, a REX.W prefix makes it 64-bit. Otherwise, it's 32-bit.
                        // In real/protected mode, it defaults to 16 or 32.
                        let sizeBytes = defaultOperandSize;
                        if (this.mode === 'long') {
                            sizeBytes = rex_w ? 8 : 4;
                        }

                        const destRegName = this.getRegisterString(destRegFullIndex, sizeBytes, rexPrefix !== 0);

                        let sourceValue;
                        switch (crIdx) {
                            case 0: sourceValue = this.cr0; break;
                            case 2: sourceValue = this.cr2; break;
                            case 3: sourceValue = this.cr3; break;
                            case 4: sourceValue = this.cr4; break;
                            default:
                                throw new Error(`Attempted to read from unknown/unsupported CR${crIdx}`);
                        }

                        this.writeRegister(destRegName, sourceValue, sizeBytes);
                        
                        log(`Decoded: MOV ${destRegName.toUpperCase()}, CR${crIdx}`);
                        return true;
                    }

                    // MOV CRn, Reg/Mem64 (0x0F 22)
                    if (opcode === 0x22) {
                        const modrm = this.readModRMByte();
                        const crIdx = modrm.reg; // CR register is encoded in the 'reg' field of ModR/M
                        const sourceRegFullIndex = modrm.rm + (rex_b << 3); // Source GPR is encoded in 'r/m' field, REX.B applies
                        
                        // Pass hasRexPrefix (rexPrefix !== 0) to getRegisterString.
                        const sourceRegName = this.getRegisterString(sourceRegFullIndex, 8, rexPrefix !== 0);

                        const sourceValue = this.readRegister(sourceRegName, 8);

                        switch (crIdx) {
                            case 0: this.cr0 = sourceValue; log(`Decoded: MOV CR0, ${sourceRegName.toUpperCase()} (0x${sourceValue.toString(16)}n)`); this.updateCPUMode(); break;
                            case 2: this.cr2 = sourceValue; log(`Decoded: MOV CR2, ${sourceRegName.toUpperCase()} (0x${sourceValue.toString(16)}n)`); break;
                            case 3: this.cr3 = sourceValue; log(`Decoded: MOV CR3, ${sourceRegName.toUpperCase()} (0x${sourceValue.toString(16)}n)`); break;
                            case 4: this.cr4 = sourceValue; log(`Decoded: MOV CR4, ${sourceRegName.toUpperCase()} (0x${sourceValue.toString(16)}n)`); this.updateCPUMode(); break;
                            default: console.warn(`MOV CR${crIdx}, ${sourceRegName.toUpperCase()} not fully implemented/valid.`); 
                        }
                        return true;
                    }
                    // WRMSR (0x0F 30)
                    if (opcode === 0x30) {
                        const msrAddr = this.readRegister('rcx', 8); 
                        const valueHigh = this.readRegister('rdx', 8) << 32n; 
                        const valueLow = this.readRegister('rax', 8) & 0xFFFFFFFFn; 
                        const value = valueHigh | valueLow;

                        if (msrAddr === 0xC0000080n) { // EFER MSR
                            this.efer = value;
                            if ((this.efer & CPU.EFER_LME) !== 0n) {
                                log(`Long Mode Enable (LME) bit set in EFER!`);
                            }
                            this.updateCPUMode();
                        } else {
                            console.warn(`WRMSR to unknown MSR 0x${msrAddr.toString(16)}`);
                        }
                        return true;
                    }
                    // RDMSR (0x0F 32)
                    if (opcode === 0x32) {
                        // The MSR to read is specified by the ECX register.
                        const msrAddr = this.readRegister('ecx', 4); // In 32-bit mode, it's ECX

                        let valueToRead = 0n; // Default to 0 for unknown MSRs

                        // Check which MSR is being requested
                        if (msrAddr === 0xC0000080n) { // EFER MSR
                            valueToRead = this.efer;
                        } else {
                            console.warn(`RDMSR from unknown MSR 0x${msrAddr.toString(16)}`);
                        }

                        // The 64-bit result is placed in EDX:EAX
                        const low32 = valueToRead & 0xFFFFFFFFn;
                        const high32 = valueToRead >> 32n;

                        // A 32-bit write to EAX/EDX will correctly zero the upper bits of RAX/RDX.
                        this.writeRegister('eax', low32, 4);
                        this.writeRegister('edx', high32, 4);
                        
                        log(`Decoded: RDMSR (Read 0x${valueToRead.toString(16)} from MSR 0x${msrAddr.toString(16)} into EDX:EAX)`);
                        return true;
                    }
                    // JE/JZ (0x0F 84) - near jump with 32-bit displacement
                    if (opcode === 0x84) {
                        const displacement = this.readSignedImmediate(4); // Read 32-bit signed displacement
                        log(`Decoded: JE/JZ rel32 0x${displacement.toString(16)} (RIP adjusted)`);
                        if (this.flags.zf === 1) {
                            this.rip += displacement; // Apply displacement if ZF is set
                            log(`  Condition Met (ZF=1). Jumping to 0x${this.rip.toString(16)}`);
                        } else {
                            log(`  Condition Not Met (ZF=0). Not jumping.`);
                        }
                        return true;
                    }
                    // JNE/JNZ (0x0F 85) - near jump with 32-bit displacement
                    if (opcode === 0x85) {
                        const displacement = this.readSignedImmediate(4); // Read 32-bit signed displacement
                        log(`Decoded: JNE/JNZ rel32 0x${displacement.toString(16)} (RIP adjusted)`);
                        if (this.flags.zf === 0) {
                            this.rip += displacement; // Apply displacement if ZF is clear
                            log(`  Condition Met (ZF=0). Jumping to 0x${this.rip.toString(16)}`);
                        } else {
                            log(`  Condition Not Met (ZF=1). Not jumping.`);
                        }
                        return true;
                    }
                    // MOVZX Gv, Eb/Ew (0F B6 / 0F B7)
                    if (opcode === 0xB6 || opcode === 0xB7) {
                        const modrm = this.readModRMByte();
                        
                        // Determine the size of the source operand from the opcode.
                        // 0xB6 -> byte source, 0xB7 -> word source.
                        const srcSizeBytes = (opcode === 0xB6) ? 1 : 2;

                        // The destination size is the default operand size for the mode.
                        let destSizeBytes = defaultOperandSize;
                        // MOVZX to a 16-bit register is not valid in 64-bit mode without a 0x66 prefix.
                        // Our defaultOperandSize logic correctly handles this.

                        const destRegFullIndex = modrm.reg + (rex_r << 3);
                        const destRegName = this.getRegisterString(destRegFullIndex, destSizeBytes, rexPrefix !== 0);

                        const rmOperand = this.resolveModRMOperand(modrm, srcSizeBytes, rex_x, rex_b, rexPrefix !== 0);

                        let sourceValue;
                        if (rmOperand.type === 'reg') {
                            sourceValue = this.readRegister(rmOperand.name, srcSizeBytes);
                        } else { // Memory source
                            if (srcSizeBytes === 1) {
                                sourceValue = BigInt(this.readVirtualUint8(rmOperand.address));
                            } else { // 2 bytes
                                sourceValue = BigInt(this.readVirtualUint16(rmOperand.address));
                            }
                        }

                        // Write the smaller source value to the larger destination register.
                        // Our writeRegister function already handles the zero-extension correctly!
                        // For example, writeRegister('eax', 0x1234, 4) will set RAX to 0x1234,
                        // zeroing the upper 32 bits, which is the correct behavior.
                        this.writeRegister(destRegName, sourceValue, destSizeBytes);
                        
                        const srcStr = rmOperand.type === 'reg' ? rmOperand.name.toUpperCase() : `[0x${rmOperand.address.toString(16)}]`;
                        log(`Decoded: MOVZX ${destRegName.toUpperCase()}, ${srcStr}`);
                        return true;
                    }

                    // TODO: Implement other 2-byte Jcc instructions here (e.g., JCC, JNC, JS, JNS, JO, JNO, JP, JNP, JL, JGE, JLE, JG)

                    // LGDT and LIDT (0F 01 /2 and /3)
                    if (opcode === 0x01) {
                        const modrm = this.readModRMByte();

                        // LGDT m64 (opcode extension /2)
                        if (modrm.reg === 2) {
                            // THIS IS THE CRITICAL LINE
                            // We MUST call resolveModRMOperand to get the memory address
                            // AND to advance RIP past the ModR/M and any displacement bytes.
                            const memOperand = this.resolveModRMOperand(modrm, 8, rex_x, rex_b, rexPrefix !== 0);

                            // Now use the CORRECT address from the operand
                            const limit = this.readVirtualUint16(memOperand.address);
                            const base = this.readVirtualBigUint64(memOperand.address + 2n);

                            this.gdtr.limit = limit;
                            this.gdtr.base = base;

                            log(`Decoded: LGDT [0x${memOperand.address.toString(16)}] (Base: 0x${base.toString(16)}, Limit: 0x${limit.toString(16)})`);
                            return true;
                        }
                        
                        // LIDT m64 (opcode extension /3)
                        if (modrm.reg === 3) {
                            // THIS IS THE CRITICAL LINE
                            const memOperand = this.resolveModRMOperand(modrm, 8, rex_x, rex_b, rexPrefix !== 0);

                            // Now use the CORRECT address from the operand
                            const limit = this.readVirtualUint16(memOperand.address);
                            const base = this.readVirtualBigUint64(memOperand.address + 2n);

                            this.idtr.limit = limit;
                            this.idtr.base = base;

                            log(`Decoded: LIDT [0x${memOperand.address.toString(16)}] (Base: 0x${base.toString(16)}, Limit: 0x${limit.toString(16)})`);
                            return true;
                        }
                    }

                    // If a two-byte opcode is not handled here, it's genuinely unknown
                    log(`Unknown 2-byte opcode: 0x0F ${opcode.toString(16)} at 0x${currentRIPBeforeFetch.toString(16)}`);
                    return false; // Or false if you want to halt on unknown 2-byte opcodes
                }

                // Priority 2: Handle single-byte opcodes (only if not a two-byte opcode)

                // NOP instruction
                if (opcode === 0x90) {
                    log("Decoded: NOP");
                    return true;
                }

                // HLT instruction
                if (opcode === 0xF4) {
                    this.halted = true;
                    log("HLT instruction encountered. Emulation halted.");
                    return true;
                }

                // Conditional Jumps (short form: Jcc rel8)
                // These take a 1-byte signed relative displacement.
                // JE/JZ (0x74)
                if (opcode === 0x74) {
                    const displacement = this.readSignedImmediate(1); // Read 1-byte signed displacement
                    log(`Decoded: JE/JZ rel8 0x${displacement.toString(16)} (RIP adjusted)`);
                    if (this.flags.zf === 1) {
                        this.rip += displacement; // Apply displacement if ZF is set
                        log(`  Condition Met (ZF=1). Jumping to 0x${this.rip.toString(16)}`);
                    } else {
                        log(`  Condition Not Met (ZF=0). Not jumping.`);
                    }
                    return true;
                }

                // JNE/JNZ (0x75)
                if (opcode === 0x75) {
                    const displacement = this.readSignedImmediate(1); // Read 1-byte signed displacement
                    log(`Decoded: JNE/JNZ rel8 0x${displacement.toString(16)} (RIP adjusted)`);
                    if (this.flags.zf === 0) {
                        this.rip += displacement; // Apply displacement if ZF is clear
                        log(`  Condition Met (ZF=0). Jumping to 0x${this.rip.toString(16)}`);
                    } else {
                        log(`  Condition Not Met (ZF=1). Not jumping.`);
                    }
                    return true;
                }

                // Universal MOV reg, imm (0xB0 - 0xBF)
                if (opcode >= 0xB0 && opcode <= 0xBF) {
                    const destRegIdx = (opcode & 0x07) + (rex_b << 3);
                    let sizeBytes;

                    if (opcode >= 0xB0 && opcode <= 0xB7) { // 8-bit MOV (B0-B7)
                        sizeBytes = 1;
                    } else { // 16/32/64-bit MOV (B8-BF)
                        if (this.mode === 'long') {
                            sizeBytes = rex_w ? 8 : (this.operandSizeOverride ? 2 : 4);
                        } else { // Real or Protected mode
                            // Default is 16-bit. 0x66 prefix makes it 32-bit.
                            sizeBytes = this.operandSizeOverride ? 4 : 2;
                        }
                    }

                    const destRegName = this.getRegisterString(destRegIdx, sizeBytes, rexPrefix !== 0);
                    const immValue = this.readSignedImmediate(sizeBytes === 8 ? 8 : sizeBytes); // 64-bit imm is 64-bit
                    
                    this.writeRegister(destRegName, immValue, sizeBytes);
                    log(`Decoded: MOV ${destRegName.toUpperCase()}, 0x${immValue.toString(16)}`);
                    return true;
                }
                
                // ADD reg, r/m (0x01 / 0x03)
                if (opcode === 0x01 || opcode === 0x03) {
                    const modrm = this.readModRMByte();
                    const dBit = (opcode >>> 1) & 0x01; 
                    const wBit = opcode & 0x01;         

                    let sizeBytes = (wBit === 0) ? 1 : defaultOperandSize;

                    const regOpFullIndex = modrm.reg + (rex_r << 3);
                    const regOpName = this.getRegisterString(regOpFullIndex, sizeBytes, rexPrefix !== 0); // Pass hasRexPrefix
                    const rmOperand = this.resolveModRMOperand(modrm, sizeBytes, rex_x, rex_b, rexPrefix !== 0); // Pass hasRexPrefixForNaming

                    let sourceValue;
                    let destValue;
                    let destOperand; 

                    if (rmOperand.type === 'reg') {
                        if (dBit === 0) { 
                            sourceValue = this.readRegister(regOpName, sizeBytes);
                            destValue = this.readRegister(rmOperand.name, sizeBytes);
                            destOperand = rmOperand; 
                        } else { 
                            sourceValue = this.readRegister(rmOperand.name, sizeBytes);
                            destValue = this.readRegister(regOpName, sizeBytes);
                            destOperand = { type: 'reg', name: regOpName }; 
                        }
                    } else { 
                        if (dBit === 0) { 
                            sourceValue = this.readRegister(regOpName, sizeBytes);
                            if (sizeBytes === 1) destValue = BigInt(this.readVirtualUint8(rmOperand.address));
                            else if (sizeBytes === 2) destValue = BigInt(this.readVirtualUint16(rmOperand.address));
                            else if (sizeBytes === 4) destValue = BigInt(this.readVirtualUint32(rmOperand.address));
                            else if (sizeBytes === 8) destValue = this.readVirtualBigUint64(rmOperand.address);
                            else throw new Error("Unsupported memory read size for ADD.");
                            destOperand = rmOperand; 
                        } else { 
                            if (sizeBytes === 1) sourceValue = BigInt(this.readVirtualUint8(rmOperand.address));
                            else if (sizeBytes === 2) sourceValue = BigInt(this.readVirtualUint16(rmOperand.address));
                            else if (sizeBytes === 4) sourceValue = BigInt(this.readVirtualUint32(rmOperand.address));
                            else if (sizeBytes === 8) sourceValue = this.readVirtualBigUint64(rmOperand.address);
                            else throw new Error("Unsupported memory read size for ADD.");
                            destValue = this.readRegister(regOpName, sizeBytes);
                            destOperand = { type: 'reg', name: regOpName }; 
                        }
                    }
                    
                    const result = destValue + sourceValue;
                    this.updateArithmeticFlags(result, destValue, sourceValue, sizeBytes, 'add');

                    if (destOperand.type === 'reg') {
                        this.writeRegister(destOperand.name, result, sizeBytes);
                    } else { 
                        if (sizeBytes === 1) this.writeVirtualUint8(destOperand.address, Number(result));
                        else if (sizeBytes === 2) this.writeVirtualUint16(destOperand.address, Number(result));
                        else if (sizeBytes === 4) this.writeVirtualUint32(destOperand.address, Number(result));
                        else if (sizeBytes === 8) this.writeVirtualBigUint64(destOperand.address, result);
                        else throw new Error("Unsupported memory write size for ADD.");
                    }
                    log(`Decoded: ADD ${destOperand.type === 'reg' ? destOperand.name.toUpperCase() : `[0x${destOperand.address.toString(16)}]`}, ${sourceValue.toString(16)}${sizeBytes === 8 ? 'n' : ''} -> Result: 0x${result.toString(16)}n`);
                    return true;
                }

                // ADD EAX, imm32 (0x05)
                if (opcode === 0x05) {
                    const imm32 = this.readSignedImmediate(4);
                    const eaxValue = this.readRegister('eax', 4);
                    const result = eaxValue + imm32;
                    this.updateArithmeticFlags(result, eaxValue, imm32, 4, 'add');
                    this.writeRegister('eax', result, 4);
                    log(`Decoded: ADD EAX, 0x${imm32.toString(16)} (Result: 0x${result.toString(16)})`);
                    return true;
                }

                // OR reg, r/m; OR r/m, reg (0x09 / 0x0B for 16/32/64-bit, 0x08 / 0x0A for 8-bit)
                if (opcode >= 0x08 && opcode <= 0x0B) {
                    const modrm = this.readModRMByte();
                    const dBit = (opcode >>> 1) & 0x01; // Direction bit
                    const wBit = opcode & 0x01;         // Width bit

                    let sizeBytes = (wBit === 0) ? 1 : defaultOperandSize;

                    const regOpFullIndex = modrm.reg + (rex_r << 3);
                    const regOpName = this.getRegisterString(regOpFullIndex, sizeBytes, rexPrefix !== 0); // Pass hasRexPrefix
                    const rmOperand = this.resolveModRMOperand(modrm, sizeBytes, rex_x, rex_b, rexPrefix !== 0); // Pass hasRexPrefixForNaming

                    let sourceValue;
                    let destValue;
                    let destOperand;

                    if (rmOperand.type === 'reg') {
                        if (dBit === 0) { // OR r/m, reg (reg is source, r/m is dest)
                            sourceValue = this.readRegister(regOpName, sizeBytes);
                            destValue = this.readRegister(rmOperand.name, sizeBytes);
                            destOperand = rmOperand;
                        } else { // OR reg, r/m (r/m is source, reg is dest)
                            sourceValue = this.readRegister(rmOperand.name, sizeBytes);
                            destValue = this.readRegister(regOpName, sizeBytes);
                            destOperand = { type: 'reg', name: regOpName };
                        }
                    } else { // rmOperand.type === 'mem'
                        if (dBit === 0) { // OR r/m, reg (reg is source, r/m is dest)
                            sourceValue = this.readRegister(regOpName, sizeBytes);
                            if (sizeBytes === 1) destValue = BigInt(this.readVirtualUint8(rmOperand.address));
                            else if (sizeBytes === 2) destValue = BigInt(this.readVirtualUint16(rmOperand.address));
                            else if (sizeBytes === 4) destValue = BigInt(this.readVirtualUint32(rmOperand.address));
                            else if (sizeBytes === 8) destValue = this.readVirtualBigUint64(rmOperand.address);
                            else throw new Error("Unsupported memory read size for OR.");
                            destOperand = rmOperand;
                        } else { // OR reg, r/m (r/m is source, reg is dest)
                            if (sizeBytes === 1) sourceValue = BigInt(this.readVirtualUint8(rmOperand.address));
                            else if (sizeBytes === 2) sourceValue = BigInt(this.readVirtualUint16(rmOperand.address));
                            else if (sizeBytes === 4) sourceValue = BigInt(this.readVirtualUint32(rmOperand.address));
                            else if (sizeBytes === 8) sourceValue = this.readVirtualBigUint64(rmOperand.address);
                            else throw new Error("Unsupported memory read size for OR.");
                            destValue = this.readRegister(regOpName, sizeBytes);
                            destOperand = { type: 'reg', name: regOpName };
                        }
                    }
                    
                    const result = destValue | sourceValue; // Perform OR operation

                    this.flags.cf = 0; 
                    this.flags.of = 0; 
                    this.flags.zf = (result === 0n) ? 1 : 0; 
                    const bitWidth = BigInt(sizeBytes * 8);
                    const signBitMask = 1n << (bitWidth - 1n);
                    this.flags.sf = ((result & signBitMask) !== 0n) ? 1 : 0; 

                    if (destOperand.type === 'reg') {
                        this.writeRegister(destOperand.name, result, sizeBytes);
                    } else { 
                        if (sizeBytes === 1) this.writeVirtualUint8(destOperand.address, Number(result));
                        else if (sizeBytes === 2) this.writeVirtualUint16(destOperand.address, Number(result));
                        else if (sizeBytes === 4) this.writeVirtualUint32(destOperand.address, Number(result));
                        else if (sizeBytes === 8) this.writeVirtualBigUint64(destOperand.address, result);
                        else throw new Error("Unsupported memory write size for OR.");
                    }
                    const destOperandString = destOperand.type === 'reg' ? destOperand.name.toUpperCase() : `[0x${destOperand.address.toString(16)}]`;
                    const srcOperandString = (dBit === 0) ? regOpName.toUpperCase() : (rmOperand.type === 'reg' ? rmOperand.name.toUpperCase() : `[0x${rmOperand.address.toString(16)}]`);
                    log(`Decoded: OR ${destOperandString}, ${srcOperandString} (0x${destValue.toString(16)}n | 0x${sourceValue.toString(16)}n) -> Result: 0x${result.toString(16)}n`);
                    return true;
                }

                // OR AL/AX/EAX/RAX, imm (0x0C / 0x0D)
                if (opcode === 0x0C || opcode === 0x0D) {
                    const wBit = opcode & 0x01;
                    
                    // USE the defaultOperandSize calculated at the top of step().
                    // This is the source of truth for the operation's size.
                    let sizeBytes = (wBit === 0) ? 1 : defaultOperandSize;

                    const regName = this.getRegisterString(0, sizeBytes, rexPrefix !== 0); // Accumulator
                    const regValue = this.readRegister(regName, sizeBytes);

                    // The immediate value's size matches the operand size,
                    // except in 64-bit mode where it's a 32-bit immediate.
                    const immediateSize = (sizeBytes === 8) ? 4 : sizeBytes;
                    const immediateValue = this.readSignedImmediate(immediateSize);

                    const result = regValue | immediateValue;

                    // Flag Calculation
                    this.flags.of = 0;
                    this.flags.cf = 0;
                    const bitMask = (1n << BigInt(sizeBytes * 8)) - 1n;
                    this.flags.zf = (result & bitMask) === 0n ? 1 : 0;
                    const signBitMask = 1n << (BigInt(sizeBytes * 8) - 1n);
                    this.flags.sf = ((result & signBitMask) !== 0n) ? 1 : 0;
                    
                    this.writeRegister(regName, result, sizeBytes);

                    log(`Decoded: OR ${regName.toUpperCase()}, 0x${immediateValue.toString(16)}`);
                    return true;
                }

                // AND reg, r/m; AND r/m, reg (0x21 / 0x23 for 16/32/64-bit, 0x20 / 0x22 for 8-bit)
                // Note: This block handles AND r/m, reg and AND reg, r/m forms.
                // Opcodes:
                // 0x20: AND r/m8, reg8
                // 0x21: AND r/m16/32/64, reg16/32/64
                // 0x22: AND reg8, r/m8
                // 0x23: AND reg16/32/64, r/m16/32/64
                if (opcode >= 0x20 && opcode <= 0x23) {
                    const modrm = this.readModRMByte();
                    const dBit = (opcode >>> 1) & 0x01; // Direction bit: 0 = r/m <- reg; 1 = reg <- r/m
                    const wBit = opcode & 0x01;         // Width bit: 0 = 8-bit; 1 = 16/32/64-bit

                    let sizeBytes = (wBit === 0) ? 1 : defaultOperandSize;

                    // Use REX.R for the 'reg' field and REX.B for the 'rm' field in ModR/M
                    const regOpFullIndex = modrm.reg + (rex_r << 3);

                    const regOpName = this.getRegisterString(regOpFullIndex, sizeBytes, rexPrefix !== 0); // Pass hasRexPrefix
                    
                    // Resolve rmOperand, noting it might be a register or memory
                    const rmOperand = this.resolveModRMOperand(modrm, sizeBytes, rex_x, rex_b, rexPrefix !== 0); // Pass hasRexPrefixForNaming

                    let sourceValue;
                    let destValue;
                    let destOperand; // This will store where the result should be written

                    // Determine source and destination based on D-bit
                    if (dBit === 0) { // AND r/m, reg (reg is source, r/m is dest)
                        sourceValue = this.readRegister(regOpName, sizeBytes); // Source is the register specified by ModR/M.reg
                        if (rmOperand.type === 'reg') {
                            destValue = this.readRegister(rmOperand.name, sizeBytes);
                            destOperand = rmOperand;
                        } else { // Memory destination
                            if (sizeBytes === 1) destValue = BigInt(this.readVirtualUint8(rmOperand.address));
                            else if (sizeBytes === 2) destValue = BigInt(this.readVirtualUint16(rmOperand.address));
                            else if (sizeBytes === 4) destValue = BigInt(this.readVirtualUint32(rmOperand.address));
                            else if (sizeBytes === 8) destValue = this.readVirtualBigUint64(rmOperand.address);
                            else throw new Error("Unsupported memory read size for AND (dBit=0).");
                            destOperand = rmOperand;
                        }
                    } else { // dBit === 1: AND reg, r/m (r/m is source, reg is dest)
                        destValue = this.readRegister(regOpName, sizeBytes); // Destination is the register specified by ModR/M.reg
                        destOperand = { type: 'reg', name: regOpName }; // Set destination for writing

                        if (rmOperand.type === 'reg') {
                            sourceValue = this.readRegister(rmOperand.name, sizeBytes);
                        } else { // Memory source
                            if (sizeBytes === 1) sourceValue = BigInt(this.readVirtualUint8(rmOperand.address));
                            else if (sizeBytes === 2) sourceValue = BigInt(this.readVirtualUint16(rmOperand.address));
                            else if (sizeBytes === 4) sourceValue = BigInt(this.readVirtualUint32(rmOperand.address));
                            else if (sizeBytes === 8) sourceValue = this.readVirtualBigUint64(rmOperand.address);
                            else throw new Error("Unsupported memory read size for AND (dBit=1).");
                        }
                    }
                    
                    const result = destValue & sourceValue; // Perform AND operation

                    // For logical operations (AND, OR, XOR), CF and OF are always 0.
                    this.flags.cf = 0;
                    this.flags.of = 0;
                    this.flags.zf = (result === 0n) ? 1 : 0;
                    // SF is set if the most significant bit of the result is 1 (after masking to operand size)
                    const bitWidth = BigInt(sizeBytes * 8);
                    const signBitMask = 1n << (bitWidth - 1n);
                    this.flags.sf = ((result & signBitMask) !== 0n) ? 1 : 0;

                    // Write the result back to the destination operand
                    if (destOperand.type === 'reg') {
                        this.writeRegister(destOperand.name, result, sizeBytes);
                    } else { // destOperand.type === 'mem'
                        if (sizeBytes === 1) this.writeVirtualUint8(destOperand.address, Number(result));
                        else if (sizeBytes === 2) this.writeVirtualUint16(destOperand.address, Number(result));
                        else if (sizeBytes === 4) this.writeVirtualUint32(destOperand.address, Number(result));
                        else if (sizeBytes === 8) this.writeVirtualBigUint64(destOperand.address, result);
                        else throw new Error("Unsupported memory write size for AND.");
                    }
                    
                    // Improved logging for AND
                    const destOperandString = destOperand.type === 'reg' ? destOperand.name.toUpperCase() : `[0x${destOperand.address.toString(16)}]`;
                    const srcOperandString = (dBit === 0) ? regOpName.toUpperCase() : (rmOperand.type === 'reg' ? rmOperand.name.toUpperCase() : `[0x${rmOperand.address.toString(16)}]`);
                    log(`Decoded: AND ${destOperandString}, ${srcOperandString} (0x${destValue.toString(16)}n & 0x${sourceValue.toString(16)}n) -> Result: 0x${result.toString(16)}n`);
                    return true;
                }

                // XOR reg, r/m (0x31 / 0x33)
                if (opcode === 0x31 || opcode === 0x33) {
                    const modrm = this.readModRMByte();
                    const dBit = (opcode >>> 1) & 0x01; 
                    const wBit = opcode & 0x01;         

                    let sizeBytes = (wBit === 0) ? 1 : defaultOperandSize;

                    const regOpFullIndex = modrm.reg + (rex_r << 3);
                    const regOpName = this.getRegisterString(regOpFullIndex, sizeBytes, rexPrefix !== 0); // Pass hasRexPrefix
                    const rmOperand = this.resolveModRMOperand(modrm, sizeBytes, rex_x, rex_b, rexPrefix !== 0); // Pass hasRexPrefixForNaming

                    let sourceValue;
                    let destValue;
                    let destOperand;

                    if (rmOperand.type === 'reg') {
                        if (dBit === 0) { 
                            sourceValue = this.readRegister(regOpName, sizeBytes);
                            destValue = this.readRegister(rmOperand.name, sizeBytes);
                            destOperand = rmOperand;
                        } else { 
                            sourceValue = this.readRegister(rmOperand.name, sizeBytes);
                            destValue = this.readRegister(regOpName, sizeBytes);
                            destOperand = { type: 'reg', name: regOpName };
                        }
                    } else { 
                        if (dBit === 0) { 
                            sourceValue = this.readRegister(regOpName, sizeBytes);
                            if (sizeBytes === 1) destValue = BigInt(this.readVirtualUint8(rmOperand.address));
                            else if (sizeBytes === 2) destValue = BigInt(this.readVirtualUint16(rmOperand.address));
                            else if (sizeBytes === 4) destValue = BigInt(this.readVirtualUint32(rmOperand.address));
                            else if (sizeBytes === 8) destValue = this.readVirtualBigUint64(rmOperand.address);
                            else throw new Error("Unsupported memory read size for XOR.");
                            destOperand = rmOperand;
                        } else { 
                            if (sizeBytes === 1) sourceValue = BigInt(this.readVirtualUint8(rmOperand.address));
                            else if (sizeBytes === 2) sourceValue = BigInt(this.readVirtualUint16(rmOperand.address));
                            else if (sizeBytes === 4) sourceValue = BigInt(this.readVirtualUint32(rmOperand.address));
                            else if (sizeBytes === 8) sourceValue = this.readVirtualBigUint64(rmOperand.address);
                            else throw new Error("Unsupported memory read size for XOR.");
                            destValue = this.readRegister(regOpName, sizeBytes);
                            destOperand = { type: 'reg', name: regOpName };
                        }
                    }
                    
                    const result = destValue ^ sourceValue; // Perform XOR operation

                    this.flags.cf = 0; 
                    this.flags.of = 0; 
                    this.flags.zf = (result === 0n) ? 1 : 0; 
                    this.flags.sf = ((result >> (BigInt(sizeBytes * 8) - 1n)) & 1n) === 1n ? 1 : 0; 

                    if (destOperand.type === 'reg') {
                        this.writeRegister(destOperand.name, result, sizeBytes);
                    } else { 
                        if (sizeBytes === 1) this.writeVirtualUint8(destOperand.address, Number(result));
                        else if (sizeBytes === 2) this.writeVirtualUint16(destOperand.address, Number(result));
                        else if (sizeBytes === 4) this.writeVirtualUint32(destOperand.address, Number(result));
                        else if (sizeBytes === 8) this.writeVirtualBigUint64(destOperand.address, result);
                        else throw new Error("Unsupported memory write size for XOR.");
                    }
                    log(`Decoded: XOR ${destOperand.type === 'reg' ? destOperand.name.toUpperCase() : `[0x${destOperand.address.toString(16)}]`}, ${sourceValue.toString(16)}${sizeBytes === 8 ? 'n' : ''} -> Result: 0x${result.toString(16)}n`);
                    return true;
                }

                // SUB reg, r/m (0x29 / 0x2B)
                if (opcode === 0x29 || opcode === 0x2B) {
                    const modrm = this.readModRMByte();
                    const dBit = (opcode >>> 1) & 0x01; // Direction bit
                    const wBit = opcode & 0x01;         // Width bit

                    let sizeBytes = (wBit === 0) ? 1 : defaultOperandSize;

                    const regOpFullIndex = modrm.reg + (rex_r << 3);
                    const regOpName = this.getRegisterString(regOpFullIndex, sizeBytes, rexPrefix !== 0); // Pass hasRexPrefix
                    const rmOperand = this.resolveModRMOperand(modrm, sizeBytes, rex_x, rex_b, rexPrefix !== 0); // Pass hasRexPrefixForNaming

                    let sourceValue; // Subtrahend
                    let destValue;   // Minuend
                    let destOperand; 

                    if (rmOperand.type === 'reg') {
                        if (dBit === 0) { // SUB r/m, reg (reg is subtrahend, r/m is minuend/dest)
                            sourceValue = this.readRegister(regOpName, sizeBytes);
                            destValue = this.readRegister(rmOperand.name, sizeBytes);
                            destOperand = rmOperand; 
                        } else { // SUB reg, r/m (r/m is subtrahend, reg is minuend/dest)
                            sourceValue = this.readRegister(rmOperand.name, sizeBytes);
                            destValue = this.readRegister(regOpName, sizeBytes);
                            destOperand = { type: 'reg', name: regOpName }; 
                        }
                    } else { // rmOperand.type === 'mem'
                        if (dBit === 0) { // SUB r/m, reg (reg is subtrahend, r/m is minuend/dest)
                            sourceValue = this.readRegister(regOpName, sizeBytes);
                            if (sizeBytes === 1) destValue = BigInt(this.readVirtualUint8(rmOperand.address));
                            else if (sizeBytes === 2) destValue = BigInt(this.readVirtualUint16(rmOperand.address));
                            else if (sizeBytes === 4) destValue = BigInt(this.readVirtualUint32(rmOperand.address));
                            else if (sizeBytes === 8) destValue = this.readVirtualBigUint64(rmOperand.address);
                            else throw new Error("Unsupported memory read size for SUB.");
                            destOperand = rmOperand; 
                        } else { // SUB reg, r/m (r/m is subtrahend, reg is minuend/dest)
                            if (sizeBytes === 1) sourceValue = BigInt(this.readVirtualUint8(rmOperand.address));
                            else if (sizeBytes === 2) sourceValue = BigInt(this.readVirtualUint16(rmOperand.address));
                            else if (sizeBytes === 4) sourceValue = BigInt(this.readVirtualUint32(rmOperand.address));
                            else if (sizeBytes === 8) sourceValue = this.readVirtualBigUint64(rmOperand.address);
                            else throw new Error("Unsupported memory read size for SUB.");
                            destValue = this.readRegister(regOpName, sizeBytes);
                            destOperand = { type: 'reg', name: regOpName }; 
                        }
                    }
                    
                    const result = destValue - sourceValue;
                    this.updateArithmeticFlags(result, destValue, sourceValue, sizeBytes, 'sub');

                    if (destOperand.type === 'reg') {
                        this.writeRegister(destOperand.name, result, sizeBytes);
                    } else { // destOperand.type === 'mem'
                        if (sizeBytes === 1) this.writeVirtualUint8(destOperand.address, Number(result));
                        else if (sizeBytes === 2) this.writeVirtualUint16(destOperand.address, Number(result));
                        else if (sizeBytes === 4) this.writeVirtualUint32(destOperand.address, Number(result));
                        else if (sizeBytes === 8) this.writeVirtualBigUint64(destOperand.address, result);
                        else throw new Error("Unsupported memory write size for SUB.");
                    }
                    log(`Decoded: SUB ${destOperand.type === 'reg' ? destOperand.name.toUpperCase() : `[0x${destOperand.address.toString(16)}]`}, ${sourceValue.toString(16)}${sizeBytes === 8 ? 'n' : ''} -> Result: 0x${result.toString(16)}n`);
                    return true;
                }

                // CMP reg, r/m; CMP r/m, reg (0x39 / 0x3B for 32/64-bit, 0x38 / 0x3A for 8-bit)
                if (opcode >= 0x38 && opcode <= 0x3B) {
                    const modrm = this.readModRMByte();
                    const dBit = (opcode >>> 1) & 0x01; // Direction bit
                    const wBit = opcode & 0x01;         // Width bit

                    let sizeBytes = (wBit === 0) ? 1 : defaultOperandSize;

                    const regOpFullIndex = modrm.reg + (rex_r << 3);
                    const regOpName = this.getRegisterString(regOpFullIndex, sizeBytes, rexPrefix !== 0); // Pass hasRexPrefix
                    const rmOperand = this.resolveModRMOperand(modrm, sizeBytes, rex_x, rex_b, rexPrefix !== 0); // Pass hasRexPrefixForNaming

                    let sourceValue; // Subtrahend
                    let destValue;   // Minuend

                    if (rmOperand.type === 'reg') {
                        if (dBit === 0) { // CMP r/m, reg (reg is subtrahend, r/m is minuend)
                            sourceValue = this.readRegister(regOpName, sizeBytes);
                            destValue = this.readRegister(rmOperand.name, sizeBytes);
                        } else { // CMP reg, r/m (r/m is subtrahend, reg is minuend)
                            sourceValue = this.readRegister(rmOperand.name, sizeBytes);
                            destValue = this.readRegister(regOpName, sizeBytes);
                        }
                    } else { // rmOperand.type === 'mem'
                        if (dBit === 0) { // CMP r/m, reg (reg is subtrahend, r/m is minuend)
                            sourceValue = this.readRegister(regOpName, sizeBytes);
                            if (sizeBytes === 1) destValue = BigInt(this.readVirtualUint8(rmOperand.address));
                            else if (sizeBytes === 2) destValue = BigInt(this.readVirtualUint16(rmOperand.address));
                            else if (sizeBytes === 4) destValue = BigInt(this.readVirtualUint32(rmOperand.address));
                            else if (sizeBytes === 8) destValue = this.readVirtualBigUint64(rmOperand.address);
                            else throw new Error("Unsupported memory read size for CMP.");
                        } else { // CMP reg, r/m (r/m is subtrahend, reg is minuend)
                            if (sizeBytes === 1) sourceValue = BigInt(this.readVirtualUint8(rmOperand.address));
                            else if (sizeBytes === 2) sourceValue = BigInt(this.readVirtualUint16(rmOperand.address));
                            else if (sizeBytes === 4) sourceValue = BigInt(this.readVirtualUint32(rmOperand.address));
                            else if (sizeBytes === 8) sourceValue = this.readVirtualBigUint64(rmOperand.address);
                            else throw new Error("Unsupported memory read size for CMP.");
                            destValue = this.readRegister(regOpName, sizeBytes);
                        }
                    }
                    
                    // Perform the subtraction for flags, but do not write the result back
                    const result = destValue - sourceValue;
                    this.updateArithmeticFlags(result, destValue, sourceValue, sizeBytes, 'sub');

                    const destOperandString = (dBit === 0) ? (rmOperand.type === 'reg' ? rmOperand.name.toUpperCase() : `[0x${rmOperand.address.toString(16)}]`) : regOpName.toUpperCase();
                    const srcOperandString = (dBit === 0) ? regOpName.toUpperCase() : (rmOperand.type === 'reg' ? rmOperand.name.toUpperCase() : `[0x${rmOperand.address.toString(16)}]`);
                    log(`Decoded: CMP ${destOperandString}, ${srcOperandString} (0x${destValue.toString(16)}n - 0x${sourceValue.toString(16)}n)`);
                    return true;
                }

                // CMP r/m32, imm32 (0x81 /7)
                if (opcode === 0x81) {
                    const modrm = this.readModRMByte();
                    if (modrm.reg === 7) {
                        const imm32 = this.readSignedImmediate(4);
                        let sizeBytes = 4;
                        const rmOperand = this.resolveModRMOperand(modrm, sizeBytes, rex_x, rex_b, rexPrefix !== 0);

                        let destValue;
                        if (rmOperand.type === 'reg') {
                            destValue = this.readRegister(rmOperand.name, sizeBytes);
                        } else {
                            destValue = BigInt(this.readVirtualUint32(rmOperand.address));
                        }
                        const result = destValue - imm32;
                        this.updateArithmeticFlags(result, destValue, imm32, sizeBytes, 'sub');
                        log(`Decoded: CMP ${rmOperand.type === 'reg' ? rmOperand.name.toUpperCase() : `[0x${rmOperand.address.toString(16)}]`}, 0x${imm32.toString(16)}`);
                        return true;
                    }
                }

                // Group 1 Instructions (ADD, OR, ADC, SBB, AND, SUB, XOR, CMP) with immediate
                // 0x81: r/m, imm32
                // 0x83: r/m, imm8 (sign-extended)
                if (opcode === 0x81 || opcode === 0x83) {
                    const modrm = this.readModRMByte();
                    let sizeBytes = defaultOperandSize;

                    const rmOperand = this.resolveModRMOperand(modrm, sizeBytes, rex_x, rex_b, rexPrefix !== 0);

                    // Opcode 0x83 uses a sign-extended 8-bit immediate.
                    // Opcode 0x81 uses a 16/32-bit immediate.
                    const immediateSizeBytes = (opcode === 0x83) ? 1 : (sizeBytes === 2 ? 2 : 4);
                    const immediateValue = this.readSignedImmediate(immediateSizeBytes);

                    // Read the destination value
                    let destValue;
                    if (rmOperand.type === 'reg') {
                        destValue = this.readRegister(rmOperand.name, sizeBytes);
                    } else { // Memory
                        if (sizeBytes === 1) destValue = BigInt(this.readVirtualUint8(rmOperand.address));
                        else if (sizeBytes === 2) destValue = BigInt(this.readVirtualUint16(rmOperand.address));
                        else if (sizeBytes === 4) destValue = BigInt(this.readVirtualUint32(rmOperand.address));
                        else destValue = this.readVirtualBigUint64(rmOperand.address);
                    }

                    let result;
                    let operation = 'unknown';

                    // The 'reg' field selects the operation
                    switch (modrm.reg) {
                        case 0: // ADD
                            operation = 'add';
                            result = destValue + immediateValue;
                            break;
                        case 1: // OR
                            operation = 'or';
                            result = destValue | immediateValue;
                            break;
                        case 2: // ADC
                            operation = 'adc';
                            result = destValue + immediateValue + this.flags.cf;
                            break;
                        case 3: // SBB
                            operation = 'sbb';
                            result = destValue - immediateValue - this.flags.cf;
                            break;
                        case 4: // AND
                            operation = 'and';
                            result = destValue & immediateValue;
                            break;
                        case 5: // SUB
                            operation = 'sub';
                            result = destValue - immediateValue;
                            break;
                        case 6: // XOR
                            operation = 'xor';
                            result = destValue ^ immediateValue;
                            break;
                        case 7: // CMP
                            operation = 'sub'; // CMP performs a subtraction for flags
                            result = destValue - immediateValue;
                            break;
                        default:
                            throw new Error(`Unsupported Group 1 operation with /reg=${modrm.reg}`);
                    }

                    // Update flags based on the operation
                    if (operation === 'add' || operation === 'sub' || operation === 'adc' || operation === 'sbb') {
                        // For ADC and SBB, the "second operand" is conceptually the immediate value PLUS the carry/borrow.
                        const effectiveOperand2 = (operation === 'adc' || operation === 'sbb')
                            ? immediateValue + BigInt(this.flags.cf)
                            : immediateValue;
                        
                        // The operation for flags is always a simple add or sub.
                        const flagOperation = (operation === 'add' || operation === 'adc') ? 'add' : 'sub';

                        this.updateArithmeticFlags(result, destValue, effectiveOperand2, sizeBytes, flagOperation);
                    } else { // Logical ops (AND, OR, XOR)
                        this.flags.cf = 0;
                        this.flags.of = 0;
                        const bitMask = (1n << BigInt(sizeBytes * 8)) - 1n;
                        this.flags.zf = (result & bitMask) === 0n ? 1 : 0;
                        const signBitMask = 1n << (BigInt(sizeBytes * 8) - 1n);
                        this.flags.sf = ((result & signBitMask) !== 0n) ? 1 : 0;
                    }

                    // For all operations except CMP, write the result back
                    if (modrm.reg !== 7) { // if not CMP
                        if (rmOperand.type === 'reg') {
                            this.writeRegister(rmOperand.name, result, sizeBytes);
                        } else { // Memory
                            if (sizeBytes === 1) this.writeVirtualUint8(rmOperand.address, Number(result));
                            else if (sizeBytes === 2) this.writeVirtualUint16(rmOperand.address, Number(result));
                            else if (sizeBytes === 4) this.writeVirtualUint32(rmOperand.address, Number(result));
                            else this.writeVirtualBigUint64(rmOperand.address, result);
                        }
                    }
                    
                    const mnemonic = ['ADD', 'OR', 'ADC', 'SBB', 'AND', 'SUB', 'XOR', 'CMP'][modrm.reg];
                    const rmStr = rmOperand.type === 'reg' ? rmOperand.name.toUpperCase() : `[0x${rmOperand.address.toString(16)}]`;
                    log(`Decoded: ${mnemonic} ${rmStr}, 0x${immediateValue.toString(16)}`);
                    return true;
                }

                // CMP AL/AX/EAX/RAX, imm (0x3C / 0x3D)
                if (opcode === 0x3C || opcode === 0x3D) {
                    const wBit = opcode & 0x01;
                    let sizeBytes = (wBit === 0) ? 1 : defaultOperandSize;

                    const regName = this.getRegisterString(0, sizeBytes, rexPrefix !== 0); // Always AL/AX/EAX/RAX
                    const regValue = this.readRegister(regName, sizeBytes);
                    
                    // Note: Even for CMP RAX, the immediate is only 32 bits and is sign-extended.
                    const immediateSize = (sizeBytes === 1) ? 1 : 4;
                    const immediateValue = this.readSignedImmediate(immediateSize);

                    const result = regValue - immediateValue;
                    this.updateArithmeticFlags(result, regValue, immediateValue, sizeBytes, 'sub');
                    
                    // CMP does not store the result, it only sets flags.

                    log(`Decoded: CMP ${regName.toUpperCase()}, 0x${immediateValue.toString(16)}`);
                    return true;
                }

                // MOV r/m, reg; MOV reg, r/m (0x88, 0x89, 0x8A, 0x8B)
                if (opcode >= 0x88 && opcode <= 0x8B) {
                    const modrm = this.readModRMByte();
                    const dBit = (opcode >>> 1) & 0x01;
                    const wBit = opcode & 0x01;

                    let sizeBytes = (wBit === 0) ? 1 : defaultOperandSize;

                    const regOpFullIndex = modrm.reg + (rex_r << 3);
                    const regOpName = this.getRegisterString(regOpFullIndex, sizeBytes, rexPrefix !== 0);
                    const rmOperand = this.resolveModRMOperand(modrm, sizeBytes, rex_x, rex_b, rexPrefix !== 0);
                    
                    const fullRegNameForVerify = this.registers[regOpName]; // Get the full 64-bit register name (e.g., 'rax' from 'ax')

                    log(`--- MOV [r/m],reg START (Opcode: 0x${opcode.toString(16)}) ---`);
                    log(`  dBit=${dBit}, sizeBytes=${sizeBytes}, regOp=${regOpName}, rmOperand.addr=0x${rmOperand.address?.toString(16)}`);

                    if (dBit === 0) { // Direction: r/m <- reg
                        const sourceValue = this.readRegister(regOpName, sizeBytes);
                        log(`  DIRECTION: r/m <- reg. Writing 0x${sourceValue.toString(16)} from ${regOpName}...`);
                        
                        if (rmOperand.type === 'reg') {
                            this.writeRegister(rmOperand.name, sourceValue, sizeBytes);
                        } else { // Memory Destination
                            log(`  ...to MEMORY at 0x${rmOperand.address.toString(16)}`);
                            if (sizeBytes === 1) this.writeVirtualUint8(rmOperand.address, sourceValue);
                            else if (sizeBytes === 2) this.writeVirtualUint16(rmOperand.address, sourceValue);
                            else if (sizeBytes === 4) this.writeVirtualUint32(rmOperand.address, sourceValue);
                            else this.writeVirtualBigUint64(rmOperand.address, sourceValue);
                        }
                    } else { // dBit === 1, Direction: reg <- r/m
                        const destRegName = regOpName;
                        let sourceValue;
                        
                        log(`  DIRECTION: reg <- r/m. Reading from r/m operand...`);

                        if (rmOperand.type === 'reg') {
                            sourceValue = this.readRegister(rmOperand.name, sizeBytes);
                        } else { // Memory Source
                            sourceValue = sizeBytes === 1 ? BigInt(this.readVirtualUint8(rmOperand.address))
                                        : sizeBytes === 2 ? BigInt(this.readVirtualUint16(rmOperand.address))
                                        : sizeBytes === 4 ? BigInt(this.readVirtualUint32(rmOperand.address))
                                        : this.readVirtualBigUint64(rmOperand.address);
                        }
                        
                        log(`  Read value 0x${sourceValue.toString(16)} from r/m. Writing to ${destRegName}.`);
                        this.writeRegister(destRegName, sourceValue, sizeBytes);

                        log(`  VERIFY: After writing to ${destRegName}, the full register ${fullRegNameForVerify} is now 0x${this[fullRegNameForVerify].toString(16)}`);
                    }
                    log(`--- MOV [r/m],reg END ---`);
                    return true;
                }

                // MOV r/m, imm (0xC6 /0 for byte, 0xC7 /0 for word/dword/qword)
                if (opcode === 0xC6 || opcode === 0xC7) {
                    const modrm = this.readModRMByte();
                    if (modrm.reg !== 0) { // /0 opcode extension
                        throw new Error(`Invalid ModR/M reg field for MOV r/m, imm: ${modrm.reg}`);
                    }

                    const wBit = opcode & 0x01;
                    let destSizeBytes = (wBit === 0) ? 1 : defaultOperandSize;
                    
                    // In 64-bit mode, a 32-bit destination with C7 is the default.
                    // REX.W promotes it to 64-bit.
                    if (this.mode === 'long' && wBit === 1 && !rex_w) {
                        destSizeBytes = 4;
                    }

                    const rmOperand = this.resolveModRMOperand(modrm, destSizeBytes, rex_x, rex_b, rexPrefix !== 0);

                    // Determine immediate size. For 64-bit destinations, it's a 32-bit immediate.
                    const immediateSizeBytes = (destSizeBytes === 8) ? 4 : destSizeBytes;
                    const immediateValue = this.readSignedImmediate(immediateSizeBytes);

                    // Write the value to the destination
                    if (rmOperand.type === 'reg') {
                        this.writeRegister(rmOperand.name, immediateValue, destSizeBytes);
                    } else { // Memory Destination
                        if (destSizeBytes === 1) {
                            this.writeVirtualUint8(rmOperand.address, Number(immediateValue));
                        } else if (destSizeBytes === 2) {
                            this.writeVirtualUint16(rmOperand.address, Number(immediateValue));
                        } else if (destSizeBytes === 4) {
                            this.writeVirtualUint32(rmOperand.address, Number(immediateValue));
                        } else { // 8 bytes (qword)
                            // The immediate is 32-bit but needs to be sign-extended to 64-bit
                            const finalValue = BigInt.asIntN(32, immediateValue);
                            this.writeVirtualBigUint64(rmOperand.address, finalValue);
                        }
                    }
                    
                    const destStr = rmOperand.type === 'reg' ? rmOperand.name.toUpperCase() : `${destSizeBytes === 1 ? "BYTE" : destSizeBytes === 2 ? "WORD" : destSizeBytes === 4 ? "DWORD" : "QWORD"} [0x${rmOperand.address.toString(16)}]`;
                    log(`Decoded: MOV ${destStr}, 0x${immediateValue.toString(16)}`);
                    return true;
                }

                // MOV SR, r/m16 (0x8E /r)
                if (opcode === 0x8E) {
                    const modrm = this.readModRMByte();
                
                    const segmentRegs = ['es', 'cs', 'ss', 'ds', 'fs', 'gs'];
                    const sregName = segmentRegs[modrm.reg];
                
                    if (!sregName) {
                        throw new Error(`Invalid segment register index: ${modrm.reg}`);
                    }
                
                    const rmOperand = this.resolveModRMOperand(modrm, 2, rex_x, rex_b, rexPrefix !== 0);
                
                    let value;
                    if (rmOperand.type === 'reg') {
                        value = Number(this.readRegister(rmOperand.name, 2)); // value is 16-bit number
                    } else {
                        value = this.readVirtualUint16(rmOperand.address);
                    }
                
                    // Write value into the segment register (16-bit)
                    this.writeRegister(sregName, BigInt(value), 2);
                
                    log(`Decoded: MOV ${sregName.toUpperCase()}, ${rmOperand.type === 'reg' ? rmOperand.name.toUpperCase() : `[0x${rmOperand.address.toString(16)}]`} (0x${value.toString(16)})`);
                    return true;
                }

                // PUSH reg (0x50 - 0x57)
                if (opcode >= 0x50 && opcode <= 0x57) {
                    // The operand size is determined by the effective default size.
                    // In Real/Protected mode, it's 16/32. In Long mode, it's always 64.
                    const sizeBytes = (this.mode === 'long') ? 8 : defaultOperandSize;

                    const regIdx = (opcode - 0x50) + (rex_b << 3);
                    // Use the full 64-bit register name even for 16/32-bit pushes
                    // because we read the value from the full register.
                    const regName = this.getRegisterString(regIdx, 8, rexPrefix !== 0);
                    const value = this.readRegister(regName, sizeBytes);

                    this.rsp -= BigInt(sizeBytes);
                    
                    if (sizeBytes === 2) {
                        this.writeVirtualUint16(this.rsp, value);
                    } else if (sizeBytes === 4) {
                        this.writeVirtualUint32(this.rsp, value);
                    } else { // 8 bytes
                        this.writeVirtualBigUint64(this.rsp, value);
                    }

                    log(`Decoded: PUSH ${this.getRegisterString(regIdx, sizeBytes, rexPrefix !== 0).toUpperCase()}`);
                    return true;
                }

                // PUSH r/m (0xFF /6)
                if (opcode === 0xFF) {
                    const modrm = this.readModRMByte();
                    if (modrm.reg === 6) { // PUSH r/m
                        let sizeBytes = defaultOperandSize;
                        const rmOperand = this.resolveModRMOperand(modrm, sizeBytes, rex_x, rex_b, rexPrefix !== 0);
                        
                        let value;
                        if (rmOperand.type === 'reg') {
                            value = this.readRegister(rmOperand.name, sizeBytes);
                        } else {
                            if (sizeBytes === 1) value = BigInt(this.readVirtualUint8(rmOperand.address));
                            else if (sizeBytes === 2) value = BigInt(this.readVirtualUint16(rmOperand.address));
                            else if (sizeBytes === 4) value = BigInt(this.readVirtualUint32(rmOperand.address));
                            else if (sizeBytes === 8) value = this.readVirtualBigUint64(rmOperand.address);
                            else throw new Error("Unsupported memory read size for PUSH r/m.");
                        }
                        log(`PUSH ${rmOperand.type === 'reg' ? rmOperand.name.toUpperCase() : `[0x${rmOperand.address.toString(16)}]`} - RSP Before: 0x${this.rsp.toString(16)}`);
                        this.rsp -= BigInt(sizeBytes);
                        this.writeVirtualBigUint64(this.rsp, value);
                        
                        log(`Decoded: PUSH ${rmOperand.type === 'reg' ? rmOperand.name.toUpperCase() : `[0x${rmOperand.address.toString(16)}]`} (0x${value.toString(16)}n)`);
                        log(`PUSH ${rmOperand.type === 'reg' ? rmOperand.name.toUpperCase() : `[0x${rmOperand.address.toString(16)}]`} - RSP After: 0x${this.rsp.toString(16)}`);
                        return true;
                    }
                }

                // POP reg (0x58 - 0x5F)
                if (opcode >= 0x58 && opcode <= 0x5F) {
                    const sizeBytes = (this.mode === 'long') ? 8 : defaultOperandSize;

                    const regIdx = (opcode - 0x58) + (rex_b << 3);
                    const regName = this.getRegisterString(regIdx, sizeBytes, rexPrefix !== 0);
                    
                    let value;
                    if (sizeBytes === 2) {
                        value = this.readVirtualUint16(this.rsp);
                    } else if (sizeBytes === 4) {
                        value = this.readVirtualUint32(this.rsp);
                    } else { // 8 bytes
                        value = this.readVirtualBigUint64(this.rsp);
                    }

                    this.writeRegister(regName, value, sizeBytes);
                    this.rsp += BigInt(sizeBytes);
                    
                    log(`Decoded: POP ${regName.toUpperCase()}`);
                    return true;
                }

                // POP r/m (0x8F /0)
                if (opcode === 0x8F) {
                    const modrm = this.readModRMByte();
                    if (modrm.reg === 0) { // POP r/m
                        let sizeBytes = defaultOperandSize;
                        const rmOperand = this.resolveModRMOperand(modrm, sizeBytes, rex_x, rex_b, rexPrefix !== 0);
                        
                        log(`POP ${rmOperand.type === 'reg' ? rmOperand.name.toUpperCase() : `[0x${rmOperand.address.toString(16)}]`} - RSP Before: 0x${this.rsp.toString(16)}`);
                        this.rsp += BigInt(sizeBytes);
                        this.writeRegister(rmOperand.name, value, sizeBytes);

                        let value;
                        if (rmOperand.type === 'reg') {
                            value = this.readRegister(rmOperand.name, sizeBytes);
                        } else {
                            if (sizeBytes === 1) value = BigInt(this.readVirtualUint8(rmOperand.address));
                            else if (sizeBytes === 2) value = BigInt(this.readVirtualUint16(rmOperand.address));
                            else if (sizeBytes === 4) value = BigInt(this.readVirtualUint32(rmOperand.address));
                            else if (sizeBytes === 8) value = this.readVirtualBigUint64(rmOperand.address);
                            else throw new Error("Unsupported memory read size for POP r/m.");
                        }

                        log(`Decoded: POP ${rmOperand.type === 'reg' ? rmOperand.name.toUpperCase() : `[0x${rmOperand.address.toString(16)}]`} (0x${value.toString(16)}n)`);
                        log(`POP ${rmOperand.type === 'reg' ? rmOperand.name.toUpperCase() : `[0x${rmOperand.address.toString(16)}]`} - RSP After: 0x${this.rsp.toString(16)}`);
                        return true;
                    }
                }

                // CALL rel32 (0xE8) - Near, relative, 32-bit displacement
                if (opcode === 0xE8) {
                    // The instruction is 5 bytes long: 1 for the opcode (E8) + 4 for the displacement.
                    const instructionLength = 5n;

                    // The return address is ALWAYS the address of the instruction AFTER this one.
                    // We use currentRIPBeforeFetch as our stable anchor to calculate this.
                    const retAddr = currentRIPBeforeFetch + instructionLength;

                    // Now, read the displacement from the stream. This will advance the real 'this.rip'.
                    const displacement = this.readSignedImmediate(4);

                    // The jump target is the return address + the displacement.
                    const newRip = retAddr + displacement;

                    // Push the return address to the stack.
                    this.rsp -= 8n;
                    this.writeVirtualBigUint64(this.rsp, retAddr);

                    // Set RIP to the target function's address.
                    this.rip = newRip;

                    log(`Decoded: CALL rel32 (Jumping to 0x${newRip.toString(16)}, Return Address: 0x${retAddr.toString(16)})`);
                    return true;
                }

                // CALL r/m (0xFF /2) - Near, absolute, indirect
                if (opcode === 0xFF) {
                    const modrm = this.readModRMByte();
                    if (modrm.reg === 2) { // opcode extension /2
                        let sizeBytes = defaultOperandSize;
                        const rmOperand = this.resolveModRMOperand(modrm, sizeBytes, rex_x, rex_b, rexPrefix !== 0);
                        
                        let tgtAddr;
                        if (rmOperand.type === 'reg') {
                            tgtAddr = this.readRegister(rmOperand.name, sizeBytes);
                        } else {
                            if (sizeBytes === 1) tgtAddr = BigInt(this.readVirtualUint8(rmOperand.address));
                            else if (sizeBytes === 2) tgtAddr = BigInt(this.readVirtualUint16(rmOperand.address));
                            else if (sizeBytes === 4) tgtAddr = BigInt(this.readVirtualUint32(rmOperand.address));
                            else if (sizeBytes === 8) tgtAddr = this.readVirtualBigUint64(rmOperand.address);
                            else throw new Error("Unsupported memory read size for CALL r/m.");
                        }
                        
                        const retAddr = this.rip;
                        log(`CALL r/m - RSP Before: 0x${this.rsp.toString(16)}`);
                        this.rsp -= 8n;
                        this.writeVirtualBigUint64(this.rsp, retAddr);
                        this.rip = tgtAddr;

                        log(`Decoded: CALL ${rmOperand.type === 'reg' ? rmOperand.name.toUpperCase() : `[0x${rmOperand.address.toString(16)}]`} (Indirect, jumping to 0x${this.rip.toString(16)})`);
                        log(`CALL r/m - RSP After: 0x${this.rsp.toString(16)}`);
                        return true;
                    }
                }

                // RET (0xC3) - Near return
                if (opcode === 0xC3) {
                    log(`RET - RSP Before: 0x${this.rsp.toString(16)}`);
                    const retAddr = this.readVirtualBigUint64(this.rsp);
                    this.rsp += 8n;
                    this.rip = retAddr;

                    log(`Decoded: RET (Near, jumping to 0x${this.rip.toString(16)})`);
                    log(`RET - RSP After: 0x${this.rsp.toString(16)}`);
                    return true;
                }

                // RET imm16 (0xC2) - Near, return with immediate
                if (opcode === 0xC2) {
                    const imm16 = this.readSignedImmediate(2);
                    log(`RET imm16 - RSP Before: 0x${this.rsp.toString(16)}`);
                    const retAddr = this.readVirtualBigUint64(this.rsp);
                    this.rsp += 8n;
                    this.rip = retAddr;
                    this.rsp += BigInt(imm16);

                    log(`Decoded: RET imm16 (jumping to 0x${this.rip.toString(16)}, stack adjust by 0x${imm16.toString(16)})`);
                    log(`RET imm16 - RSP After: 0x${this.rsp.toString(16)}`);
                    return true;
                }

                // LEA r/m, reg (0x8D)
                if (opcode === 0x8D) {
                    const modrm = this.readModRMByte();
                    // LEA only works with memory sources, so mod must not be 3
                    if (modrm.mod === 3) {
                        throw new Error("Invalid use of LEA with register source.");
                    }

                    let sizeBytes = defaultOperandSize;
                    // Note: In 64-bit mode, operand size can be 16, 32, or 64.
                    // REX.W=1 -> 64-bit. No REX.W -> 32-bit. 0x66 prefix -> 16-bit.

                    const destRegFullIndex = modrm.reg + (rex_r << 3);
                    const destRegName = this.getRegisterString(destRegFullIndex, sizeBytes, rexPrefix !== 0);

                    // Here's the magic: we use resolveModRMOperand to get the address
                    const memOperand = this.resolveModRMOperand(modrm, sizeBytes, rex_x, rex_b, rexPrefix !== 0);
                    const effectiveAddress = memOperand.address;

                    // ...but we write the address itself to the destination register.
                    this.writeRegister(destRegName, effectiveAddress, sizeBytes);

                    log(`Decoded: LEA ${destRegName.toUpperCase()}, [address] (Calculated address: 0x${effectiveAddress.toString(16)})`);
                    return true;
                }

                // TEST r/m, reg (0x84, 0x85)
                if (opcode === 0x84 || opcode === 0x85) {
                    const modrm = this.readModRMByte();
                    const wBit = opcode & 0x01;
                    let sizeBytes = (wBit === 0) ? 1 : defaultOperandSize;

                    const regOpFullIndex = modrm.reg + (rex_r << 3);
                    const regOpName = this.getRegisterString(regOpFullIndex, sizeBytes, rexPrefix !== 0);
                    const rmOperand = this.resolveModRMOperand(modrm, sizeBytes, rex_x, rex_b, rexPrefix !== 0);

                    let val1, val2;
                    val1 = this.readRegister(regOpName, sizeBytes); // Operand from reg field

                    if (rmOperand.type === 'reg') {
                        val2 = this.readRegister(rmOperand.name, sizeBytes);
                    } else { // Memory operand
                        if (sizeBytes === 1) val2 = BigInt(this.readVirtualUint8(rmOperand.address));
                        else if (sizeBytes === 2) val2 = BigInt(this.readVirtualUint16(rmOperand.address));
                        else if (sizeBytes === 4) val2 = BigInt(this.readVirtualUint32(rmOperand.address));
                        else val2 = this.readVirtualBigUint64(rmOperand.address);
                    }

                    const result = val1 & val2;

                    // TEST sets flags based on the result but doesn't store it
                    this.flags.cf = 0;
                    this.flags.of = 0;
                    this.flags.zf = (result === 0n) ? 1 : 0;
                    const signBitMask = 1n << (BigInt(sizeBytes * 8) - 1n);
                    this.flags.sf = ((result & signBitMask) !== 0n) ? 1 : 0;
                    // Parity Flag (PF) is also affected, but you can add that later.

                    const rmOperandStr = rmOperand.type === 'reg' ? rmOperand.name.toUpperCase() : `[0x${rmOperand.address.toString(16)}]`;
                    log(`Decoded: TEST ${rmOperandStr}, ${regOpName.toUpperCase()}`);
                    return true;
                }

                // TEST AL, imm8 (0xA8)
                if (opcode === 0xA8) {
                    const imm8 = this.readSignedImmediate(1);
                    const alValue = this.readRegister('al', 1);
                    const result = alValue & imm8;

                    // TEST instruction updates flags but does not store the result.
                    // It performs a bitwise AND and sets flags based on the outcome.
                    this.flags.cf = 0; // Cleared by TEST
                    this.flags.of = 0; // Cleared by TEST

                    this.flags.zf = (result === 0n) ? 1 : 0;
                    this.flags.sf = ((result & 0x80n) !== 0n) ? 1 : 0;
                    // Note: Parity Flag (PF) is also affected but not implemented here.

                    log(`Decoded: TEST AL, 0x${imm8.toString(16)} (Result for flags: 0x${result.toString(16)})`);
                    return true;
                }

                // TEST AX/EAX/RAX, imm16/imm32 (0xA9)
                if (opcode === 0xA9) {
                    let sizeBytes = defaultOperandSize;

                    // Determine the size of the immediate value. 
                    // For 64-bit operations, the immediate is a 32-bit value.
                    const immediateSizeBytes = (sizeBytes === 8) ? 4 : sizeBytes;
                    const immediateValue = this.readSignedImmediate(immediateSizeBytes);
                    
                    const regName = this.getRegisterString(0, sizeBytes, rexPrefix !== 0); // Accumulator (AX/EAX/RAX)
                    const regValue = this.readRegister(regName, sizeBytes);

                    const result = regValue & immediateValue;

                    // TEST updates flags and discards the result.
                    this.flags.cf = 0;
                    this.flags.of = 0;

                    this.flags.zf = (result === 0n) ? 1 : 0;
                    
                    // Set Sign Flag if the most significant bit of the result is 1.
                    const signBitMask = 1n << (BigInt(sizeBytes * 8) - 1n);
                    this.flags.sf = ((result & signBitMask) !== 0n) ? 1 : 0;
                    // Note: Parity Flag (PF) is also affected but not implemented here.

                    log(`Decoded: TEST ${regName.toUpperCase()}, 0x${immediateValue.toString(16)} (Result for flags: 0x${result.toString(16)})`);
                    return true;
                }

                // Group 2 Immediate Instructions (ROL, ROR, RCL, RCR, SHL, SHR, SAR)
                if (opcode === 0xC0 || opcode === 0xC1) {
                    const modrm = this.readModRMByte();
                    const wBit = opcode & 0x01;
                    let sizeBytes = (wBit === 0) ? 1 : defaultOperandSize;
                    
                    const rmOperand = this.resolveModRMOperand(modrm, sizeBytes, rex_x, rex_b, rexPrefix !== 0);
                    const shiftCount = this.readSignedImmediate(1); // imm8

                    // Read the value to be shifted
                    let value;
                    if (rmOperand.type === 'reg') {
                        value = this.readRegister(rmOperand.name, sizeBytes);
                    } else {
                        // Read from memory
                        if (sizeBytes === 1) value = BigInt(this.readVirtualUint8(rmOperand.address));
                        else if (sizeBytes === 2) value = BigInt(this.readVirtualUint16(rmOperand.address));
                        else if (sizeBytes === 4) value = BigInt(this.readVirtualUint32(rmOperand.address));
                        else value = this.readVirtualBigUint64(rmOperand.address);
                    }

                    let result;
                    let mnemonic = "UNKNOWN_SHIFT";

                    // The 'reg' field of ModR/M acts as an opcode extension here
                    switch (modrm.reg) {
                        case 4: // SHL
                            mnemonic = "SHL";
                            result = value << shiftCount;
                            // TODO: Set CF and OF correctly for SHL
                            break;
                        case 5: // SHR
                            mnemonic = "SHR";
                            result = value >> shiftCount;
                            // TODO: Set CF and OF correctly for SHR
                            break;
                        // Add other shifts like SAR (case 7) here
                        default:
                            throw new Error(`Unhandled Group 2 instruction with /reg=${modrm.reg}`);
                    }

                    // Update flags (simplified for now)
                    this.flags.zf = (result === 0n) ? 1 : 0;
                    // SF update needs to consider the size
                    const bitWidth = BigInt(sizeBytes * 8);
                    const signBitMask = 1n << (bitWidth - 1n);
                    this.flags.sf = ((result & signBitMask) !== 0n) ? 1 : 0;

                    // Write the result back
                    if (rmOperand.type === 'reg') {
                        this.writeRegister(rmOperand.name, result, sizeBytes);
                    } else {
                        // Write to memory
                        if (sizeBytes === 1) this.writeVirtualUint8(rmOperand.address, Number(result));
                        else if (sizeBytes === 2) this.writeVirtualUint16(rmOperand.address, Number(result));
                        else if (sizeBytes === 4) this.writeVirtualUint32(rmOperand.address, Number(result));
                        else this.writeVirtualBigUint64(rmOperand.address, result);
                    }

                    const rmOperandStr = rmOperand.type === 'reg' ? rmOperand.name.toUpperCase() : `[0x${rmOperand.address.toString(16)}]`;
                    log(`Decoded: ${mnemonic} ${rmOperandStr}, ${shiftCount}`);
                    return true;
                }

                // JL rel8 (0x7C)
                if (opcode === 0x7C) {
                    const displacement = this.readSignedImmediate(1);
                    log(`Decoded: JL rel8 0x${displacement.toString(16)}`);
                    if (this.flags.sf !== this.flags.of) { // Condition for JL
                        this.rip += displacement;
                        log(`  Condition Met (SF!=OF). Jumping to 0x${this.rip.toString(16)}`);
                    } else {
                        log(`  Condition Not Met. Not jumping.`);
                    }
                    return true;
                }

                // JB rel8 (0x72)
                if (opcode === 0x72) {
                    const displacement = this.readSignedImmediate(1);
                    log(`Decoded: JB rel8 0x${displacement.toString(16)}`);
                    if (this.flags.cf !== 0) { // Condition for JB
                        this.rip += displacement;
                        log(`  Condition Met (CF!=0). Jumping to 0x${this.rip.toString(16)}`);
                    } else {
                        log(`  Condition Not Met. Not jumping.`);
                    }
                    return true;
                }

                // JMP rel8 (0xEB)
                if (opcode === 0xEB) {
                    // Read the 8-bit signed relative displacement
                    const displacement = this.readSignedImmediate(1);
                    
                    // Add the displacement to the current RIP to perform the jump
                    this.rip += displacement;
                    
                    log(`Decoded: JMP rel8 0x${displacement.toString(16)} (Jumping to 0x${this.rip.toString(16)})`);
                    return true;
                }

                // IRETQ (0xCF)
                if (opcode === 0xCF) {
                    // Pop the interrupt number we pushed
                    const interruptNumber = Number(this.readVirtualBigUint64(this.rsp));
                    this.rsp += 8n;

                    // Page Faults (#8, #10-14, #17) push an error code.
                    const hasErrorCode = [8, 10, 11, 12, 13, 14, 17].includes(interruptNumber);
                    if (hasErrorCode) {
                        this.rsp += 8n; // Discard the error code
                    }

                    // Now pop the standard frame
                    this.rip = this.readVirtualBigUint64(this.rsp);
                    this.rsp += 8n;
                    
                    this.readVirtualBigUint64(this.rsp);
                    this.rsp += 8n;
                    
                    const new_rflags = this.readVirtualBigUint64(this.rsp);
                    this.disassembleRFlags(new_rflags);
                    this.rsp += 8n;
                    
                    log(`Decoded: IRETQ from INT #${interruptNumber} (Returning to 0x${this.rip.toString(16)})`);
                    return true;
                }

                // OUT DX, AL (0xEE)
                if (opcode === 0xEE) {
                    // The port number is read from the 16-bit DX register
                    const port = this.readRegister('dx', 2);
                    const value = this.readRegister('al', 1);
                    
                    this.io.portOut(Number(port), Number(value), 1); // size is 1 byte
                    
                    log(`Decoded: OUT DX, AL (Wrote 0x${value.toString(16)} to port 0x${port.toString(16)})`);
                    return true;
                }

                // OUT imm8, AL (0xE6)
                if (opcode === 0xE6) {
                    const port = this.readInstructionByte(); // Read the port number from the instruction
                    const value = this.readRegister('al', 1); // Get the value from the AL register
                    
                    this.io.portOut(port, Number(value), 1); // Send the data to the I/O bus

                    log(`Decoded: OUT imm8, AL (Wrote 0x${value.toString(16)} to port 0x${port.toString(16)})`);
                    return true;
                }

                // LODSB (0xAC)
                if (opcode === 0xAC) {
                    // 1. Read the byte from memory at [RSI]
                    const value = this.readVirtualUint8(this.rsi);
                    
                    // 2. Put that byte into AL
                    this.writeRegister('al', value, 1);
                    
                    // 3. Increment RSI by 1
                    // (Note: A full implementation would check the Direction Flag (DF),
                    // but the default is to increment, which is all we need here).
                    this.rsi += 1n;
        
                    log(`Decoded: LODSB (Loaded 0x${value.toString(16)} into AL, RSI is now 0x${this.rsi.toString(16)})`);
                    return true;
                }

                // IN AL, imm8 (0xE4)
                if (opcode === 0xE4) {
                    const port = this.readInstructionByte(); // Read 8-bit port from instruction
                    const value = this.io.portIn(port, 1);   // Read 1 byte from the I/O bus
                    this.writeRegister('al', value, 1);      // Write the value to AL

                    log(`Decoded: IN AL, imm8 (Read 0x${value.toString(16)} from port 0x${port.toString(16)} into AL)`);
                    return true;
                }

                // IN AL, DX (0xEC)
                if (opcode === 0xEC) {
                    const port = this.readRegister('dx', 2);   // Read 16-bit port from DX
                    const value = this.io.portIn(Number(port), 1); // Read 1 byte from the I/O bus
                    this.writeRegister('al', value, 1);        // Write the value to AL

                    log(`Decoded: IN AL, DX (Read 0x${value.toString(16)} from port 0x${port.toString(16)} into AL)`);
                    return true;
                }

                // INC r/m (0xFE /0 for byte, 0xFF /0 for word/dword/qword)
                if (opcode === 0xFE || opcode === 0xFF) {
                    const modrm = this.readModRMByte();
                    
                    // This instruction is selected when the /reg field of the ModR/M byte is 0.
                    if (modrm.reg === 0) {
                        const wBit = opcode & 0x01;
                        // Opcode 0xFE is always 1 byte.
                        // Opcode 0xFF uses defaultOperandSize (word, dword, or qword).
                        let sizeBytes = (wBit === 0) ? 1 : defaultOperandSize;

                        const rmOperand = this.resolveModRMOperand(modrm, sizeBytes, rex_x, rex_b, rexPrefix !== 0);
                        
                        let value;
                        // Read the current value from the register or memory
                        if (rmOperand.type === 'reg') {
                            value = this.readRegister(rmOperand.name, sizeBytes);
                        } else {
                            if (sizeBytes === 1) value = BigInt(this.readVirtualUint8(rmOperand.address));
                            else if (sizeBytes === 2) value = BigInt(this.readVirtualUint16(rmOperand.address));
                            else if (sizeBytes === 4) value = BigInt(this.readVirtualUint32(rmOperand.address));
                            else value = this.readVirtualBigUint64(rmOperand.address);
                        }

                        const result = value + 1n;

                        // --- Correct Flag Calculation for INC ---
                        // IMPORTANT: INC does NOT affect the Carry Flag (CF).
                        // It affects OF, SF, ZF, AF, PF.
                        const originalCF = this.flags.cf; // Preserve the original Carry Flag

                        // We can use our existing function, but for a fake 'add' of 1
                        this.updateArithmeticFlags(result, value, 1n, sizeBytes, 'add');

                        this.flags.cf = originalCF; // Restore the Carry Flag
                        // --- End Flag Calculation ---
                        
                        // Write the result back
                        if (rmOperand.type === 'reg') {
                            this.writeRegister(rmOperand.name, result, sizeBytes);
                        } else {
                            if (sizeBytes === 1) this.writeVirtualUint8(rmOperand.address, Number(result));
                            else if (sizeBytes === 2) this.writeVirtualUint16(rmOperand.address, Number(result));
                            else if (sizeBytes === 4) this.writeVirtualUint32(rmOperand.address, Number(result));
                            else this.writeVirtualBigUint64(rmOperand.address, result);
                        }
                        
                        const operandStr = rmOperand.type === 'reg' ? rmOperand.name.toUpperCase() : `[0x${rmOperand.address.toString(16)}]`;
                        log(`Decoded: INC ${operandStr}`);
                        return true;
                    }
                }

                // STI (Set Interrupt Flag)
                if (opcode === 0xFB) {
                    this.flags.if = 1;
                    log("Decoded: STI");
                    return true;
                }

                // CLI (Clear Interrupt Flag)
                if (opcode === 0xFA) {
                    this.flags.if = 0;
                    log("Decoded: CLI");
                    return true;
                }

                // JMP ptr16:16 (Far Jump) - Opcode 0xEA
                if (opcode === 0xEA) {
                    // This instruction is special. In the 16-bit boot stub, the assembler
                    // always generates a 16-bit offset and a 16-bit selector.
                    // We will hardcode the handler to read these sizes to match the
                    // machine code, ignoring defaultOperandSize for this specific opcode.
                    
                    // We must use physical reads because paging is not yet effective
                    // for the instruction stream itself.
                    const offset = this.memory.readUint16(Number(this.rip));
                    this.rip += 2n;

                    const new_cs = this.memory.readUint16(Number(this.rip));
                    this.rip += 2n;

                    // Set the new segment and instruction pointer
                    this.cs = BigInt(new_cs);
                    this.rip = BigInt(offset);
                    
                    // Re-evaluating the CPU mode here is good practice after loading CS.
                    this.updateCPUMode();
                    
                    log(`Decoded: JMP far 0x${new_cs.toString(16)}:0x${offset.toString(16)}`);
                    return true;
                }

                // If an instruction falls through all specific handlers, it's truly unknown
                log(`Unknown opcode: 0x${(twoByteOpcode ? '0F ' : '')}${opcode.toString(16)} at 0x${currentRIPBeforeFetch.toString(16)}`); // Use currentRIPBeforeFetch for unknown opcodes
                return false;
            } catch (e) {
                if (e instanceof PageFaultException) {
                    console.warn(`--- Caught Page Fault at RIP 0x${currentRIPBeforeFetch.toString(16)}. Invoking handler. ---`);
                    this.rip = currentRIPBeforeFetch; // IMPORTANT: Restore RIP to the address of the *faulting* instruction
                    this.triggerInterrupt(14, e.errorCode);
                } else {
                    console.error(`Fatal error during execution at RIP 0x${currentRIPBeforeFetch.toString(16)}:`, e);
                    throw e;
                }
            }
            return true;
        }

        readInstructionByte() {
            let byte;
            // Instruction fetches (RIP-relative access) depend on current mode and paging state
            // If Protected Mode (CR0.PE) is enabled, all accesses are virtual from instruction stream's perspective.
            // The translateVirtualToPhysical will handle the specific paging checks (PG, PAE, LME).
            if ((this.cr0 & CPU.CR0_PE) !== 0n) { 
                byte = this.readVirtualUint8(this.rip);
            } else { // Real Mode
                byte = this.memory.readUint8(Number(this.rip));
            }
            this.rip++;
            return byte;
        }

        readInstructionUint16() {
            const lo = this.readInstructionByte();
            const hi = this.readInstructionByte();
            return (hi << 8) | lo;
        }

        readInstructionUint32() {
            const b1 = this.readInstructionByte();
            const b2 = this.readInstructionByte();
            const b3 = this.readInstructionByte();
            const b4 = this.readInstructionByte();
            return (b4 << 24) | (b3 << 16) | (b2 << 8) | b1;
        }

        readModRMByte() {
            // ModR/M byte is also part of the instruction stream, so it should use readInstructionByte logic
            // This ensures it correctly reads from virtual or physical memory.
            const modrm = this.readInstructionByte(); 
            const mod = (modrm >>> 6) & 0x03;
            const reg = (modrm >>> 3) & 0x07;
            const rm = modrm & 0x07;
            return { mod, reg, rm, raw: modrm };
        }

        getRegisterString(regIndex, sizeBytes, hasRexPrefix = false) {
            const regNames64 = ['rax', 'rcx', 'rdx', 'rbx', 'rsp', 'rbp', 'rsi', 'rdi', 'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15'];
            const regNames32 = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'r8d', 'r9d', 'r10d', 'r11d', 'r12d', 'r13d', 'r14d', 'r15d'];
            const regNames16 = ['ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di', 'r8w', 'r9w', 'r10w', 'r11w', 'r12w', 'r13w', 'r14w', 'r15w'];
            
            // Arrays for 8-bit register naming based on REX prefix presence
            const regNames8Low = ['al', 'cl', 'dl', 'bl']; // Indices 0-3 (always same)
            const regNames8HighNoRex = ['ah', 'ch', 'dh', 'bh']; // Indices 4-7 (if NO REX prefix)
            const regNames8NewRex = ['spl', 'bpl', 'sil', 'dil']; // Indices 4-7 (if REX prefix IS present)
            const regNames8Extended = ['r8b', 'r9b', 'r10b', 'r11b', 'r12b', 'r13b', 'r14b', 'r15b']; // Indices 8-15 (always used with REX)

            if (regIndex < 0 || regIndex > 15) {
                throw new Error(`Invalid register index: ${regIndex}`);
            }

            switch (sizeBytes) {
                case 1:
                    if (regIndex >= 8) { // Registers R8B-R15B (always require REX to be accessed by these names)
                        return regNames8Extended[regIndex - 8];
                    } else if (regIndex >= 4) { // Registers AX/CX/DX/BX's high byte or SPL/BPL/SIL/DIL
                        if (hasRexPrefix) {
                            return regNames8NewRex[regIndex - 4];
                        } else {
                            return regNames8HighNoRex[regIndex - 4];
                        }
                    } else { // Registers AL/CL/DL/BL
                        return regNames8Low[regIndex];
                    }
                case 2: return regNames16[regIndex];
                case 4: return regNames32[regIndex];
                case 8: return regNames64[regIndex];
                default: throw new Error(`Invalid register size for naming: ${sizeBytes}`);
            }
        }

        readSignedImmediate(sizeBytes) {
            let rawValue;
            if (sizeBytes === 1) {
                rawValue = this.readInstructionByte();
                if (rawValue & 0x80) return BigInt(rawValue - 0x100);
                return BigInt(rawValue);
            }
            if (sizeBytes === 2) {
                rawValue = this.readInstructionUint16();
                if (rawValue & 0x8000) return BigInt(rawValue - 0x10000);
                return BigInt(rawValue);
            }
            if (sizeBytes === 4) {
                rawValue = this.readInstructionUint32();
                if (rawValue & 0x80000000) return BigInt(rawValue - 0x100000000);
                return BigInt(rawValue);
            }
            // For 64-bit, we need a 64-bit reader
            const lo = this.readInstructionUint32();
            const hi = this.readInstructionUint32();
            return (BigInt(hi) << 32n) | BigInt(lo);
        }

        readSIBByte(mod) {
            const sib = this.readInstructionByte();
            const scaleBits = (sib >>> 6) & 0x03;
            const indexBits = (sib >>> 3) & 0x07;
            const baseBits = sib & 0x07;

            // Scale is either 1, 2, 4, or 8
            const scale = 1 << scaleBits;

            const idxRegName = this.getRegisterString(indexBits, 8, false);
            const baseRegName = this.getRegisterString(baseBits, 8, false);

            let baseValue = 0n;

            // Special case: if base is RBP/EBP and mod is 00, there is no base register
            if (!(baseBits === 5 && mod === 0)) {
                baseValue = this.readRegister(baseRegName, 8);
            }

            let indexValue = 0n;
           // Special case: if index is RSP, there is no index register
            if (indexBits !== 4) {
                indexValue = this.readRegister(idxRegName, 8);
            }

            const addr = baseValue + (indexValue * BigInt(scale));
            log(`  SIB Decoded: Base=${baseRegName}, Index=${idxRegName}, Scale=${scale} => Address component = 0x${addr.toString(16)}`);
            return addr;
        }

        resolveModRMOperand(modrm, sizeBytes, rex_x, rex_b, hasRexPrefix) {
            if (modrm.mod === 0b11) {
                const rmIndex = modrm.rm + (rex_b << 3);
                return { type: 'reg', name: this.getRegisterString(rmIndex, sizeBytes, hasRexPrefix) };
            }

            let effectiveAddressSize;
            if (this.mode === 'real') {
                effectiveAddressSize = this.addressSizeOverride ? 32 : 16;
            } else { // Protected or Long Mode
                effectiveAddressSize = this.addressSizeOverride ? 16 : 32;
            }

            let effectiveAddress = 0n;

            if (effectiveAddressSize === 16) {
                // --- 16-bit Addressing Logic ---
                const baseLookups = ['bx+si', 'bx+di', 'bp+si', 'bp+di', 'si', 'di', 'bp', 'bx'];
                
                if (modrm.mod === 0b00 && modrm.rm === 0b110) {
                    effectiveAddress = BigInt(this.readInstructionUint16());
                } else {
                    const baseStr = baseLookups[modrm.rm];
                    if (baseStr.includes('bx')) effectiveAddress += this.readRegister('bx', 2);
                    if (baseStr.includes('si')) effectiveAddress += this.readRegister('si', 2);
                    if (baseStr.includes('di')) effectiveAddress += this.readRegister('di', 2);
                    if (baseStr.includes('bp')) effectiveAddress += this.readRegister('bp', 2);
                }

                if (modrm.mod === 0b01) {
                    effectiveAddress += this.readSignedImmediate(1);
                } else if (modrm.mod === 0b10) {
                    effectiveAddress += this.readSignedImmediate(2);
                }
                
                return { type: 'mem', address: effectiveAddress & 0xFFFFn, sizeBytes };
            } else {
                // --- 32/64-bit Addressing Logic ---
                // (Your existing SIB logic goes here, unchanged)
                const sibPresent = (modrm.rm === 0b100);

                if (sibPresent) {
                    const sib = this.readInstructionByte();
                    const scale = 1 << ((sib >>> 6) & 0x03);
                    const indexBits = ((sib >>> 3) & 0x07) + (rex_x << 3);
                    const baseBits = (sib & 0x07) + (rex_b << 3);

                    if (indexBits !== 0b100) {
                        const indexRegName = this.getRegisterString(indexBits, 8, true);
                        effectiveAddress += this.readRegister(indexRegName, 8) * BigInt(scale);
                    }

                    if (modrm.mod !== 0b00 || baseBits !== 0b101) {
                        const baseRegName = this.getRegisterString(baseBits, 8, true);
                        effectiveAddress += this.readRegister(baseRegName, 8);
                    }
                } else if (modrm.mod === 0b00 && modrm.rm === 0b101) {
                    effectiveAddress = this.rip + this.readSignedImmediate(4);
                    return { type: 'mem', address: effectiveAddress, sizeBytes };
                } else {
                    const baseRegIndex = modrm.rm + (rex_b << 3);
                    const baseRegName = this.getRegisterString(baseRegIndex, 8, hasRexPrefix);
                    effectiveAddress = this.readRegister(baseRegName, 8);
                }

                if (modrm.mod === 0b01) {
                    effectiveAddress += this.readSignedImmediate(1);
                } else if (modrm.mod === 0b10) {
                    effectiveAddress += this.readSignedImmediate(4);
                }
                
                return { type: 'mem', address: effectiveAddress, sizeBytes };
            }
        }

        updateCPUMode() {
            const peBit = (this.cr0 & CPU.CR0_PE) !== 0n;       
            const pgBit = (this.cr0 & CPU.CR0_PG) !== 0n; 
            const paeBit = (this.cr4 & CPU.CR4_PAE) !== 0n; 
            const lmeBit = (this.efer & CPU.EFER_LME) !== 0n; 

            // --- NEW DEBUGGING LOGS ---
            log(`\n--- DEBUG: updateCPUMode called ---`);
            log(`  Current CR0:  0x${this.cr0.toString(16).padStart(16, '0')} (PE: ${peBit}, PG: ${pgBit})`);
            log(`  Current CR4:  0x${this.cr4.toString(16).padStart(16, '0')} (PAE: ${paeBit})`);
            log(`  Current EFER: 0x${this.efer.toString(16).padStart(16, '0')} (LME: ${lmeBit})`);
            log(`  Combined Condition (LME && PAE && PG): ${lmeBit && paeBit && pgBit}`);
            // --- END DEBUGGING LOGS ---
        
            if (!peBit) {
                this.mode = 'real';
            } else { 
                if (lmeBit && paeBit && pgBit) { 
                    this.mode = 'long';
                    log("CPU Mode: Long Mode (64-bit) enabled.");
                } else if (pgBit && paeBit) { 
                    this.mode = 'protected_pae'; 
                    log("CPU Mode: Protected Mode (32-bit) with PAE enabled.");
                } else if (pgBit) {
                    this.mode = 'protected_32bit_paging'; 
                    log("CPU Mode: Protected Mode (32-bit) with Paging enabled.");
                } else {
                    this.mode = 'protected'; 
                    log("CPU Mode: Protected Mode (32-bit) enabled (no paging).");
                }
            }
            log(`DEBUG: updateCPUMode - Mode finalized as: ${this.mode}\n`);
        }

        readVirtualUint8(virtualAddr) {
            const physicalAddr = this.translateVirtualToPhysical(virtualAddr, 1, 'read');
            // Add bounds check for physical memory to catch issues *before* DataView throws
            if (physicalAddr < 0n || physicalAddr >= BigInt(this.memory.buffer.byteLength)) {
                console.error(`Attempt to read physical address 0x${physicalAddr.toString(16)} outside memory bounds (0x0 to 0x${BigInt(this.memory.buffer.byteLength).toString(16)}).`);
                throw new Error(`MEMORY_ACCESS_VIOLATION: Read from physical address 0x${physicalAddr.toString(16)}`);
            }
            return this.memory.readUint8(Number(physicalAddr));
        }

        writeVirtualUint8(virtualAddr, value) {
            const physicalAddr = this.translateVirtualToPhysical(virtualAddr, 1, 'write');
            if (physicalAddr < 0n || physicalAddr >= BigInt(this.memory.buffer.byteLength)) {
                console.error(`Attempt to write physical address 0x${physicalAddr.toString(16)} outside memory bounds (0x0 to 0x${BigInt(this.memory.buffer.byteLength).toString(16)}).`);
                throw new Error(`MEMORY_ACCESS_VIOLATION: Write to physical address 0x${physicalAddr.toString(16)}`);
            }
            this.memory.writeUint8(Number(physicalAddr), value);
        }

        readVirtualUint16(virtualAddr) {
            const physicalAddr = this.translateVirtualToPhysical(virtualAddr, 2, 'read');
            if (physicalAddr < 0n || physicalAddr + 1n >= BigInt(this.memory.buffer.byteLength)) { // +1n for 2-byte read
                console.error(`Attempt to read physical address 0x${physicalAddr.toString(16)} outside memory bounds.`);
                throw new Error(`MEMORY_ACCESS_VIOLATION: Read from physical address 0x${physicalAddr.toString(16)}`);
            }
            return this.memory.readUint16(Number(physicalAddr));
        }

        writeVirtualUint16(virtualAddr, value) {
            const physicalAddr = this.translateVirtualToPhysical(virtualAddr, 2, 'write');
            if (physicalAddr < 0n || physicalAddr + 1n >= BigInt(this.memory.buffer.byteLength)) { // +1n for 2-byte write
                console.error(`Attempt to write physical address 0x${physicalAddr.toString(16)} outside memory bounds.`);
                throw new Error(`MEMORY_ACCESS_VIOLATION: Write to physical address 0x${physicalAddr.toString(16)}`);
            }
            this.memory.writeUint16(Number(physicalAddr), value);
        }

        readVirtualUint32(virtualAddr) {
            const physicalAddr = this.translateVirtualToPhysical(virtualAddr, 4, 'read');
            if (physicalAddr < 0n || physicalAddr + 3n >= BigInt(this.memory.buffer.byteLength)) { // +3n for 4-byte read
                console.error(`Attempt to read physical address 0x${physicalAddr.toString(16)} outside memory bounds.`);
                throw new Error(`MEMORY_ACCESS_VIOLATION: Read from physical address 0x${physicalAddr.toString(16)}`);
            }
            return this.memory.readUint32(Number(physicalAddr));
        }

        writeVirtualUint32(virtualAddr, value) {
            const physicalAddr = this.translateVirtualToPhysical(virtualAddr, 4, 'write');
            if (physicalAddr < 0n || physicalAddr + 3n >= BigInt(this.memory.buffer.byteLength)) { // +3n for 4-byte write
                console.error(`Attempt to write physical address 0x${physicalAddr.toString(16)} outside memory bounds.`);
                throw new Error(`MEMORY_ACCESS_VIOLATION: Write to physical address 0x${physicalAddr.toString(16)}`);
            }
            this.memory.writeUint32(Number(physicalAddr), value);
        }

        readVirtualBigUint64(virtualAddr) {
            const physicalAddr = this.translateVirtualToPhysical(virtualAddr, 8, 'read');
            if (physicalAddr < 0n || physicalAddr + 7n >= BigInt(this.memory.buffer.byteLength)) { // +7n for 8-byte read
                console.error(`Attempt to read physical address 0x${physicalAddr.toString(16)} outside memory bounds.`);
                throw new Error(`MEMORY_ACCESS_VIOLATION: Read from physical address 0x${physicalAddr.toString(16)}`);
            }
            return this.memory.readBigUint64(Number(physicalAddr)); 
        }

        writeVirtualBigUint64(virtualAddr, value) {
            const physicalAddr = this.translateVirtualToPhysical(virtualAddr, 8, 'write');
            if (physicalAddr < 0n || physicalAddr + 7n >= BigInt(this.memory.buffer.byteLength)) { // +7n for 8-byte write
                console.error(`Attempt to write physical address 0x${physicalAddr.toString(16)} outside memory bounds.`);
                throw new Error(`MEMORY_ACCESS_VIOLATION: Write to physical address 0x${physicalAddr.toString(16)}`);
            }
            this.memory.writeBigUint64(Number(physicalAddr), value); 
        }

        translateVirtualToPhysical(virtualAddr, sizeBytes, accessType) {
            if (this.mode === 'real') {
                return virtualAddr;
            }

            const pgBit = (this.cr0 & CPU.CR0_PG) !== 0n;
            const paeBit = (this.cr4 & CPU.CR4_PAE) !== 0n;
            const lmeBit = (this.efer & CPU.EFER_LME) !== 0n;

            // This guard determines when the full 4-level paging logic is active.
            if (this.mode !== 'long' || !pgBit || !paeBit || !lmeBit) {
                console.warn(`Paging not fully enabled for Long Mode. Current mode: ${this.mode}. CR0.PG=${pgBit}, CR4.PAE=${paeBit}, EFER.LME=${lmeBit}. Returning virtual as physical.`);
                return virtualAddr; // Pass through if paging is not fully active
            }

            // --- Paging Enabled for Long Mode (the real work begins here) ---
            log(`Paging: Translating virtual address 0x${virtualAddr.toString(16)} in ${this.mode} mode.`);

            const pml4BasePhys = this.cr3 & ~0xFFFn;
            log(`  PML4 Base Phys: 0x${pml4BasePhys.toString(16).padStart(16, '0')}`); 

            const pml4Index = (virtualAddr >> 39n) & 0x1FFn; 
            let pml4eAddr = pml4BasePhys + (pml4Index * 8n); 
            log(`  PML4E Addr: 0x${pml4eAddr.toString(16).padStart(16, '0')} (Index: ${pml4Index})`);
            let pml4e = this.memory.readBigUint64(Number(pml4eAddr));
            log(`  PML4E Value: 0x${pml4e.toString(16).padStart(16, '0')}`);

            if ((pml4e & CPU.PTE_PRESENT) === 0n) {
                console.error(`Page Fault (#PF): PML4E not present for VA 0x${virtualAddr.toString(16)}`);
                throw new PageFaultException(`PML4E not present`, 0n);
            }        

            let pdptBasePhys = pml4e & ~0xFFFn;
            log(`  PDPT Base Phys: 0x${pdptBasePhys.toString(16).padStart(16, '0')}`); 
            const pdptIndex = (virtualAddr >> 30n) & 0x1FFn; 
            let pdpteAddr = pdptBasePhys + (pdptIndex * 8n); 
            log(`  PDPTE Addr: 0x${pdpteAddr.toString(16).padStart(16, '0')} (Index: ${pdptIndex})`);
            let pdpte = this.memory.readBigUint64(Number(pdpteAddr));
            log(`  PDPTE Value: 0x${pdpte.toString(16).padStart(16, '0')}`);

            if ((pdpte & CPU.PTE_PRESENT) === 0n) {
                console.error(`Page Fault (#PF): PDPTE not present for VA 0x${virtualAddr.toString(16)}`);
                throw new PageFaultException(`PDPTE not present`, 0n);
            }

            if ((pdpte & CPU.PTE_PAGE_SIZE) !== 0n) { // 1GB page
                const pageBaseAddr = pdpte & 0xFFFFFFFC0000000n; 
                const offset = virtualAddr & 0x3FFFFFFFfn; 
                const physical = pageBaseAddr | offset;
                log(`  Translated 1GB page: VA 0x${virtualAddr.toString(16)} -> PA 0x${physical.toString(16)}`);
                return physical;
            }

            let pdBasePhys = pdpte & ~0xFFFn;
            log(`  PD Base Phys: 0x${pdBasePhys.toString(16).padStart(16, '0')}`); 
            const pdIndex = (virtualAddr >> 21n) & 0x1FFn; 
            let pdeAddr = pdBasePhys + (pdIndex * 8n); 
            log(`  PDE Addr: 0x${pdeAddr.toString(16).padStart(16, '0')} (Index: ${pdIndex})`);
            let pde = this.memory.readBigUint64(Number(pdeAddr));
            log(`  PDE Value: 0x${pde.toString(16).padStart(16, '0')}`);

            if ((pde & CPU.PTE_PRESENT) === 0n) {
                console.error(`Page Fault (#PF): PDE not present for VA 0x${virtualAddr.toString(16)}`);
                throw new PageFaultException(`PDE not present`, 0n);
            }

            if ((pde & CPU.PTE_PAGE_SIZE) !== 0n) { // 2MB page
                const pageBaseAddr = pde & 0xFFFFFFFE00000n; 
                const offset = virtualAddr & 0x1FFFFFn; 
                const physical = pageBaseAddr | offset;
                log(`  Translated 2MB page: VA 0x${virtualAddr.toString(16)} -> PA 0x${physical.toString(16)}`);
                return physical;
            }

            let ptBasePhys = pde & ~0xFFFn;
            log(`  PT Base Phys: 0x${ptBasePhys.toString(16).padStart(16, '0')}`); 
            const ptIndex = (virtualAddr >> 12n) & 0x1FFn; 
            let pteAddr = ptBasePhys + (ptIndex * 8n); 
            log(`  PTE Addr: 0x${pteAddr.toString(16).padStart(16, '0')} (Index: ${ptIndex})`);
            let pte = this.memory.readBigUint64(Number(pteAddr));
            log(`  PTE Value: 0x${pte.toString(16).padStart(16, '0')}`);

            if ((pte & CPU.PTE_PRESENT) === 0n) {
                console.error(`Page Fault (#PF): PTE not present for VA 0x${virtualAddr.toString(16)}`);
                throw new PageFaultException(`PTE not present`, 0n);
            }

            if (accessType === 'write' && (pte & CPU.PTE_READ_WRITE) === 0n) {
                // The page is present but read-only. This is a page fault.
                // The error code for a protection violation has bit 0 set.
                throw new PageFaultException(`Protection Violation on write to VA 0x${virtualAddr.toString(16)}`, 1n);
            }

            const pageBaseAddr = pte & ~0xFFFn; 
            const offset = virtualAddr & 0xFFFn; 
            const physical = pageBaseAddr | offset;
            log(`  Final Page Base Addr: 0x${pageBaseAddr.toString(16).padStart(16, '0')}`);
            log(`  Page Offset: 0x${offset.toString(16).padStart(3, '0')}`);
            log(`  Calculated Physical: 0x${physical.toString(16).padStart(16, '0')}`);

            return physical;
        }

        triggerInterrupt(interruptNumber, errorCode = null) {
            log(`--- INTERRUPT TRIGGERED: #${interruptNumber} ---`);

            const descriptorAddr = this.idtr.base + BigInt(interruptNumber * 16);

            log(`  IDTR.base = 0x${this.idtr.base.toString(16)}`);
            log(`  Interrupt #${interruptNumber} @ 0x${descriptorAddr.toString(16)}`);
            log(`  Raw bytes: ${[...new Uint8Array(this.memory.buffer.slice(Number(descriptorAddr), Number(descriptorAddr + 16n)))]
            .map(b => b.toString(16).padStart(2, '0')).join(' ')}`);

            const lowSlice = this.readVirtualBigUint64(descriptorAddr);
            const highSlice = this.readVirtualBigUint64(descriptorAddr + 8n);
            log(`DEBUG: Descriptor at 0x${descriptorAddr.toString(16)} is: LOW=0x${lowSlice.toString(16)} HIGH=0x${highSlice.toString(16)}`);

            // === FINAL, CORRECTED PARSING LOGIC v3 ===
            // This logic correctly decodes the structure created by the assembly code.
            const offset_15_0  = lowSlice & 0xFFFFn;
            const offset_31_16 = (lowSlice >> 48n) & 0xFFFFn;
            const offset_63_32 = highSlice & 0xFFFFFFFFn;

            const handlerAddr = (offset_63_32 << 32n) | (offset_31_16 << 16n) | offset_15_0;
            // ===========================================

            const segmentSelector = (lowSlice >> 16n) & 0xFFFFn;
            const type_attrs = (lowSlice >> 40n) & 0xFFn;
            const present = (type_attrs & 0x80n) !== 0n;

            if (!present) {
                throw new Error(`Interrupt Handler #${interruptNumber} not present! Double Fault.`);
            }

            // Push state onto the stack
            this.rsp -= 8n;
            this.writeVirtualBigUint64(this.rsp, this.assembleRFlags());
            this.rsp -= 8n;
            this.writeVirtualBigUint64(this.rsp, segmentSelector);
            this.rsp -= 8n;
            this.writeVirtualBigUint64(this.rsp, this.rip);
            if (errorCode !== null) {
                this.rsp -= 8n;
                this.writeVirtualBigUint64(this.rsp, errorCode);
            }
            this.rsp -= 8n;
            this.writeVirtualBigUint64(this.rsp, BigInt(interruptNumber));

            log(`DEBUG: Parsed handlerAddr = 0x${handlerAddr.toString(16)}`);
            log(`  offset_15_0  = 0x${offset_15_0.toString(16)}`);
            log(`  offset_31_16 = 0x${offset_31_16.toString(16)}`);
            log(`  offset_63_32 = 0x${offset_63_32.toString(16)}`);

            // Jump to the handler
            this.rip = handlerAddr;
            
            log(`  Jumping to handler at 0x${handlerAddr.toString(16)}`);
        }

        assembleRFlags() {
            let flags = 0n;
            if (this.flags.cf) flags |= (1n << CPU.FLAG_CF_BIT);
            if (this.flags.zf) flags |= (1n << CPU.FLAG_ZF_BIT);
            if (this.flags.sf) flags |= (1n << CPU.FLAG_SF_BIT);
            if (this.flags.of) flags |= (1n << CPU.FLAG_OF_BIT);
            if (this.flags.if) flags |= (1n << CPU.FLAG_IF_BIT);
            // Always set bit 1 to 1, as per specification
            flags |= (1n << 1n);
            return flags;
        }

        disassembleRFlags(rflagsValue) {
            this.flags.cf = ((rflagsValue >> CPU.FLAG_CF_BIT) & 1n) === 1n ? 1 : 0;
            this.flags.zf = ((rflagsValue >> CPU.FLAG_ZF_BIT) & 1n) === 1n ? 1 : 0;
            this.flags.sf = ((rflagsValue >> CPU.FLAG_SF_BIT) & 1n) === 1n ? 1 : 0;
            this.flags.of = ((rflagsValue >> CPU.FLAG_OF_BIT) & 1n) === 1n ? 1 : 0;
            this.flags.if = ((rflagsValue >> CPU.FLAG_IF_BIT) & 1n) === 1n ? 1 : 0;
        }

        raiseInterrupt(interruptNumber) {
            // In a real system, this would go through an Interrupt Controller (PIC).
            // For now, we'll just queue it. We need a queue in case an interrupt
            // happens while the CPU has interrupts disabled.
            this.interruptQueue.push(interruptNumber);
        }
    }

    exports.CPU = CPU;
    exports.Device = Device;
    exports.IOManager = IOManager;
    exports.Memory = Memory;
    exports.PageFaultException = PageFaultException;
    exports.getMode = getMode;
    exports.log = log;
    exports.setMode = setMode;

}));
//# sourceMappingURL=emcpu.umd.js.map
