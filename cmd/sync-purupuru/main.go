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
	source := flag.String("source", "../PuruPuruPNGTuber", "PuruPuruPNGTuber checkout")
	destination := flag.String("destination", "internal/portal/web/purupuru", "generated runtime destination")
	character := flag.String("character", "", "extract only this character (comma-separated); empty syncs all")
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
	var selected []string
	for _, value := range strings.Split(*character, ",") {
		if value = strings.TrimSpace(value); value != "" {
			selected = append(selected, value)
		}
	}
	manifest, err := purupurusync.SyncSelected(absSource, absDestination, commit, selected)
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
