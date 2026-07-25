.PHONY: build install install-service test vet fmt check clean

BINARY_NAME=rencrow-portal
BUILD_DIR=build
CMD_DIR=cmd/rencrow-portal
PREFIX?=$(HOME)/.local
SYSTEMD_USER_DIR?=$(HOME)/.config/systemd/user

build:
	@mkdir -p $(BUILD_DIR)
	@go build -o $(BUILD_DIR)/$(BINARY_NAME) ./$(CMD_DIR)

install: build
	@install -d $(PREFIX)/bin
	@install -m 0755 $(BUILD_DIR)/$(BINARY_NAME) $(PREFIX)/bin/$(BINARY_NAME)

install-service: install
	@install -d $(SYSTEMD_USER_DIR)
	@install -m 0644 systemd/user/rencrow-portal.service $(SYSTEMD_USER_DIR)/rencrow-portal.service
	@systemctl --user daemon-reload

test:
	@go test ./...

vet:
	@go vet ./...

fmt:
	@gofmt -w $$(find . -name '*.go' -not -path './.git/*')

check: test vet build

clean:
	@rm -rf $(BUILD_DIR)
