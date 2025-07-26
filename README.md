# EmCPU - x86-64 CPU Emulator in JavaScript

A pure JavaScript implementation of an x86-64 CPU emulator with support for protected mode, paging, and basic instruction execution. This project aims to provide an educational tool for understanding low-level computer architecture and CPU emulation.

## Features

- 64-bit x86-64 CPU emulation
- Protected mode support
- Paging and memory management
- Basic instruction set implementation
- Boot sector loading and execution
- Memory management unit (MMU) with paging support

## Project Structure

- `index.js` - Main entry point and emulator loop
- `cpu.js` - CPU emulation core
- `memory.js` - Memory management and access
- `bootsector.asm` - Example boot sector assembly code
- `build.bat` - Script to assemble the boot sector

## Prerequisites

- Node.js (v14 or later)
- NASM (for assembling boot sector)

## Getting Started

1. Clone the repository:
   ```bash
   git clone https://github.com/dev-kas/emcpu.git
   cd emcpu
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the boot sector (requires NASM):
   ```bash
   .\build.bat
   ```

4. Run the emulator:
   ```bash
   npm start
   ```

## Building the Boot Sector

The boot sector can be assembled using NASM:

```bash
nasm -f bin -o bootsector.bin bootsector.asm
```

Or by using the provided build script:

```bash
.\build.bat
```

## Implementation Details

### CPU Emulation

The CPU emulator supports:
- 64-bit general purpose registers
- Basic arithmetic and logic operations
- Memory access instructions
- Control flow instructions
- Paging and memory protection

### Memory Management

- 64MB of emulated RAM
- Memory-mapped I/O support
- Paging with 4KB pages
- Identity mapping for boot sector execution

## License

This project is licensed under the AGPL-3.0-only License - see the [LICENSE](LICENSE) file for details.

## Contributing

Contributions are welcome! Please feel free to submit pull requests or open issues.
