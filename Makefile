.PHONY: build stage-release-licenses install install-service test vet fmt check clean

BINARY_NAME=rencrow-portal
BUILD_DIR=build
CMD_DIR=cmd/rencrow-portal
PREFIX?=$(HOME)/.local
SYSTEMD_USER_DIR?=$(HOME)/.config/systemd/user
CONFIG_DIR?=$(HOME)/.rencrow/config

build:
	@mkdir -p $(BUILD_DIR)
	@go build -o $(BUILD_DIR)/$(BINARY_NAME) ./$(CMD_DIR)
	@go run ./cmd/stage-release-licenses -destination $(BUILD_DIR)

stage-release-licenses:
	@go run ./cmd/stage-release-licenses -destination $(BUILD_DIR)

install: build
	@install -d $(PREFIX)/bin
	@install -m 0755 $(BUILD_DIR)/$(BINARY_NAME) $(PREFIX)/bin/$(BINARY_NAME)

install-service: install
	@install -d $(SYSTEMD_USER_DIR) $(CONFIG_DIR)
	@if [ ! -f $(CONFIG_DIR)/portal.json ]; then install -m 0600 portal.example.json $(CONFIG_DIR)/portal.json; fi
	@install -m 0644 systemd/user/rencrow-portal.service $(SYSTEMD_USER_DIR)/rencrow-portal.service
	@systemctl --user daemon-reload

test:
ifeq ($(OS),Windows_NT)
	@powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-local.ps1
else
	@go test ./...
endif

vet:
	@go vet ./...

fmt:
	@gofmt -w $$(find . -name '*.go' -not -path './.git/*')

check: test vet build

clean:
	@rm -rf $(BUILD_DIR)
