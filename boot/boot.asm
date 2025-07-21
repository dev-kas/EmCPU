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
    ; --- SHL Test ---
    ; Start with the number 13 (0b1101)
    mov rax, 13
    
    ; Shift left by 3 bits.
    ; 13 * (2^3) = 13 * 8 = 104
    ; Binary: 0b1101 -> 0b1101000
    ; Hex: 0x68
    shl rax, 3
    
    ; --- Verification ---
    ; Check if RAX now holds the correct value, 104.
    cmp rax, 104
    je .success

.failure:
    mov rcx, 0xDEADBEEF  ; Indicate failure
    jmp .end

.success:
    mov rcx, 0xCAFEBABE  ; Indicate pass
    
.end:
    ret

times 510-($-$$) db 0
dw 0xAA55

; How to Confirm It Works:
;     Your `SHL` implementation must correctly read the immediate value (`3`) and
;     perform the bitwise shift on the value in `RAX`. The result should be written back to `RAX`.
;     The final comparison will pass if the math is correct, setting `RCX` to `0xCAFEBABE`.