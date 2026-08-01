package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

type stagedFile struct {
	source      string
	destination string
}

func main() {
	repository := flag.String("repository", ".", "RenCrow_PORTAL repository root")
	destination := flag.String("destination", "build", "release layout directory")
	flag.Parse()

	files := []stagedFile{
		{source: "LICENSE", destination: "LICENSE"},
		{source: "THIRD_PARTY_NOTICES.md", destination: "THIRD_PARTY_NOTICES.md"},
		{
			source:      filepath.Join("internal", "portal", "web", "purupuru", "LICENSE"),
			destination: filepath.Join("licenses", "PuruPuruPNGTuber-Apache-2.0.txt"),
		},
	}
	for _, file := range files {
		if err := copyFile(
			filepath.Join(*repository, file.source),
			filepath.Join(*destination, file.destination),
		); err != nil {
			fmt.Fprintf(os.Stderr, "stage %s: %v\n", file.destination, err)
			os.Exit(1)
		}
	}
}

func copyFile(source, destination string) error {
	sourceInfo, err := os.Stat(source)
	if err != nil {
		return err
	}
	if destinationInfo, statErr := os.Stat(destination); statErr == nil && os.SameFile(sourceInfo, destinationInfo) {
		return nil
	} else if statErr != nil && !os.IsNotExist(statErr) {
		return statErr
	}

	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()

	if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
		return err
	}
	output, err := os.Create(destination)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(output, input)
	closeErr := output.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}
