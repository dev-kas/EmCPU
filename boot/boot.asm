bits 64
org 0x7C00

_start:
    mov rsp, 0x200000
    mov rsi, prompt_message
    call print ; Print the "Enter text:" prompt

.main_loop:
    ; Wait for a key to be pressed
    .wait_for_key:
        in al, 0x64     ; Read keyboard status port
        test al, 1      ; Is bit 0 set (output buffer full)?
        jz .wait_for_key ; If not, loop and wait again

    ; A key is ready, read it
    in al, 0x60         ; Read the key scancode (or ASCII in our case)
    
    ; Echo the character back to the serial port
    push rax            ; Save the character
    mov rsi, echo_prefix
    call print
    pop rax             ; Restore the character
    
    mov rsi, temp_char  ; Point RSI to a temporary buffer
    mov [rsi], al       ; Store the character there
    call print          ; Print the single character

    jmp .main_loop      ; Go back and wait for the next key

; --- Reusable Print Function ---
print:
    push rax
    push rdx
    push rsi
    mov dx, 0x3F8
    .loop:
        lodsb
        cmp al, 0
        je .done
        out dx, al
        jmp .loop
    .done:
        pop rsi
        pop rdx
        pop rax
        ret

; --- Data ---
prompt_message:
    db "Keyboard is active. Type something!", 0x0A, 0
echo_prefix:
    db 0x0A, "You typed: ", 0
temp_char:
    db 0, 0 ; Buffer for a single character + null terminator

times 510-($-$$) db 0
dw 0xAA55