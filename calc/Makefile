CXX      ?= g++
CXXFLAGS ?= -std=c++17 -O2 -Wall -Wextra
LDFLAGS  ?=

# Link statically when the toolchain supports it, otherwise fall back to a
# normal dynamic link.
STATIC_OK := $(shell echo 'int main(){return 0;}' | $(CXX) -x c++ - -static -o .static-probe.out >/dev/null 2>&1 && echo yes; rm -f .static-probe.out)
ifeq ($(STATIC_OK),yes)
  LDFLAGS += -static
endif

all: ntg-calc

ntg-calc: calc.cpp
	$(CXX) $(CXXFLAGS) $(LDFLAGS) -o $@ calc.cpp

test: ntg-calc
	./test.sh

clean:
	rm -f ntg-calc .static-probe.out

.PHONY: all test clean
