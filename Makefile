.PHONY: build test vet fmt check clean

BINARY_NAME=rencrow-portal
BUILD_DIR=build
CMD_DIR=cmd/rencrow-portal

build:
	@mkdir -p $(BUILD_DIR)
	@go build -o $(BUILD_DIR)/$(BINARY_NAME) ./$(CMD_DIR)

test:
	@go test ./...

vet:
	@go vet ./...

fmt:
	@gofmt -w $$(find . -name '*.go' -not -path './.git/*')

check: test vet build

clean:
	@rm -rf $(BUILD_DIR)
