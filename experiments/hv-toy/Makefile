SDKROOT := $(shell xcrun --sdk macosx --show-sdk-path)
CC := xcrun --sdk macosx clang
CFLAGS := -std=c17 -Wall -Wextra -Wpedantic -O2 -g -isysroot $(SDKROOT)
LDFLAGS := -framework Hypervisor

.PHONY: all run clean

all: hv-min

hv-min: hv-min.c
	$(CC) $(CFLAGS) $< -o $@ $(LDFLAGS)
	codesign --force --sign - --entitlements hv-toy.entitlements $@

run: hv-min
	./hv-min

clean:
	rm -f hv-min
