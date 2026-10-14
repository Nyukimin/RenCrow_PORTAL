package main

import (
	"flag"
	"fmt"
	"log"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/Nyukimin/RenCrow_PORTAL/internal/purupurusync"
)

func main() {
	source := flag.String("source", "internal/portal/web/purupuru", "PuruPuruPNGTuber checkout")
	destination := flag.String("destination", "internal/portal/web/purupuru", "generated runtime destination")
	character := flag.String("character", "", "extract only this character (comma-separated); empty syncs all")
	packages := flag.String("packages", "avatar-packages", "durable package root; empty uses source/assets")
	sourceCommit := flag.String("source-commit", "9dc1e735155faae8f54f9ee3076b52db7da36624", "upstream provenance commit override")
	flag.Parse()

	absSource, err := filepath.Abs(*source)
	if err != nil {
		log.Fatal(err)
	}
	absDestination, err := filepath.Abs(*destination)
	if err != nil {
		log.Fatal(err)
	}
	commit := strings.TrimSpace(gitOutput(absSource, "rev-parse", "HEAD"))
	if *sourceCommit != "" {
		commit = *sourceCommit
	}
	packageRoot := filepath.Join(absSource, "assets")
	if *packages != "" {
		packageRoot, err = filepath.Abs(*packages)
		if err != nil {
			log.Fatal(err)
		}
	}
	var selected []string
	for _, value := range strings.Split(*character, ",") {
		if value = strings.TrimSpace(value); value != "" {
			selected = append(selected, value)
		}
	}
	manifest, err := purupurusync.SyncSelectedWithPackages(absSource, packageRoot, absDestination, commit, selected)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("synced PuruPuru %s (%d files)\n", manifest.SourceCommit, len(manifest.Files))
}

func gitOutput(directory string, args ...string) string {
	command := exec.Command("git", append([]string{"-C", directory}, args...)...)
	output, err := command.Output()
	if err != nil {
		return "unknown"
	}
	return string(output)
}
