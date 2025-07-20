bits 64
org 0x7C00

_start:
    ; --- Minimal Long Mode Setup ---
    ; These instructions are essential and already handled by the emulator.
    ; They establish the 64-bit execution environment with paging.

    ; Setup EFER MSR (0xC0000080) for Long Mode Enable (LME=1)
    mov rax, 0xC0000080
    mov rcx, rax
    mov rax, 0x101
    xor rdx, rdx
    wrmsr

    ; Enable paging (CR0.PG=1, PE=1)
    mov rax, 0x80000001
    mov cr0, rax

    ; Enable PAE in CR4
    mov rax, 0x20
    mov cr4, rax

    ; --- End Long Mode Setup ---

    ; Setup stack
    mov rsp, 0x7B00
    mov rbp, rsp
    ; --- End Setup Stack ---

    mov rax, 0x00
    mov rbx, 0x00
    mov rcx, 0x00
    mov rdx, 0x00
    call _main

    ; --- End ---
    nop
    hlt

_main:
    jmp _loop

    mov rax, 0x0
    mov rbx, 0x1
    mov rcx, 0x7
    _loop:
        add rax, rbx
        cmp rax, rcx
        jne _loop

    _exit:
        ret

times 510-($-$$) db 0
dw 0xAA55
