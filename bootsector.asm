bits 64

; Boot sector code that matches the binary instructions from index.js
; This code will be loaded at 0x7C00 and run in long mode

_start:
    ; Initialize registers with test values
    mov al, 0xAA          ; RAX becomes 0x...AA
    mov ecx, 0xDEADBEEF   ; RCX becomes 0x...DEADBEEF
    
    ; Test register moves
    mov rcx, rax          ; RCX = 0x200AA (from previous RAX value)
    mov rdx, r8           ; RDX = 0x10000 (from R8)

    ; Test memory access
    mov rdi, [r8 + 0x20]  ; RDI = [0x10020] = 0xAABBCCDDEEFF0011
    mov [rcx + 0x100], rdx ; [0x201AA] = 0x10000

    ; Enable Long Mode Paging
    ; Set up EFER MSR (0xC0000080)
    mov rax, 0xC0000080  ; EFER MSR address
    mov rcx, rax
    mov rax, 0x101       ; EFER value (LME=1, SCE=1)
    xor rdx, rdx         ; Upper 32 bits of EFER (0x31 D2)
    wrmsr

    ; Enable paging (set CR0.PG=1, PE=1)
    mov rax, 0x80000001  ; CR0.PG=1, CR0.PE=1
    mov cr0, rax

    ; Set PAE bit in CR4
    mov rdi, 0x20        ; CR4.PAE=1
    mov cr4, rdi

    ; --- NEW ARITHMETIC/LOGIC INSTRUCTIONS ---
    ; CPU is in Long Mode with Paging from this point (~0x7C3A)

    ; Test 1: ADD RAX, RBX (Positive, No Overflow)
    ; RAX = 5, RBX = 3 => RAX = 8. Flags: ZF=0, SF=0, CF=0, OF=0
    mov rax, 0x5
    mov rbx, 0x3
    add rax, rbx ; RAX = 8

    ; Test 2: SUB RCX, RDX (RCX = -1 (32-bit), RDX = 1 (32-bit) => RCX = -2)
    ; RCX=0xFFFFFFFF (as 32-bit value, in 64-bit register it's 0x...FFFFFFFF)
    ; RDX=0x1
    ; SUB RCX, RDX => 0xFFFFFFFE (as 32-bit value)
    ; Flags (for 32-bit subtraction): ZF=0, SF=1, CF=1, OF=0
    mov ecx, 0xFFFFFFFF 
    mov edx, 0x1        
    sub ecx, edx        ; ECX = 0xFFFFFFFE

    ; Test 3: ADD RAX, RBX (Signed Overflow)
    ; RAX = 0x7FFFFFFF_FFFFFFFF (Max positive 64-bit signed)
    ; RBX = 0x1
    ; ADD RAX, RBX => 0x80000000_00000000 (Min negative 64-bit signed)
    ; Flags (for 64-bit add): ZF=0, SF=1, CF=0, OF=1
    mov rax, 0x7FFFFFFFFFFFFFFF
    mov rbx, 0x1
    add rax, rbx ; RAX = 0x8000000000000000

    ; Test 4: SUB RDI, R8 (Signed Underflow)
    ; RDI = 0x80000000_00000000 (Min negative 64-bit signed)
    ; R8 = 0x1
    ; SUB RDI, R8 => 0x7FFFFFFF_FFFFFFFF (Max positive 64-bit signed, overflows)
    ; Flags (for 64-bit sub): ZF=0, SF=0, CF=1, OF=1
    mov rdi, 0x8000000000000000 ; Make sure RDI has this value, not previous 0xAABB...
    mov r8, 0x1
    sub rdi, r8 ; RDI = 0x7FFFFFFFFFFFFFFF

    ; Test 5: AND RAX, RBX
    ; RAX = 0xF0F0, RBX = 0x0F0F => RAX = 0x0000. Flags: ZF=1, SF=0, CF=0, OF=0
    mov ax, 0xF0F0
    mov bx, 0x0F0F
    and ax, bx ; AX = 0x0000

    ; Test 6: OR RCX, RDX
    ; RCX = 0x11223344, RDX = 0x55667788 => RCX = 0x55667788
    ; Flags: ZF=0, SF=0, CF=0, OF=0
    mov ecx, 0x11223344
    mov edx, 0x55667788
    or ecx, edx ; ECX = 0x55667788 | 0x11223344 = 0x55667788

    ; Test 7: CMP RAX, RBX (RAX = 10, RBX = 10)
    ; RAX = 10, RBX = 10. Flags based on 10 - 10 = 0: ZF=1, SF=0, CF=0, OF=0
    mov rax, 0xA
    mov rbx, 0xA
    cmp rax, rbx ; Flags set for (0xA - 0xA = 0)

    ; Test 8: CMP RDX, R8 (RDX = 20, R8 = 10)
    ; RDX = 20, R8 = 10. Flags based on 20 - 10 = 10: ZF=0, SF=0, CF=0, OF=0
    mov rdx, 0x14
    mov r8, 0xA
    cmp rdx, r8 ; Flags set for (0x14 - 0xA = 0xA)

    ; Test 9: CMP RDI, R8 (RDI = 10, R8 = 20)
    ; RDI = 10, R8 = 20. Flags based on 10 - 20 = -10 (0xFF...F6 for 64-bit): ZF=0, SF=1, CF=1, OF=0
    mov rdi, 0xA
    mov r8, 0x14
    cmp rdi, r8 ; Flags set for (0xA - 0x14 = -0xA)

    nop ; To ensure final RIP translation and instruction fetch
    hlt

; Boot sector padding and signature
times 510-($-$$) db 0
dw 0xAA55