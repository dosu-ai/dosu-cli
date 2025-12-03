BINARY_NAME=dosu
BUILD_DIR=bin
CMD_DIR=cmd/dosu-cli

.PHONY: build run clean fmt lint test install help

build:
	go build -o $(BUILD_DIR)/$(BINARY_NAME) ./$(CMD_DIR)

run: build
	$(BUILD_DIR)/$(BINARY_NAME)

run-dev: build
	DOSU_DEV=true $(BUILD_DIR)/$(BINARY_NAME)

clean:
	rm -rf $(BUILD_DIR)
	go clean

fmt:
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
	@echo "  make fmt      - Format code"
	@echo "  make lint     - Run go vet"
	@echo "  make test     - Run tests"
	@echo "  make install  - Install binary to GOPATH/bin"
	@echo "  make deps     - Tidy and download dependencies"
