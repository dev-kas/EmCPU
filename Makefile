build:
	nasm -f bin boot/boot.asm -o out/boot.bin

.PHONY: build

run:
	npm start
.PHONY: run
