bits 64
org 0x7C00

_start:
    ; --- Minimal Long Mode Setup ---
    mov rax, 0xC0000080
    mov rcx, rax
    mov rax, 0x101
    xor rdx, rdx
    wrmsr
    mov rax, 0x80000001
    mov cr0, rax
    mov rax, 0x20
    mov cr4, rax

    mov rsp, 0x7c00
    mov rbp, rsp

    ; --- Run Test ---
    call _main
    hlt

_main:
    ; --- CMP with a LARGE Immediate Test ---
    ; This number is too large to be encoded in a single byte,
    ; so the assembler MUST use the 0x3D opcode.
    
    mov rax, 0x12345678
    cmp rax, 0x12345678  ; This will generate opcode 0x3D
    
    ; If the comparison works, ZF will be 1 and JE will be taken.
    je .success
    
.failure:
    mov rcx, 0xDEADBEEF
    jmp .end

.success:
    mov rcx, 0xCAFEBABE
    
.end:
    ret

times 510-($-$$) db 0
dw 0xAA55