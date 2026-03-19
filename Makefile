BINARY_NAME=dosu
BUILD_DIR=bin
CMD_DIR=cmd/dosu-cli
VERSION ?= $(shell git describe --tags 2>/dev/null || echo "dev")
COMMIT  ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo "none")
DATE    ?= $(shell date -u '+%Y-%m-%dT%H:%M:%SZ')
LDFLAGS  = -s -w -X github.com/dosu-ai/dosu-cli/internal/version.Version=$(VERSION) -X github.com/dosu-ai/dosu-cli/internal/version.Commit=$(COMMIT) -X github.com/dosu-ai/dosu-cli/internal/version.Date=$(DATE)

.PHONY: build run clean format lint test install help

build:
	go build -ldflags "$(LDFLAGS)" -o $(BUILD_DIR)/$(BINARY_NAME) ./$(CMD_DIR)

run: build
	$(BUILD_DIR)/$(BINARY_NAME)

run-dev: build
	DOSU_DEV=true $(BUILD_DIR)/$(BINARY_NAME)

clean:
	rm -rf $(BUILD_DIR)
	go clean

format:
	go fmt ./...

lint:
	go vet ./...

test:
	go test ./...

install: build
	cp $(BUILD_DIR)/$(BINARY_NAME) $(GOPATH)/bin/$(BINARY_NAME)

deps:
	go mod tidy
	go mod download

help:
	@echo "Available commands:"
	@echo "  make build    - Build the binary"
	@echo "  make run      - Build and run"
	@echo "  make run-dev  - Build and run with DOSU_DEV=true"
	@echo "  make clean    - Remove build artifacts"
	@echo "  make format   - Format code"
	@echo "  make lint     - Run go vet"
	@echo "  make test     - Run tests"
	@echo "  make install  - Install binary to GOPATH/bin"
	@echo "  make deps     - Tidy and download dependencies"
